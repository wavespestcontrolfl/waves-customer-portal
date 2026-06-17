const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatch } = require('./llm/call');

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
    const r = await dispatch(MODELS.ROUTES.leadClassify, { text: prompt, jsonMode: true, maxTokens: 300 });
    if (r.ok && r.json) return mapTriage(r.json);
  }

  // Fallback — Claude (FLAGSHIP).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0]?.text || '';
    return mapTriage(JSON.parse(text));
  } catch (err) {
    logger.error(`[lead-triage] AI triage failed: ${err.message}`);
    return null;
  }
}

module.exports = { aiTriageLead };
