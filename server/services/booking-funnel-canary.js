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
 * Alerts are edge-triggered like sms-draft-canary, and the state is the
 * notification row, not process memory (docs/admin-notifications.md section 4):
 * the bell is raised through raiseAdminAlert under a stable dedupe key per rule
 * with dedupeOpenOnly, so a deploy that re-runs the boot tick, or an outage
 * that persists, updates the one open row and rings nothing new. The owner text
 * goes out only when that raise made a fresh row. When conversions come back the
 * canary closes its own row ("the emitter owns clearing") and texts a recovery
 * line; a later outage is a fresh row and rings again. A read error is logged
 * and then rethrown, so job_health records the failed run.
 *
 * Dark-shipped: no-ops unless GATE_BOOKING_FUNNEL_CANARY=true (standard
 * feature-gate registry; owner flips). Read-only on booking_intents; sends
 * no customer-facing communications — the SMS is an internal_alert to
 * ADAM_PHONE only.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const FAST_WINDOW_MS = 72 * 60 * 60 * 1000;
const SLOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FAST_MIN_ATTEMPTS = 5;
const SLOW_MIN_ATTEMPTS = 3;
const RULES = ['fast', 'slow'];
const alertKey = (rule) => `booking-funnel-canary:${rule}`;

// Raise (or quietly refresh) the one open bell for this rule. Returns true when
// this call made a new bell (a new episode), false when the standing row took it.
async function raiseFiring(rule, windowLabel, attempts) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const dedupeKey = alertKey(rule);
  const result = await raiseAdminAlert('system', {
    area: 'System',
    action: 'test the online booking funnel',
    why: 'Visitors reach the booking page but no booking has confirmed.',
    severity: 'needs-you',
    link: '/admin/schedule',
    subject: { type: 'check', id: dedupeKey },
    doneWhen: 'bookings_confirm',
    who: 'person',
  }, {
    detail: `${attempts} visitors entered the /book funnel in the last ${windowLabel} and ZERO bookings were confirmed. `
      + 'This is the signature of a dead confirm step (like the July slot_sig outage) — test the funnel on wavespestcontrol.com/book/ now.',
    dedupeKey,
    // A row a person or the recovery closed never hides a new outage.
    dedupeOpenOnly: true,
    // A changed count rewrites the standing row without ringing again.
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    metadata: { source: 'booking-funnel-canary', rule, attempts },
  });
  // null = the write failed: treat as fresh so Adam still gets the text.
  return !result || (!result.suppressed && !result.deduped);
}

// Close this rule's open bell, if any. Returns rows closed.
async function closeRule(rule, resolution, now = new Date()) {
  const episodes = require('./admin-alert-episodes');
  const dedupeKey = alertKey(rule);
  if (!(await episodes.openAdminAlertKeys(db, dedupeKey)).includes(dedupeKey)) return 0;
  return Number(await episodes.closeAdminAlertKeys(db, [dedupeKey], 'conversions_back', { now, resolution })) || 0;
}

async function smsAdam(title, body) {
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
 * One canary evaluation. A read error is logged and rethrown (job_health
 * records it); the tick wrapper in scheduler.js catches it, so a canary crash
 * still cannot take down the scheduler tick or boot path that runs it.
 */
async function runBookingFunnelCanary() {
  if (!isEnabled('bookingFunnelCanary')) {
    return { skipped: true };
  }
  let fast;
  let slow;
  try {
    if (!(await db.schema.hasTable('booking_intents'))) return { skipped: true };
    fast = await countWindow(FAST_WINDOW_MS);
    slow = await countWindow(SLOW_WINDOW_MS);
  } catch (err) {
    logger.error(`[booking-funnel-canary] run failed: ${err.message}`);
    throw err;
  }

  const firing = (fast.attempts >= FAST_MIN_ATTEMPTS && fast.conversions === 0)
    ? 'fast'
    : (slow.attempts >= SLOW_MIN_ATTEMPTS && slow.conversions === 0) ? 'slow' : null;

  try {
    if (firing) {
      const windowLabel = firing === 'fast' ? '72 hours' : '7 days';
      const { attempts } = firing === 'fast' ? fast : slow;
      logger.error(`[booking-funnel-canary] FIRING (${firing}): ${attempts} funnel entries, 0 conversions in ${windowLabel}`);
      let fresh = true;
      try {
        fresh = await raiseFiring(firing, windowLabel, attempts);
      } catch (err) {
        logger.error(`[booking-funnel-canary] admin notification failed: ${err.message}`);
      }
      if (fresh) {
        await smsAdam(
          'Online booking funnel may be BROKEN',
          `${attempts} visitors entered the /book funnel in the last ${windowLabel} and ZERO bookings were confirmed. `
          + 'This is the signature of a dead confirm step (like the July slot_sig outage) — test the funnel on wavespestcontrol.com/book/ now.'
        );
      }
      // The other rule's row is stale once this one is the live signal.
      await closeRule(RULES.find((rule) => rule !== firing), 'Replaced by the other booking funnel rule');
      return { firing, fast, slow };
    }

    // Only claim recovery when conversions actually reappeared; if the rule
    // merely stopped firing for lack of attempts, clear quietly.
    const recovered = fast.conversions > 0;
    const resolution = recovered
      ? 'Recovered: bookings are confirming again'
      : 'Cleared: too few visitors to judge';
    let closed = 0;
    for (const rule of RULES) closed += await closeRule(rule, resolution);
    if (closed && recovered) {
      await smsAdam('Online booking funnel recovered', `Bookings are confirming again (${fast.conversions} in the last 72 hours).`);
    }
    return { firing: null, fast, slow };
  } catch (err) {
    // Bell state could not be read or closed: record the failed run.
    logger.error(`[booking-funnel-canary] alert step failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  runBookingFunnelCanary,
  _test: { countWindow },
};
