/**
 * check_send_window — blocks automated customer/lead SMS outside the
 * 8:00 AM–8:00 PM ET send window (owner ruling 2026-08-07; see
 * ../send-window.js for the incident and boundary rationale).
 *
 * Exemptions, deliberately narrow:
 *   - Gate off (GATE_SMS_SEND_WINDOW unset) — dark until Adam flips it.
 *   - Non-SMS channels and internal/admin audiences.
 *   - purpose 'conversational' — a reply into an active thread answers a
 *     customer who just texted us; deferring an instant reply to 8 AM is
 *     worse than answering at 9:30 PM.
 *   - resolved identity trust 'admin_operator' — an operator clicking send
 *     (manual SMS, estimate sends, IB drafts) chose the moment on purpose;
 *     the owner works nights and the moratorium is for machine-initiated
 *     sends, not his own.
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
// scheduled_sms_cron IS exempt: it dispatches at the exact minute an
// operator explicitly picked on the schedule-SMS composer.
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
  'admin_pricing_strategy_upsell',
  'admin_project_report_send',
  'admin_project_report_with_invoice',
  'admin_referral_enrollment',
  'ai_assistant_admin_reply',
  'ai_assistant_send_sms_tool',
  'intelligence_bar_comms_send_sms',
  'intelligence_bar_email_sms_reply',
  'scheduled_sms_cron',
]);

const ET_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function checkSendWindow(input, policy, contactState, now = new Date()) {
  if (!isEnabled('smsSendWindow')) return { ok: true };
  if (input.channel !== 'sms') return { ok: true };
  if (!['customer', 'lead'].includes(input.audience)) return { ok: true };
  if (input.purpose === 'conversational') return { ok: true };
  if (OPERATOR_ENTRY_POINTS.has(String(input.entryPoint || ''))) return { ok: true };
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
