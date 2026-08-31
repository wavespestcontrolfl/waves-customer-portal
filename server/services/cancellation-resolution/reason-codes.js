'use strict';

/**
 * Cancellation reason taxonomy v2 (owner rulings 2026-08-30, rebuttals scope
 * §8 R1/R2). Nineteen stable internal codes; customer wording varies by
 * service family and lives with the UI, never here.
 *
 * hardStop = the cancellation completes with NO retention card, ever.
 * reviewType names the office task that opens alongside the cancel:
 *   billing    → a charge dispute / surprise charge to review
 *   incident   → damage, adverse exposure, conduct/entry/safety complaint
 *   disclosure → "I thought this was one-time" — a sign-up disclosure gap
 *   none       → nothing to review (personal circumstances)
 *
 * Three further hard stops are situational, not code-level, and are decided
 * in resolve.js from the case context: a specific health/pet exposure EVENT
 * under health_or_chemicals, a conduct/entry/safety complaint under
 * service_experience, and a verified out-of-area move under
 * moving_or_property_change.
 *
 * REASON_CODE_VERSION stamps every cancellation_cases row so reporting can
 * tell v2 rows from anything that follows. The CHECK constraint in migration
 * 20260830000040 mirrors REASON_CODES — keep them in lockstep.
 */

const REASON_CODE_VERSION = 2;

const REASON_CODES = Object.freeze([
  { code: 'price', hardStop: false, reviewType: null },
  { code: 'results_pest', hardStop: false, reviewType: null },
  { code: 'results_lawn', hardStop: false, reviewType: null },
  { code: 'service_experience', hardStop: false, reviewType: null },
  { code: 'away', hardStop: false, reviewType: null },
  { code: 'scheduling_access_communication', hardStop: false, reviewType: null },
  { code: 'moving_or_property_change', hardStop: false, reviewType: null },
  { code: 'no_longer_needed', hardStop: false, reviewType: null },
  { code: 'service_mix', hardStop: false, reviewType: null },
  { code: 'diy', hardStop: false, reviewType: null },
  { code: 'competitor', hardStop: false, reviewType: null },
  { code: 'hoa_or_landlord', hardStop: false, reviewType: null },
  { code: 'financial_hardship', hardStop: false, reviewType: null },
  { code: 'health_or_chemicals', hardStop: false, reviewType: null },
  { code: 'billing_issue', hardStop: true, reviewType: 'billing' },
  { code: 'unexpected_recurring', hardStop: true, reviewType: 'disclosure' },
  { code: 'damage_or_adverse_effect', hardStop: true, reviewType: 'incident' },
  { code: 'personal_circumstances', hardStop: true, reviewType: 'none' },
  { code: 'other', hardStop: false, reviewType: null },
]);

const REASON_CODE_VALUES = Object.freeze(REASON_CODES.map((r) => r.code));
const REVIEW_TYPES = Object.freeze(['billing', 'incident', 'disclosure', 'none']);
const BY_CODE = new Map(REASON_CODES.map((r) => [r.code, r]));

function isReasonCode(value) {
  return BY_CODE.has(String(value || ''));
}

function reasonCodeMeta(code) {
  return BY_CODE.get(String(code || '')) || null;
}

module.exports = {
  REASON_CODE_VERSION,
  REASON_CODES,
  REASON_CODE_VALUES,
  REVIEW_TYPES,
  isReasonCode,
  reasonCodeMeta,
};
