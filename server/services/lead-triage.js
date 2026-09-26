const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatch, rejectCall } = require('./llm/call');
const { stripThinkingBlocks } = require('./llm/deep');
const { ledgerCall, ledgerCallRejected } = require('./llm-dispatch-metrics');

// Structured-output contract for the live (dispatcher) leg. The direct-SDK
// Claude fallback below has no schema path, so the prompt keeps its field
// list and mapTriage still defaults every field for both legs.
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['serviceInterest', 'urgency', 'extractedData', 'suggestedReply'],
  properties: {
    serviceInterest: { type: 'string', description: 'The primary service they need, e.g. "General Pest Control", "Lawn Care", "Termite Inspection", "Mosquito Treatment", "Rodent Exclusion"' },
    urgency: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
    extractedData: {
      type: 'object',
      additionalProperties: false,
      required: ['pestType', 'location', 'propertyType'],
      properties: {
        pestType: { type: ['string', 'null'], description: 'Specific pest mentioned, e.g. "ants", "roaches", "rats", "mosquitoes", or null' },
        location: { type: ['string', 'null'], description: 'Area/neighborhood if identifiable from address or message, or null' },
        propertyType: { type: ['string', 'null'], description: '"residential", "commercial", or null' },
      },
    },
    suggestedReply: { type: 'string', description: 'A warm, personalized SMS reply under 300 characters signed "Adam, Waves Pest Control"' },
  },
};

// TRIAGE_SCHEMA's own types — the Claude fallback is not schema-constrained
// the way the structured-output leg is, so its answer is checked here.
const strOrNull = (v) => v === null || typeof v === 'string';
// serviceInterest and suggestedReply are the answer: mapTriage turns a blank
// one into null, leaving the lead with no classification or reply while the
// row read success (Codex r16 on #4884) — so they must be non-blank.
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';
function triageMatchesSchema(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  const x = t.extractedData;
  // serviceInterest is written to leads.service_interest varchar(255); a
  // longer one failed the async lead update after acceptance (Codex r20).
  return nonBlank(t.serviceInterest) && t.serviceInterest.trim().length <= 255
    && TRIAGE_SCHEMA.properties.urgency.enum.includes(t.urgency)
    && nonBlank(t.suggestedReply)
    && !!x && typeof x === 'object' && !Array.isArray(x)
    && strOrNull(x.pestType) && strOrNull(x.location) && strOrNull(x.propertyType);
}

function mapTriage(parsed) {
  return {
    serviceInterest: parsed.serviceInterest || null,
    urgency: parsed.urgency || 'normal',
    extractedData: parsed.extractedData || {},
    suggestedReply: parsed.suggestedReply || null,
  };
}

/**
 * AI-powered lead triage. Live model = GPT-5.5 (MODELS.ROUTES.leadClassify); on any
 * miss it falls back to Claude (FLAGSHIP) so there is never a gap.
 * Extracts service interest, urgency, pest details, and generates a suggested SMS reply.
 */
async function aiTriageLead({ name, phone, message, address, pageUrl, formName }) {
  if (!message) return null;

  const prompt = `You are a lead triage assistant for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

Analyze this incoming lead and extract structured data:

Lead Name: ${name || 'Unknown'}
Phone: ${phone || 'N/A'}
Message/Form Data: ${message}
Address: ${address || 'Not provided'}
Page URL: ${pageUrl || 'N/A'}
Form: ${formName || 'N/A'}

Return a JSON object with:
1. "serviceInterest" — the primary service they need (e.g. "General Pest Control", "Lawn Care", "Termite Inspection", "Mosquito Treatment", "Rodent Exclusion")
2. "urgency" — one of: "urgent", "high", "normal", "low"
3. "extractedData" — object with:
   - "pestType" — specific pest mentioned if any (e.g. "ants", "roaches", "rats", "mosquitoes") or null
   - "location" — area/neighborhood if identifiable from address or message, or null
   - "propertyType" — "residential" or "commercial" or null
4. "suggestedReply" — a warm, personalized SMS reply (under 300 chars) signed "Adam, Waves Pest Control". Reference their specific concern. Be friendly and professional.

Return ONLY valid JSON, no markdown.`;

  // Live model — GPT-5.5. On any miss, fall through to Claude below (never a gap).
  {
    const r = await dispatch(MODELS.ROUTES.leadClassify, { laneId: 'lead_triage', text: prompt, jsonMode: true, jsonSchema: TRIAGE_SCHEMA, maxTokens: 300 });
    if (r.ok && r.json) {
      // The structured-output schema cannot forbid blank strings, so the
      // primary gets the same check as the fallback; a miss fails its row
      // and Claude gets a turn.
      if (triageMatchesSchema(r.json)) return mapTriage(r.json);
      rejectCall(r, 'schema_invalid');
    }
  }

  // Fallback — Claude (FLAGSHIP).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const response = await ledgerCall('anthropic', MODELS.FAST, () => client.messages.create({
      model: MODELS.FAST,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }), { laneId: 'lead_triage' });
    // Thinking-block guard: FAST resolves to a model that can lead with a
    // thinking block (no .text). A blind content[0] read returned '', and
    // JSON.parse('') threw straight into the catch below — AI lead triage
    // silently returned null on every lead. See event-ingestion.js.
    const text = stripThinkingBlocks(response).content?.[0]?.text || '';
    let triage;
    try { triage = JSON.parse(text); } catch (err) { ledgerCallRejected(response, 'invalid_json'); throw err; }
    // An off-schema answer (e.g. urgency "critical") is a failed triage, not
    // one to map: its values used to be written onto the lead anyway while
    // only the ledger row said it failed (review on #4884). Same null the
    // caller already handles for any AI failure.
    if (!triageMatchesSchema(triage)) {
      ledgerCallRejected(response, 'schema_invalid');
      return null;
    }
    return mapTriage(triage);
  } catch (err) {
    logger.error(`[lead-triage] AI triage failed: ${err.message}`);
    return null;
  }
}

module.exports = { aiTriageLead };
