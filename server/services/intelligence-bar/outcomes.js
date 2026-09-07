/** Shared interpretation of domain outcomes for execution, cards, and recall. */
function isToolFailure(result) {
  return !!(result && typeof result === 'object'
    && (result.error || result.failed === true || result.success === false || result.blocked === true));
}

// Absence of an error is not evidence that a write ran. In particular a
// consumed approval with no durable result must remain unknown on recovery.
function executionOutcome(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) {
    return 'outcome_unknown';
  }
  if (result.outcome_unknown === true) return 'outcome_unknown';
  if (result.pending_confirmation === true || result.preview === true || result.proposal === true) return 'awaiting_approval';
  if (result.blocked === true) return 'blocked';
  if (isToolFailure(result)) return 'failed';
  if (result.partial === true) return 'partially_completed';
  if (result.state === 'provider_accepted') return 'provider_accepted';
  if (result.warning) return 'partially_completed';
  return 'completed';
}

module.exports = { isToolFailure, executionOutcome };
