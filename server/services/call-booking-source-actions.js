/**
 * source_action markers for call-created scheduled_services, and the set the
 * customer self-service routes must treat as DISPATCH-OWNED — hidden and
 * refused from a logged-in customer's list/confirm/reschedule until the office
 * confirms the exact appointment.
 *
 * Shared so the writer (call-recording-processor) and the readers
 * (routes/schedule.js) can never drift.
 */

// Visit 2 auto-created from a call — pending until the office confirms the time.
const CALL_FOLLOWUP_SOURCE_ACTION = 'ai_call_pipeline_followup';

// A confirmed booking taken on an OUTBOUND callback — created pending/needs
// review (GATE_CALL_OUTBOUND_BOOKING) so the office confirms it (and any
// card/payer) before it's treated as a live, customer-confirmable appointment.
// NOTE: scheduled_services.source_action is varchar(30) — this marker MUST stay
// <= 30 chars or the pending-booking insert fails (value too long).
const CALL_OUTBOUND_REVIEW_SOURCE_ACTION = 'ai_call_outbound_review';

// Pending rows a logged-in customer must NOT see, self-confirm, or self-
// reschedule before the office reviews them.
const DISPATCH_OWNED_PENDING_SOURCE_ACTIONS = [
  CALL_FOLLOWUP_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
];

/**
 * THE pending-outbound-review classifier — the single source of truth for
 * "this row is an outbound-callback booking still awaiting office review".
 * Used by BOTH the shared status writer's guard (job-status.js, which blocks
 * day-of transitions on such rows) and the sanctioned confirmation points
 * (tech-track dispatch-implies-confirm) that bypass it — one function so the
 * two mechanisms can never drift (Codex P1 on PR #3356). `svc` needs
 * source_action, status, customer_confirmed.
 */
function isPendingOutboundReviewBooking(svc) {
  return !!svc
    && svc.source_action === CALL_OUTBOUND_REVIEW_SOURCE_ACTION
    && svc.status === 'pending'
    && !svc.customer_confirmed;
}

module.exports = {
  CALL_FOLLOWUP_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
  isPendingOutboundReviewBooking,
};
