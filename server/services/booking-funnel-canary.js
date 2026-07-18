/**
 * Booking-funnel conversion canary.
 *
 * In July 2026 the public /book funnel was dead for ~8 days: #2572 made
 * /api/booking/confirm require the signed slot offer (slot_sig), the astro
 * site's native form was never updated to echo it, and every confirmation
 * 409'd with the recoverable-looking "pick another time" message. Visitors
 * kept trying, nothing errored server-side, and no one noticed until a full
 * site audit. This canary is the alarm that was missing.
 *
 * Signal: booking_intents rows are captured the moment a /book visitor enters
 * a valid phone with a slot picked (proof-of-funnel token required, so every
 * row is a real funnel entry), and converted_at is stamped atomically when a
 * self-booking commits. Real visitors trying with ZERO conversions across a
 * whole window is exactly the broken-funnel signature — individual abandons
 * are normal, a conversion rate of exactly zero at volume is not.
 *
 * Two rules, both requiring zero conversions:
 *   fast: >= 5 attempts in the trailing 72h  (catches a hard break in days)
 *   slow: >= 3 attempts in the trailing 7d   (catches it even at low traffic)
 *
 * Alerts are edge-triggered like sms-draft-canary: one alert per state
 * change, a re-alert if the outage persists past REALERT_MS, and a recovery
 * notice when conversions reappear after an alert. State is in-memory — a
 * restart re-runs the boot tick, which re-alerts if the funnel is still dead.
 *
 * Dark-shipped: no-ops unless GATE_BOOKING_FUNNEL_CANARY=1 (owner flips).
 * Read-only on booking_intents; sends no customer-facing communications —
 * the SMS is an internal_alert to ADAM_PHONE only.
 */
const db = require('../models/db');
const logger = require('./logger');

const FAST_WINDOW_MS = 72 * 60 * 60 * 1000;
const SLOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FAST_MIN_ATTEMPTS = 5;
const SLOW_MIN_ATTEMPTS = 3;
const REALERT_MS = 24 * 60 * 60 * 1000;

// { alerting: 'fast'|'slow'|null, lastAlertAt: number }
const state = { alerting: null, lastAlertAt: 0 };

async function alertAdmin(title, body) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin('system', title, body, { link: '/admin/schedule' });
  } catch (err) {
    logger.error(`[booking-funnel-canary] admin notification failed: ${err.message}`);
  }
  try {
    const TwilioService = require('./twilio');
    const phone = process.env.ADAM_PHONE;
    if (phone) {
      // allowOwnerSms: same rationale as sms-draft-canary — without it the
      // internal_alert redirects into the admin-notification trigger this
      // canary already fired, and Adam never gets the out-of-band text.
      await TwilioService.sendSMS(phone, `${title}\n${body}`, {
        messageType: 'internal_alert',
        allowOwnerSms: true,
      });
    }
  } catch (err) {
    logger.error(`[booking-funnel-canary] alert SMS failed: ${err.message}`);
  }
}

// Window boundaries are absolute instants (Date objects), never naive ISO
// strings — trailing intervals need no ET boundary math (waves-db §2).
async function countWindow(sinceMs) {
  const since = new Date(Date.now() - sinceMs);
  const attemptsRow = await db('booking_intents')
    .where('captured_at', '>=', since)
    .where('suppressed', false)
    .count('id as n')
    .first();
  const conversionsRow = await db('booking_intents')
    .whereNotNull('converted_at')
    .where('converted_at', '>=', since)
    .count('id as n')
    .first();
  return {
    attempts: parseInt(attemptsRow && attemptsRow.n, 10) || 0,
    conversions: parseInt(conversionsRow && conversionsRow.n, 10) || 0,
  };
}

/**
 * One canary evaluation. Never throws — a canary crash must not take down
 * the scheduler tick or boot path that runs it.
 */
async function runBookingFunnelCanary() {
  if (process.env.GATE_BOOKING_FUNNEL_CANARY !== '1') {
    return { skipped: true };
  }
  try {
    if (!(await db.schema.hasTable('booking_intents'))) return { skipped: true };

    const fast = await countWindow(FAST_WINDOW_MS);
    const slow = await countWindow(SLOW_WINDOW_MS);

    const firing = (fast.attempts >= FAST_MIN_ATTEMPTS && fast.conversions === 0)
      ? 'fast'
      : (slow.attempts >= SLOW_MIN_ATTEMPTS && slow.conversions === 0) ? 'slow' : null;

    if (firing) {
      const windowLabel = firing === 'fast' ? '72 hours' : '7 days';
      const { attempts } = firing === 'fast' ? fast : slow;
      const changed = state.alerting !== firing;
      const stale = Date.now() - state.lastAlertAt >= REALERT_MS;
      logger.error(`[booking-funnel-canary] FIRING (${firing}): ${attempts} funnel entries, 0 conversions in ${windowLabel}`);
      if (changed || stale) {
        await alertAdmin(
          'Online booking funnel may be BROKEN',
          `${attempts} visitors entered the /book funnel in the last ${windowLabel} and ZERO bookings were confirmed. `
          + 'This is the signature of a dead confirm step (like the July slot_sig outage) — test the funnel on wavespestcontrol.com/book/ now.'
        );
        state.alerting = firing;
        state.lastAlertAt = Date.now();
      }
      return { firing, fast, slow };
    }

    if (state.alerting) {
      // Only claim recovery when conversions actually reappeared; if the
      // rule merely stopped firing for lack of attempts, clear quietly.
      if (fast.conversions > 0) {
        await alertAdmin(
          'Online booking funnel recovered',
          `Bookings are confirming again (${fast.conversions} in the last 72 hours).`
        );
      }
      state.alerting = null;
      state.lastAlertAt = 0;
    }
    return { firing: null, fast, slow };
  } catch (err) {
    logger.error(`[booking-funnel-canary] run failed: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = {
  runBookingFunnelCanary,
  _test: { state, countWindow },
};
