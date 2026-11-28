/**
 * Call estimate auto-send — SHADOW verdict (watch only).
 *
 * Stamps every call-origin draft with "would_send" or "would_hold" inside
 * estimate_data.estimatorEngine.autoSendShadow. Nothing here sends, texts,
 * emails, or changes a price.
 *
 * Owner hold rule (2026-11-23 / 2026-11-27): hold ONLY for:
 *   - already booked on the call (`booked_on_call`)
 *   - termite / WDO work (`termite_hold`)
 *   - commercial work (`commercial_hold`)
 *
 * Delivery channel / TCPA / DNC checks remain in the send path (step 2).
 * Pure: no I/O, no env reads.
 */
const SHADOW_VERSION = 2;

function flagText(intent) {
  const flags = Array.isArray(intent?.constraint_flags) ? intent.constraint_flags : [];
  return flags
    .map((f) => [f?.flag, f?.note].filter((s) => typeof s === 'string').join(' '))
    .join(' | ');
}

function bookedOnCall(extraction) {
  return extraction?.appointment_confirmed === true || extraction?.scheduling?.status === 'confirmed';
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// BOTH original extractions of the call. Only a VALID v2 payload may speak
// (an invalid one is audit data).
function callExtractions(context) {
  const call = context?.call || {};
  const v1 = parseMaybeJson(call.ai_extraction);
  const v2 = call.v2_extraction_status === 'valid' ? parseMaybeJson(call.ai_extraction_enriched) : null;
  return [v1, v2, context?.extraction].filter((x) => x && typeof x === 'object');
}

// Termite or WDO work the call asked for, even when the composed intent
// carries no termite key (WDO has none) and no flag names it. Requested
// scope only: a termite job in the caller's treatment history is not a
// termite request.
function termiteRequested(extractions) {
  return extractions.some((x) => {
    const sr = x.service_request || {};
    const scope = [
      sr.primary_service_category, sr.specific_service_name, sr.primary_category, sr.requested_service,
      ...(Array.isArray(sr.secondary_categories) ? sr.secondary_categories : []),
      x.requested_service, x.matched_service, x.service_interest,
    ].filter((v) => typeof v === 'string');
    return /termite|wdo/i.test(scope.join(' '));
  });
}

// Owner hold rules: { already_booked, termite, commercial }.
const HOLD_RULES = [
  ['booked_on_call', (f) => f.extractions.some(bookedOnCall)],
  ['termite_hold', (f) => f.serviceKeys.some((k) => /termite|wdo/i.test(k)) || /termite|wdo|swarmer/i.test(f.flags)
    || termiteRequested(f.extractions)],
  ['commercial_hold', (f) => f.intent.is_commercial === true || f.intent.category === 'COMMERCIAL'],
];

/**
 * @returns {null | { version: number, verdict: 'would_send'|'would_hold',
 *   reasons: string[], fixes: string[] }} null for a non-call origin.
 */
function callAutoSendShadowVerdict({ origin = null, intent = null, context = null } = {}) {
  if (origin?.channel && origin.channel !== 'call') return null;
  if (!intent || intent.decision !== 'draft') return null;

  const services = intent.services || {};
  const facts = {
    intent,
    serviceKeys: Object.keys(services),
    extractions: callExtractions(context),
    flags: flagText(intent),
  };
  const reasons = HOLD_RULES.filter(([, test]) => test(facts)).map(([reason]) => reason);
  const fixes = services.oneTimePest && !services.pest ? ['add_recurring_pest'] : [];

  return {
    version: SHADOW_VERSION,
    verdict: reasons.length ? 'would_hold' : 'would_send',
    reasons,
    fixes,
  };
}

module.exports = { callAutoSendShadowVerdict, SHADOW_VERSION };
