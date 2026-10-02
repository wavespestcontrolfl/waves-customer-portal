/**
 * The five reasons a person can give when correcting an AI decision (AI
 * acceleration scope idea D, owner 2026-10-01: "keep it to five"). One closed
 * list for every surface: the Agent Review cards write it to
 * agent_decisions.correction_reason, the Typed tab into decision_reviews.label
 * as `reason`, and the corrections view exposes both as `reason`. The
 * migration's CHECK and the client mirror
 * (client/src/constants/correctionReasons.js) are pinned to this list by test.
 */
const CORRECTION_REASONS = ['wrong_fact', 'wrong_tone', 'missing_promise', 'should_have_escalated', 'other'];

const CORRECTION_REASON_LABELS = {
  wrong_fact: 'Wrong fact',
  wrong_tone: 'Wrong tone',
  missing_promise: 'Missing promise',
  should_have_escalated: 'Should have escalated',
  other: 'Other',
};

// Reads an optional reason off a request body: { reason: null } when absent
// or blank, { error } when it is not one of the five.
function readCorrectionReason(value) {
  if (value === undefined || value === null || value === '') return { reason: null };
  const reason = String(value).trim();
  if (!CORRECTION_REASONS.includes(reason)) return { error: `reason must be one of ${CORRECTION_REASONS.join(', ')}` };
  return { reason };
}

module.exports = { CORRECTION_REASONS, CORRECTION_REASON_LABELS, readCorrectionReason };
