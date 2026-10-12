/** Shared interpretation of domain outcomes for execution, cards, and recall. */
function isToolFailure(result) {
  return !!(result && typeof result === 'object'
    && (result.error || result.failed === true || result.success === false || result.blocked === true));
}

// Codes that name a real fault (the outcome of a write is unknown, a safety
// check could not run), not a decision the tool made about the ask.
const FAULT_CODES = new Set(['execution_interrupted', 'verify_failed']);

/**
 * A tool declined on purpose: a scope, target, permission or capability
 * decision, not a broken system. Shapes the Intelligence Bar tools use:
 *   { error, code: 'target_clarification_required' | 'permission_denied' | ... }
 *   { error, code, blocked: true | preview_changed: true }   (a failure WITH a code)
 *   { refused: '<reason>' }  /  { refusal: { error, code } }  (an explicit marker)
 * A failure with no code, a thrown error, a timeout, an unknown write outcome
 * and the breaker's own circuit_open result are faults, never refusals.
 */
function isPolicyRefusal(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.outcome_unknown === true || result.error === 'circuit_open') return false;
  if (result.refused || result.refusal) return true;
  const code = typeof result.code === 'string' ? result.code.trim() : '';
  return isToolFailure(result) && Boolean(code) && !FAULT_CODES.has(code);
}

/**
 * Circuit-breaker accounting for one executed tool result. Only real faults
 * count: a refusal neither adds a failure nor resets the count as a success.
 */
function recordToolOutcome(breaker, result) {
  if (isPolicyRefusal(result)) return 'refusal';
  if (isToolFailure(result)) {
    breaker.recordFailure();
    return 'failure';
  }
  breaker.recordSuccess();
  return 'success';
}

// Absence of an error is not evidence that a write ran. In particular a
// consumed approval with no durable result must remain unknown on recovery.
function executionOutcome(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) {
    return 'outcome_unknown';
  }
  if (result.outcome_unknown === true) return 'outcome_unknown';
  if (result.pending_confirmation === true || result.preview === true || result.proposal === true || result.dry_run === true) return 'awaiting_approval';
  if (result.blocked === true) return 'blocked';
  if (isToolFailure(result)) return 'failed';
  if (result.partial === true) return 'partially_completed';
  if (result.state === 'provider_accepted') return 'provider_accepted';
  if (result.success === true) return result.warning ? 'partially_completed' : 'completed';
  return 'outcome_unknown';
}

module.exports = { isToolFailure, isPolicyRefusal, recordToolOutcome, executionOutcome };
