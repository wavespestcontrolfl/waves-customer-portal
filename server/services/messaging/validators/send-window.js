/**
 * check_send_window — blocks automated customer/lead SMS outside the
 * 8:00 AM–8:00 PM ET send window (owner ruling 2026-08-07; see
 * ../send-window.js for the incident and boundary rationale).
 *
 * Exemptions, deliberately narrow:
 *   - Gate off (GATE_SMS_SEND_WINDOW unset) — dark until Adam flips it.
 *   - Non-SMS channels and internal/admin audiences.
 *   - input `conversationalContext: true` — an immediate answer to a
 *     message the customer just sent us; deferring an instant reply to
 *     8 AM is worse than answering at 9:30 PM. This is EXPLICIT
 *     inbound-reply provenance, set per call site — purpose
 *     'conversational' alone is deliberately NOT exempt, because cold
 *     automated sends (the lead-webhook form auto-reply, the lead-response
 *     agent) reuse that policy for its consent/trust shape while being
 *     exactly the machine-initiated night texts the window fences (the
 *     dropped-call speed-play text has honored this same 8-8 fence since
 *     before the gate). It also serves sends whose purpose must stay
 *     stricter than the conversational policy (the reschedule-reply
 *     confirmation keeps purpose 'appointment' for its trust floor).
 *     Only inbound-reply handlers may set it; an automation/cron passing
 *     it defeats the window and is a review-blocking bug.
 *   - resolved identity trust 'admin_operator' — an operator clicking send
 *     (manual SMS, estimate sends, IB drafts) chose the moment on purpose;
 *     the owner works nights and the moratorium is for machine-initiated
 *     sends, not his own.
 *   - customer-action entry points (CUSTOMER_ACTION_ENTRY_POINTS) — sends
 *     that answer an action the customer just took themselves (self-serve
 *     estimate extension, estimate/quote request, estimate acceptance,
 *     portal service request, payment receipts and payment-lifecycle
 *     notices, the lead-response agent's reply, referral invites). Owner
 *     rulings 2026-08-29: a customer acting at night chose the moment, and
 *     our communication back must not be held to 8 AM. This supersedes the
 *     2026-08-07 fencing of the lead-webhook form auto-reply and the
 *     lead-response agent. Purely schedule-driven outreach (crons,
 *     reminders, follow-up sequences, recovery/retry lanes) stays fenced —
 *     see the set's comment.
 *
 * Blocked results carry { retryable, deferred, nextAllowedAt } so callers
 * that already understand deferral (review requests, card-request nudges)
 * reschedule themselves to the window open instead of dropping the send.
 */

const { isEnabled } = require('../../../config/feature-gates');
const { resolveTrustLevel } = require('./identity');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('../send-window');

// Operator-clicked send surfaces (admin-authenticated routes where a human
// chose to send THIS message NOW). Most admin flows pass customer-level
// identity trust, so trust alone can't identify them — this allowlist is
// the authenticated origin signal. Deliberately ABSENT:
//   - admin_recurring_appointment_created — a side-effect of a booking
//     save, not a send click; night schedule edits blasting texts is the
//     incident this window exists to stop.
//   - every cron/webhook/automation entry point — those are the fence's
//     subjects. New operator surfaces must opt in here (fail closed).
//   - scheduled_sms_cron — the queue carries BOTH operator-composed rows
//     (dispatched at the exact minute the operator picked) and automated
//     requeues (deferred voicemail text-backs, quiet-hours-held prep
//     texts, deposit receipts). A blanket exemption would let an automated
//     row that recovers late — e.g. a stalled queue draining after
//     8:00 PM — text at night. The executor instead passes
//     operatorInitiated for rows with persisted operator provenance
//     (admin attribution / human-authored flag stamped at enqueue);
//     automated rows stay fenced and re-defer via their retryable
//     QUIET_HOURS_HOLD branch.
const OPERATOR_ENTRY_POINTS = new Set([
  'admin_communications_manual_sms',
  'admin_customer_intel_retention_approve',
  'admin_dashboard_ops_inbox_reply',
  'admin_draft_approve',
  'admin_draft_revise',
  'admin_estimate_extend',
  'admin_estimate_follow_up',
  'admin_estimate_send',
  'admin_estimate_send_booking_link',
  'admin_lawn_service_outline_send',
  'admin_leads_send_sms',
  'admin_prep_guide_send',
  'admin_pricing_strategy_upsell',
  'admin_project_report_send',
  'admin_project_report_with_invoice',
  'admin_referral_enrollment',
  'ai_assistant_admin_reply',
  'ai_assistant_send_sms_tool',
  'intelligence_bar_comms_send_sms',
  'intelligence_bar_email_sms_reply',
]);

// Customer-action sends (owner rulings 2026-08-29): each of these entry
// points answers an action the customer took themselves — a form submit,
// a portal click, a tokened-page acceptance or payment — and the send goes
// out immediately, at any hour: the customer chose the moment. That
// includes the responses that ride a customer action indirectly: the
// lead-response agent's reply to a fresh estimate request, the Stripe
// webhook's notices for a payment the customer initiated (ACH failure,
// requires-action, setup-failure), payment receipts, and the invite a
// customer sends a friend (owner-confirmed 2026-08-29: the friend gets it
// immediately, not at 8 AM). Same fail-closed posture as
// OPERATOR_ENTRY_POINTS: new customer-action surfaces must opt in here.
// Deliberately ABSENT: every purely schedule-driven entry point — crons,
// reminders, follow-up sequences, abandon recovery, autopay retries,
// referral reward/milestone notices — where a machine, not a person,
// picks the moment. Those are the night-blast incidents this window
// exists to stop; unfencing them is a new owner ruling, not a PR nit.
const CUSTOMER_ACTION_ENTRY_POINTS = new Set([
  'customer_service_request',
  'estimate_accept_annual_prepay',
  'estimate_accept_onetime_booking',
  'estimate_accept_onetime_confirmed',
  'estimate_deposit_receipt',
  'invoice_receipt_sms',
  'lead_response_auto_reply',
  'lead_webhook_auto_reply',
  'promotions_upsell_interest',
  'public_estimate_add_service_request',
  'public_estimate_extension_request',
  'public_quote_booking_sms',
  'referral_engine_invite',
  'referrals_legacy_invite',
  'referrals_v2_invite',
  'stripe_webhook',
]);

const ET_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function checkSendWindow(input, policy, contactState, now = new Date()) {
  if (!isEnabled('smsSendWindow')) return { ok: true };
  if (input.channel !== 'sms') return { ok: true };
  if (!['customer', 'lead'].includes(input.audience)) return { ok: true };
  // Explicit inbound-reply provenance (see header) — purpose
  // 'conversational' alone is NOT exempt. Same trust model as
  // operatorInitiated: only the handler answering a customer's
  // just-received message may set it.
  if (input.conversationalContext === true) return { ok: true };
  // Explicit operator-origin marker for SHARED services (invoice sends,
  // card requests) whose entry point serves both operator clicks and
  // automation. Only authenticated admin/IB routes may set it — an
  // automated caller passing operatorInitiated:true defeats the window
  // and is a review-blocking bug.
  if (input.operatorInitiated === true) return { ok: true };
  if (OPERATOR_ENTRY_POINTS.has(String(input.entryPoint || ''))) return { ok: true };
  if (CUSTOMER_ACTION_ENTRY_POINTS.has(String(input.entryPoint || ''))) return { ok: true };
  if (resolveTrustLevel(input, contactState) === 'admin_operator') return { ok: true };
  if (isWithinSendWindowET(now)) return { ok: true };

  const nextAllowedAt = nextSendWindowOpenET(now);
  return {
    ok: false,
    code: 'QUIET_HOURS_HOLD',
    reason: `Automated SMS is limited to 8:00 AM-8:00 PM ET; next window opens ${ET_LABEL.format(nextAllowedAt)} ET`,
    retryable: true,
    deferred: true,
    nextAllowedAt: nextAllowedAt.toISOString(),
  };
}

module.exports = { checkSendWindow };
