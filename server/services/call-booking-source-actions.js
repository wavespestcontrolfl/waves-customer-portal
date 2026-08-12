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

// A PENDING booking requested by the live AI voice agent on an inbound call
// (voice-agent relay-booking.js, dark behind VOICE_RELAY_CONTEXT_ENABLED +
// GATE_VOICE_AI_BOOKING). Same office-review lifecycle as an outbound-review
// booking: the office confirms it before it's real; reminders arm at
// confirm-time; the customer can't self-confirm it first.
const VOICE_AGENT_BOOKING_SOURCE_ACTION = 'voice_agent';

// Pending rows a logged-in customer must NOT see, self-confirm, or self-
// reschedule before the office reviews them.
const DISPATCH_OWNED_PENDING_SOURCE_ACTIONS = [
  CALL_FOLLOWUP_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
];

// Rows whose PENDING state means "awaiting the office's confirm decision":
// day-of transitions and reschedules are blocked until the office confirms,
// and confirmation runs the shared runOutboundReviewConfirmHook side effects
// (arm deferred reminders, close the originating lead, resolve the review
// card, card-on-file funnel). Membership is deliberate: the voice-agent
// booking reuses the outbound-review lifecycle rather than inventing a
// parallel pending state.
const OFFICE_REVIEW_PENDING_SOURCE_ACTIONS = [
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
];

/**
 * THE pending-office-review classifier — the single source of truth for
 * "this row is an AI-created booking still awaiting office review"
 * (outbound-callback bookings AND voice-agent bookings; see
 * OFFICE_REVIEW_PENDING_SOURCE_ACTIONS). Used by BOTH the shared status
 * writer's guard (job-status.js, which blocks day-of transitions on such
 * rows) and the sanctioned confirmation points (tech-track
 * dispatch-implies-confirm) that bypass it — one function so the two
 * mechanisms can never drift (Codex P1 on PR #3356). `svc` needs
 * source_action, status, customer_confirmed.
 */
function isPendingOutboundReviewBooking(svc) {
  return !!svc
    && OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(svc.source_action)
    && svc.status === 'pending'
    && !svc.customer_confirmed;
}

module.exports = {
  CALL_FOLLOWUP_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
  OFFICE_REVIEW_PENDING_SOURCE_ACTIONS,
  isPendingOutboundReviewBooking,
};
