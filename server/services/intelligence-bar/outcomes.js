/** Shared interpretation of domain outcomes for execution, cards, and recall. */
function isToolFailure(result) {
  return !!(result && typeof result === 'object'
    && (result.error || result.failed === true || result.success === false || result.blocked === true));
}

// Codes that name a real fault (the outcome of a write is unknown, a safety
// check could not run), not a decision the tool made about the ask.
const FAULT_CODES = new Set(['execution_interrupted', 'verify_failed']);
// A refusal code is one of the bar's own: lowercase snake_case words
// ("target_clarification_required", "gate_off"). Some executors catch an
// exception and return err.code, so a driver or provider code can arrive in
// the same field: Node's ECONNRESET / ETIMEDOUT, a Postgres SQLSTATE such as
// 08006 or 23505, a provider's "api_connection_error". Those are faults and
// must still trip the breaker.
const REFUSAL_CODE_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;
const FAULT_CODE_WORDS = /(?:^|_)(?:error|errors|timeout|timedout|unavailable|connection|network|unreachable|overloaded|internal|exception|rate_limit|rate_limited|throttled)(?:_|$)/;
// The bar's own refusal codes that contain a fault-looking word.
const KNOWN_REFUSAL_CODES = new Set(['record_unavailable']);
const isRefusalCode = code => KNOWN_REFUSAL_CODES.has(code)
  || (REFUSAL_CODE_SHAPE.test(code) && !FAULT_CODES.has(code) && !FAULT_CODE_WORDS.test(code));

/**
 * A tool declined on purpose: a scope, target, permission or capability
 * decision, not a broken system. Shapes the Intelligence Bar tools use:
 *   { error, code: 'target_clarification_required' | 'permission_denied' | ... }
 *   { error, code, blocked: true | preview_changed: true }   (a failure WITH a code)
 *   { refused: '<reason>' }  /  { refusal: { error, code } }  (an explicit marker)
 * A failure with no code or with a driver / provider code (ECONNRESET, a
 * SQLSTATE, "api_connection_error"), a thrown error, a timeout, an unknown write outcome
 * and the breaker's own circuit_open result are faults, never refusals.
 */
function isPolicyRefusal(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.outcome_unknown === true || result.error === 'circuit_open') return false;
  if (result.refused || result.refusal) return true;
  const code = typeof result.code === 'string' ? result.code.trim() : '';
  return isToolFailure(result) && isRefusalCode(code);
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

// A move that a locked recheck refuses by throwing (package visit 2 present, a
// grouped or frozen visit) is a refusal, not a fault. The services throw an
// UPPER_SNAKE code other callers rely on, which isPolicyRefusal reads as a fault
// (it wants lowercase), with a message that sends the reader to another screen.
// The bar maps the thrown error here into its own lowercase refusal and wording;
// the service's code and text stay as they are.
const THROWN_MOVE_REFUSALS = {
  PACKAGE_CHILD_PRESENT: { code: 'package_visit_two_linked' },
  VISIT_EDIT_SCHEDULE_UNSUPPORTED: {
    code: 'grouped_visit_move_unsupported',
    error: "This appointment is grouped with another service at the same stop, and the bar can't move one of them alone from here yet. Nothing was changed.",
  },
  VISIT_FROZEN_MOVE_UNSUPPORTED: {
    code: 'frozen_visit_move_unsupported',
    error: "This visit already has an issued link, records or a payment in progress, so the bar can't move it from here. Nothing was changed.",
  },
};

// The bar refusal for a thrown move error, or null when it is not one of them.
function moveRefusalFromThrown(err) {
  const mapped = err && THROWN_MOVE_REFUSALS[err.code];
  if (!mapped) return null;
  // A frozen-state check that could not READ the visit fails closed with the
  // same code; that is an outage, not a policy refusal, so it stays a fault.
  if (err.reason === 'unreadable') return null;
  return { error: mapped.error || err.message, code: mapped.code };
}

module.exports = { isToolFailure, isPolicyRefusal, recordToolOutcome, executionOutcome, moveRefusalFromThrown };
