/**
 * Missed-call re-push (GATE_MISSED_CALL_REPUSH, owner "ALL" 2026-10-20).
 * Admin push only: nothing here reaches a customer.
 *
 * A customer_missed_call bell that is still unread and not done 30 minutes
 * after it rang gets ONE more push, so a call that slipped past the first
 * buzz is not left until the next time somebody opens the app. The re-push
 * runs only in office hours (Mon-Sat 8:00-18:00 ET, from the same
 * booking_config window and closed-day list the voice agent reads), reuses
 * the call's own push tag (waves-customer_missed_call-<callLogId>) with
 * renotify true so the phone buzzes again instead of silently replacing the
 * first banner, and writes NO new bell row.
 *
 * At-most-once: notifications.metadata.repushed_at is stamped in one atomic
 * UPDATE that re-checks the row is still unread and open. The stamp runs in
 * the push service's beforeDispatch hook, i.e. after the subscription lookup
 * and immediately before the first provider handoff, so a failed lookup never
 * consumes the one re-push. Only the writer that stamped it sends. A crash
 * after the stamp loses the re-push rather than repeating it; that is the
 * deliberate trade.
 *
 * Off (gate unset) the sweep returns before any query.
 */
const db = require('../models/db');
const logger = require('./logger');

const TRIGGER_KEY = 'customer_missed_call';
// call_log.metadata.missed_call_spam_wave value the bell stamps on a quiet burst call.
const QUIET_BURST = 'burst_quiet';
const REPUSH_AFTER_MS = 30 * 60 * 1000;
// A bell older than this is the office's to close by hand; the window also
// bounds the first sweep after the gate is turned on.
const WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Pure-ish: is the office open at `now`? Mon-Sat only, inside the window,
 * and not a closed day. `hours` is a loadOfficeHours() result; null (an
 * unreadable config) counts as closed, like an unknown closure state.
 */
function officeOpenAt(hours, now = new Date()) {
  const { etParts } = require('../utils/datetime-et');
  if (etParts(now).dayOfWeek === 0) return false;
  const { isOfficeOpenAt } = require('./voice-agent/relay-context');
  // Unreadable hours = closed: no re-push on a day we cannot prove is open (pre-push audit).
  if (!hours) return false;
  return isOfficeOpenAt(hours, now) === true;
}

const OPEN_UNREAD = "notifications.read_at IS NULL AND notifications.done_at IS NULL";

// Active admins whose preference for this trigger has push on (the first
// push's recipient rule). { recipients, pref } or null on a failed read or
// when the bell policy silences the category.
async function repushRecipients(triggers, trigger) {
  try {
    const bellPolicy = require('./notification-bell-policy');
    if (bellPolicy.isBellPolicyEnabled()
      && !(await bellPolicy.bellAllowed({ category: trigger.category, triggerKey: TRIGGER_KEY }))) return null;
  } catch (err) {
    logger.warn(`[missed-call-repush] bell policy check failed: ${err.message}; delivering`);
  }
  let prefs;
  let admins;
  try {
    prefs = await db('notification_preferences').where({ trigger_key: TRIGGER_KEY });
    admins = await db('technicians').where({ active: true, role: 'admin' }).select('id');
  } catch (err) {
    logger.warn(`[missed-call-repush] recipient lookup failed: ${err.message}`);
    return null;
  }
  const prefByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));
  const pref = (id) => prefByUser.get(id) || triggers.defaultPreference(trigger);
  const recipients = admins.map((a) => a.id).filter((id) => pref(id).push_enabled !== false);
  return recipients.length ? { recipients, pref } : null;
}

// Office hours, re-read at every boundary (sweep start, each bell's claim, each
// device): open per the loaded window AND the closed-day list read STRICTLY, so
// an unreadable blackout lookup counts as closed (find-time's rule).
async function canRepushNow(hours, clock) {
  const at = clock();
  if (!officeOpenAt(hours, at)) return false;
  try {
    const { etDateString } = require('../utils/datetime-et');
    const { getBlackoutDates } = require('./scheduling/blackout-dates');
    const day = etDateString(at);
    const closed = await getBlackoutDates(day, day, db, { strict: true });
    return !closed.has(day);
  } catch (err) {
    logger.warn(`[missed-call-repush] closed-day lookup failed; treating as closed: ${err.message}`);
    return false;
  }
}

// One bell: push, stamping repushed_at inside beforeDispatch. True when a
// device accepted it.
async function repushOne(row, { triggers, trigger, to, PushService, hours, clock }) {
  const payload = row.metadata?.payload || {};
  const stillOpen = async () => Boolean(await db('notifications').where({ id: row.id })
    .whereRaw(OPEN_UNREAD).first('id'));
  // The call itself is still unreturned: no later answered call-back or
  // call-in (the answered-proof called-back SQL), so a caller who got through
  // after this tick's retire never buzzes again (Codex #6383 r3).
  const callStillMissed = async () => {
    if (!payload.callLogId) return true;
    const { calledBackSql } = require('./missed-call-bell');
    const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
    const call = await db('call_log').where('id', payload.callLogId)
      .modify((qb) => whereNotSandboxCall(qb))
      .first('id', db.raw(`(${calledBackSql({ retire: true })}) AS still_missed`), db.raw("metadata->>'missed_call_spam_wave' AS spam_wave"));
    // A burst the bell deliberately kept quiet (GATE_MISSED_CALL_SPAM_BURST) is never buzzed later.
    if (call?.spam_wave === QUIET_BURST) return false;
    // No call row proves nothing either way: the bell stays eligible.
    return !call || call.still_missed === true;
  };
  let claimed = false;
  // Runs after the subscription lookup, right before the first handoff. The
  // atomic stamp re-checks that nobody opened, closed or re-pushed the bell.
  const claim = async () => {
    if (!(await canRepushNow(hours, clock)) || !(await callStillMissed())) return false;
    const stamped = await db('notifications')
      .where({ id: row.id })
      .whereRaw(OPEN_UNREAD)
      .whereRaw("COALESCE(metadata->>'repushed_at', '') = ''")
      .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repushed_at', ?::text)", [clock().toISOString()]) });
    claimed = stamped > 0;
    return claimed;
  };
  // Before every device: still open, and still office hours.
  // canRepushNow re-reads the closed-day list strictly, so a closure that lands
  // mid-fan-out (or an unreadable list) stops the remaining devices too.
  const beforeHandoff = async () => (await canRepushNow(hours, clock)) && (await stillOpen()) && (await callStillMissed());
  let stats = null;
  try {
    stats = await PushService.sendToAdminUsers(
      to.recipients,
      (adminUserId) => {
        const wantsSound = to.pref(adminUserId).sound_enabled !== false;
        return {
          title: row.title,
          body: row.body,
          url: row.link || '/admin',
          tag: triggers.__private.pushTagFor(TRIGGER_KEY, payload),
          priority: trigger.priority,
          vibrate: wantsSound ? triggers.__private.PRIORITY_VIBRATE[trigger.priority] : [0],
          silent: !wantsSound,
          renotify: true,
        };
      },
      { beforeDispatch: claim, beforeHandoff },
    );
  } catch (err) {
    logger.warn(`[missed-call-repush] push failed for notification ${row.id}: ${err.message}`);
  }
  if (!claimed) return false;
  const sent = Number(stats?.sent || 0);
  await db('notifications').where({ id: row.id })
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repush_sent', ?::int)", [sent]) })
    .catch(() => {});
  return sent > 0;
}

async function sweepMissedCallRepush({ now = new Date(), limit = 20, hours = undefined, clock = () => new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('missedCallRepush')) return 0;
  try {
    const nowMs = now.getTime();
    const officeHours = hours !== undefined ? hours : await require('./voice-agent/relay-context').loadOfficeHours();
    if (!(await canRepushNow(officeHours, clock))) return 0;
    // Retire bells whose caller already got through first, so a resolved call
    // never buzzes again. If the retire fails, this tick sends nothing.
    await require('./missed-call-bell').retireCalledBackMissedCalls();

    const candidates = await db('notifications')
      .where({ recipient_type: 'admin', category: 'missed_call' })
      .whereRaw("metadata->>'triggerKey' = ?", [TRIGGER_KEY])
      .whereRaw(OPEN_UNREAD)
      .whereRaw("COALESCE(metadata->>'repushed_at', '') = ''")
      // A quiet burst call never re-pushes; leaving it out here also keeps it from
      // filling the oldest-first batch ahead of real bells. callStillMissed checks again.
      .whereRaw("NOT EXISTS (SELECT 1 FROM call_log quiet WHERE quiet.id::text = notifications.metadata->'payload'->>'callLogId' AND quiet.metadata->>'missed_call_spam_wave' = ?)", [QUIET_BURST])
      .where('created_at', '<=', new Date(nowMs - REPUSH_AFTER_MS))
      .where('created_at', '>', new Date(nowMs - WINDOW_MS))
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'title', 'body', 'link', 'metadata');
    if (!candidates.length) return 0;

    const triggers = require('./notification-triggers');
    const trigger = triggers.TRIGGER_REGISTRY[TRIGGER_KEY];
    const to = await repushRecipients(triggers, trigger);
    if (!to) return 0;

    const ctx = { triggers, trigger, to, PushService: require('./push-notifications'), hours: officeHours, clock };
    let repushed = 0;
    for (const row of candidates) {
      if (!officeOpenAt(officeHours, clock())) break;
      if (await repushOne(row, ctx)) repushed += 1;
    }
    return repushed;
  } catch (err) {
    logger.warn(`[missed-call-repush] sweep failed: ${err.message}`);
    return 0;
  }
}

module.exports = {
  sweepMissedCallRepush,
  officeOpenAt,
  REPUSH_AFTER_MS,
  WINDOW_MS,
};
