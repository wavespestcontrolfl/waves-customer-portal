/**
 * Estimator Engine — intent composer (the only LLM step).
 *
 * Reads the full call context and emits a schema-validated "estimate intent":
 * catalog service selections expressed as pricing-engine inputs, verbatim
 * evidence quotes, and constraint flags. It NEVER outputs a price — the
 * schema has no price fields — and it never resolves sqft (source
 * arbitration owns property facts; the composer only flags disputes).
 *
 * Model: DEEP tier (latency-tolerant, low-volume, highest-stakes lane)
 * through createDeepMessage, which handles fable-5 thinking blocks and the
 * automatic FLAGSHIP retry on refusal. One schema-repair retry, then the
 * caller falls to the red lane.
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { createDeepMessage } = require('../llm/deep');
const {
  validateIntent,
  ALLOWED_SERVICE_KEYS,
  COMMERCIAL_RISK_TYPE_VALUES,
} = require('./intent-schema');

const MAX_TOKENS = 8192;
const CLIENT_TIMEOUT_MS = 180000;

const SYSTEM_PROMPT = `You are the Waves Pest Control estimate-intent composer. You read a phone call (and any SMS thread) between a Waves agent and a caller, plus the caller's profile, and decide WHICH catalog services the caller asked to be quoted — expressed as pricing-engine service selections. A separate deterministic pricing engine computes every price; you never estimate, adjust, or mention dollar amounts.

Output ONLY a single JSON object (no markdown fences, no commentary) matching the contract below.

SERVICE VOCABULARY (the only keys allowed in "services"):
- pest: recurring general pest control. Options: frequency (monthly|bimonthly|quarterly|semiannual — default quarterly; use what was discussed), roachType (none|german|american — set german when German cockroaches are an active problem).
- oneTimePest: single pest treatment, no recurring program.
- lawn: recurring lawn health program. Options: track (st_augustine|bahia|zoysia|bermuda|paspalum — from what the caller says about their grass; default st_augustine when unknown in SW Florida), tier (basic|standard|enhanced|premium — default enhanced).
- oneTimeLawn: one-off lawn treatment. Options: treatmentType (fertilizer|weed).
- lawnPestControl: ONE-TIME lawn insect knockdown (chinch bugs, grubs) — a single treatment, NOT a recurring program. A caller wanting ONGOING lawn insect control belongs on the lawn program (its tiers include insect control); if they explicitly want a recurring insect-only lawn program, skip with reason.
- treeShrub: recurring ornamental tree & shrub care (fertilization, insect, disease).
- mosquito: recurring mosquito program. Options: tier (seasonal9|monthly12).
- oneTimeMosquito: single mosquito treatment (event, one-off).
- termite: termite BAIT/MONITORING program only. Options: system=advance, monitoringTier=basic. Active termite TREATMENT (tenting, liquid treatment) is out of scope — skip with reason.
- flea: flea/tick treatment program.
- bedBug: bed bug treatment. Options: method (CHEMICAL|HEAT), rooms (1-12), severity (light|moderate|severe), prepStatus (ready|needs_prep), occupancyType=residential.
- rodentBait: exterior rodent bait-station program. Rodent TRAPPING/exclusion/remediation is out of scope — skip with reason.
- stinging: wasp/hornet/bee treatment. Options: species (PAPER_WASP|YELLOW_JACKET|HORNET|HONEY_BEE), tier (1-3), removal (NONE|NEST).

COMMERCIAL: set is_commercial=true and category=COMMERCIAL for business properties. Choose commercial_risk_type from: ${COMMERCIAL_RISK_TYPE_VALUES.join(', ')}. Set commercial_subtype (e.g. restaurant, office, warehouse). Commercial pest/lawn/tree/mosquito still use the same service keys — the engine routes them.

WHEN TO SKIP (decision="skip", with skip_reason):
- The requested work maps to no vocabulary key above (WDO/termite inspections for real-estate transactions, rodent trapping/exclusion, aeration/plugging, active termite treatment, bee relocation, one-off wildlife).
- The call is not actually a quote request (wrong number, vendor, existing-service complaint, reschedule).
- You cannot tell what service the caller wants even with the SMS thread and profile.
- Mixed-use or multi-parcel property discussions that need human scoping.
Skipping is the correct, expected output for those — a wrong guessed estimate in front of a customer is worse than no draft.

EVIDENCE (required): for every service you select, and for frequency/commercial decisions, include a verbatim quote from the transcript or SMS thread (speaker: caller or agent) that supports it. Quotes must appear character-for-character in the source text.

CONSTRAINT FLAGS: anything the caller said that the pricing engine cannot express but the operator must know before sending — e.g. interior-only service (landlord covers exterior), access restrictions, competitor pricing mentioned, existing-customer discount expectations, multiple properties. Each flag: { flag: snake_case_key, note: one sentence, quote: verbatim or null }.

CONTACT FIELDS: customer_name / customer_phone / customer_email / address exactly as established on the call or from the profile (prefer spelled-out corrections; use the profile when the call omits them). Do not invent any of them; use null when genuinely absent.

CONFIDENCE: high = service selection, contact info, and address are all unambiguous. medium = minor gaps. low = you selected services but real ambiguity remains (state it in uncertainties).

OUTPUT CONTRACT:
{
  "decision": "draft" | "skip",
  "skip_reason": string | null,
  "customer_name": string | null,
  "customer_phone": string | null,
  "customer_email": string | null,
  "address": string | null,
  "category": "RESIDENTIAL" | "COMMERCIAL",
  "is_commercial": boolean,
  "commercial_risk_type": string | null,
  "commercial_subtype": string | null,
  "services": { <vocabulary keys only> },
  "service_interest_label": string | null,
  "evidence": [{ "decision": string, "quote": string, "speaker": "caller"|"agent" }],
  "constraint_flags": [{ "flag": string, "note": string, "quote": string|null }],
  "uncertainties": [string],
  "confidence": "high" | "medium" | "low"
}`;

function compactExtraction(extraction) {
  if (!extraction) return null;
  // Only the sections that inform service selection — the composer gets the
  // full transcript anyway, and a lean context keeps the prompt stable.
  return {
    caller: extraction.caller || null,
    property: extraction.property || null,
    service_request: extraction.service_request || null,
    customer_history: extraction.customer_history || null,
    commercial_signals: extraction.commercial_signals || null,
    call_nature: extraction.call_nature || null,
  };
}

function buildUserContent(context, propertyFacts) {
  const profile = context.customer
    ? {
      type: context.isExistingCustomer ? 'existing_customer' : 'lead_profile',
      name: `${context.customer.first_name || ''} ${context.customer.last_name || ''}`.trim() || null,
      email: context.customer.email || null,
      address: [context.customer.address_line1, context.customer.city, context.customer.zip].filter(Boolean).join(', ') || null,
      waveguard_tier: context.customer.waveguard_tier || null,
      lawn_type: context.customer.lawn_type || null,
      property_type: context.customer.property_type || null,
      company_name: context.customer.company_name || null,
    }
    : null;

  const lead = context.lead
    ? {
      name: `${context.lead.first_name || ''} ${context.lead.last_name || ''}`.trim() || null,
      email: context.lead.email || null,
      address: [context.lead.address, context.lead.city, context.lead.zip].filter(Boolean).join(', ') || null,
      service_interest: context.lead.service_interest || null,
      is_commercial: context.lead.is_commercial || false,
    }
    : null;

  const sms = (context.smsThread || []).map((m) => `[${m.direction}] ${m.body}`).join('\n');

  const priorEstimates = (context.priorEstimates || []).map((e) => ({
    status: e.status, services: e.service_interest, category: e.category, created_at: e.created_at,
  }));

  return [
    '## CALL TRANSCRIPT',
    context.transcript,
    '',
    '## STRUCTURED EXTRACTION (machine-parsed from this call; may be partial)',
    JSON.stringify(compactExtraction(context.extraction)),
    '',
    '## RESOLVED PROPERTY FACTS (authoritative — do not re-derive; flag disputes only)',
    JSON.stringify({
      home_sqft: propertyFacts?.home?.value || null,
      home_sqft_source: propertyFacts?.home?.source || null,
      lot_sqft: propertyFacts?.lot?.value || null,
      lot_sqft_source: propertyFacts?.lot?.source || null,
      new_construction: propertyFacts?.newConstruction || false,
      tenant: propertyFacts?.tenant || false,
      county_parcel: propertyFacts?.countyParcel || null,
    }),
    '',
    '## CALLER PROFILE',
    JSON.stringify({ caller_id_phone: context.phone || null, customer: profile, lead, prior_estimates: priorEstimates }),
    '',
    '## RECENT SMS THREAD (oldest first; empty if none)',
    sms || '(none)',
  ].join('\n');
}

function parseIntentText(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return JSON.parse(cleaned);
}

async function composeIntent(context, propertyFacts) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: CLIENT_TIMEOUT_MS,
    maxRetries: 1,
  });

  const userContent = buildUserContent(context, propertyFacts);
  const messages = [{ role: 'user', content: userContent }];

  let lastErrors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await createDeepMessage(client, {
      model: process.env.ESTIMATOR_ENGINE_MODEL || MODELS.DEEP,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = (response.content || []).find((b) => b.type === 'text')?.text || '';
    let intent = null;
    try {
      intent = parseIntentText(text);
    } catch (parseErr) {
      lastErrors = [`response was not valid JSON: ${parseErr.message}`];
    }

    if (intent) {
      const { valid, errors } = validateIntent(intent);
      if (valid) {
        logger.info('[estimator-engine] intent composed', {
          model: response.model,
          decision: intent.decision,
          services: Object.keys(intent.services || {}),
          confidence: intent.confidence,
          attempt: attempt + 1,
        });
        return { intent, model: response.model };
      }
      lastErrors = errors;
    }

    // Repair retry: feed the exact validation errors back once.
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `Your response failed schema validation:\n- ${lastErrors.join('\n- ')}\n\nAllowed service keys: ${ALLOWED_SERVICE_KEYS.join(', ')}.\nRespond again with ONLY the corrected JSON object.`,
    });
  }

  return { intent: null, errors: lastErrors };
}

module.exports = { composeIntent, _private: { buildUserContent, parseIntentText, SYSTEM_PROMPT } };
