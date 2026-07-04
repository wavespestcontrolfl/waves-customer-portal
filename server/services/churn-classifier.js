/**
 * Churn-reason classifier (Growth Command Center Phase 7) — maps a customer's
 * cancellation text to one code from the CHECK-constrained taxonomy on
 * customers.churn_reason_code.
 *
 * FAIL-CLOSED BY DESIGN: every miss (no text, no key, provider error, junk
 * output, unknown code) returns 'unclassified' — and the caller
 * (cancellation-processor) runs this AFTER the churn/billing wind-down, so a
 * slow or broken model can never block or delay a cancellation.
 *
 * Live model = GPT-5.5 (MODELS.ROUTES.churnClassify); on any miss it falls
 * back to Claude (FLAGSHIP) before failing closed — same pattern as
 * lead-triage. Never hardcode model ids (owner directive).
 */

const MODELS = require('../config/models');
const { dispatch, callAnthropic } = require('./llm/call');
const logger = require('./logger');

// Keep in lockstep with the CHECK constraint in migration
// 20260704180000_customers_churn_taxonomy.js.
const CHURN_REASON_CODES = Object.freeze([
  'price', 'moving', 'service_quality', 'results', 'competitor',
  'seasonal_pause', 'financial', 'no_longer_needed', 'other', 'unclassified',
]);

const SYSTEM = `You classify pest-control/lawn-care customer cancellation messages into exactly one reason code.

Codes:
- price: cost/rate objections, "too expensive", found it cheaper in general terms
- moving: relocating, selling the home, moving out of the service area
- service_quality: missed/late visits, scheduling problems, technician conduct, communication complaints
- results: pests/weeds still present, treatment not working
- competitor: switching to a NAMED or clearly implied other provider
- seasonal_pause: snowbird/seasonal residents pausing, "back in the fall"
- financial: personal hardship — job loss, medical bills, budget cuts (not a price objection)
- no_longer_needed: problem resolved, DIY from now on, service no longer wanted
- other: a clear reason that fits none of the above (death, dispute, property change)
- unclassified: no discernible reason in the text

Respond with JSON only: {"code": "<one code>"}`;

function normalize(code) {
  const c = String(code || '').trim().toLowerCase();
  return CHURN_REASON_CODES.includes(c) ? c : null;
}

/**
 * classifyChurnReason(text) → { code, source: 'live'|'fallback'|'none' }.
 * Never throws.
 */
async function classifyChurnReason(text) {
  const detail = String(text || '').trim();
  // Nothing to classify — the generic request boilerplate carries no signal.
  if (!detail || detail.length < 3) return { code: 'unclassified', source: 'none' };
  const payload = {
    system: SYSTEM,
    text: `Cancellation message:\n"""${detail.slice(0, 1500)}"""`,
    jsonMode: true,
    maxTokens: 100,
  };
  try {
    const live = await dispatch(MODELS.ROUTES.churnClassify, payload);
    const liveCode = live?.ok ? normalize(live.json?.code) : null;
    if (liveCode) return { code: liveCode, source: 'live' };

    // Fallback — Claude (FLAGSHIP), so a provider issue never causes a gap.
    const fb = await callAnthropic({ model: MODELS.FLAGSHIP, ...payload });
    const fbCode = fb?.ok ? normalize(fb.json?.code) : null;
    if (fbCode) return { code: fbCode, source: 'fallback' };
  } catch (err) {
    logger.error(`[churn-classifier] classification failed: ${err.message}`);
  }
  return { code: 'unclassified', source: 'none' };
}

module.exports = { classifyChurnReason, CHURN_REASON_CODES };
