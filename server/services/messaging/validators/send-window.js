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

const ET_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function checkSendWindow(input, policy, contactState, now = new Date()) {
  if (!isEnabled('smsSendWindow')) return { ok: true };
  if (input.channel !== 'sms') return { ok: true };
  if (!['customer', 'lead'].includes(input.audience)) return { ok: true };
  if (input.purpose === 'conversational') return { ok: true };
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
