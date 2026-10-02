/**
 * The five reasons a person can give when correcting an AI decision (AI
 * acceleration scope idea D, owner 2026-10-01: "keep it to five"). One closed
 * list for every surface: the Agent Review cards write it to
 * agent_decisions.correction_reason, the Typed tab into decision_reviews.label
 * as `reason`, and the corrections view exposes both as `reason`. The client
 * mirror (client/src/constants/correctionReasons.js) owns the display labels;
 * it and the migration's CHECK are pinned to this list by test.
 */
const CORRECTION_REASONS = ['wrong_fact', 'wrong_tone', 'missing_promise', 'should_have_escalated', 'other'];

// Reads an optional reason off a request body: { reason: null } when absent
// or blank, { error } when it is not one of the five.
function readCorrectionReason(value) {
  if (value === undefined || value === null || value === '') return { reason: null };
  const reason = String(value).trim();
  if (!CORRECTION_REASONS.includes(reason)) return { error: `reason must be one of ${CORRECTION_REASONS.join(', ')}` };
  return { reason };
}

module.exports = { CORRECTION_REASONS, readCorrectionReason };
