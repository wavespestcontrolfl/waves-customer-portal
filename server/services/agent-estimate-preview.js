const crypto = require('crypto');

// Engine metadata that legitimately differs between the proposal, the
// /confirm-action preflight, and the confirmed execution runs of
// generateEstimate. Everything else in the result is a pure function of the
// engine inputs, so stripping these keys keeps the digest stable across the
// three runs while still binding every persisted price to the confirmation.
const VOLATILE_ENGINE_KEYS = new Set(['generatedAt']);

function canonicalEngineResult(value) {
  if (Array.isArray(value)) return value.map(canonicalEngineResult);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_ENGINE_KEYS.has(key)) continue;
      out[key] = canonicalEngineResult(value[key]);
    }
    return out;
  }
  return value;
}

function agentEngineResultDigest(engineResult) {
  if (!engineResult || typeof engineResult !== 'object') return null;
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalEngineResult(engineResult)))
    .digest('hex');
}

function agentEstimatePreviewFingerprint(preview = {}) {
  const money = preview.totals || {};
  return JSON.stringify({
    monthly: Number(money.monthly || 0),
    annual: Number(money.annual || 0),
    oneTime: Number(money.oneTime || 0),
    lane: preview.lane || null,
    laneReasons: preview.lane_reasons || [],
    lines: preview.lines || [],
    // The full engine result is persisted and may expose alternate lawn or
    // mosquito cadence/tier prices even when the selected-line aggregates do
    // not change. Bind every customer-selectable price to the confirmation.
    // The proposal and /confirm-action preflight only ever see the safe
    // preview (raw engineResult stripped), so the comparison runs on the
    // canonical digest attached at preview build time — never on the raw
    // result, whose presence differs by stage and whose generatedAt differs
    // by run.
    engineResult: preview.engine_result_digest
      || agentEngineResultDigest(preview.engineResult),
    presentation: preview.presentation || null,
    customerId: preview.customer_account?.customer_id || null,
    customerRecognized: preview.customer_account?.recognized === true,
    currentTier: preview.customer_account?.current_tier || null,
    currentDiscountPct: Number(preview.customer_account?.current_discount_pct || 0),
    existingServiceKeys: preview.customer_account?.existing_service_keys || [],
  });
}

module.exports = { agentEstimatePreviewFingerprint, agentEngineResultDigest };
