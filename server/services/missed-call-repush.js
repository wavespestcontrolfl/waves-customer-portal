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
 * At-most-once: the sweep first stamps notifications.metadata.repushed_at in
 * one atomic UPDATE that re-checks the row is still unread and open. Only the
 * writer that stamped it sends. A crash after the stamp loses the re-push
 * rather than repeating it; that is the deliberate trade.
 *
 * Off (gate unset) the sweep returns before any query.
 */
const db = require('../models/db');
const logger = require('./logger');

const TRIGGER_KEY = 'customer_missed_call';
const REPUSH_AFTER_MS = 30 * 60 * 1000;
// A bell older than this is the office's to close by hand; the window also
// bounds the first sweep after the gate is turned on.
const WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_HOURS = { startMin: 8 * 60, endMin: 18 * 60 };

/**
 * Pure-ish: is the office open at `now`? Mon-Sat only, inside the window,
 * and not a closed day. `hours` is a loadOfficeHours() result; null falls
 * back to the 8:00-18:00 default. Unknown closure state counts as closed.
 */
function officeOpenAt(hours, now = new Date()) {
  const { etParts } = require('../utils/datetime-et');
  if (etParts(now).dayOfWeek === 0) return false;
  const { isOfficeOpenAt } = require('./voice-agent/relay-context');
  return isOfficeOpenAt(hours || DEFAULT_HOURS, now) === true;
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

// One bell: stamp, then push. True when a device accepted it.
async function repushOne(row, now, { triggers, trigger, to, PushService }) {
  // Atomic at-most-once claim, re-checking that nobody opened or closed the
  // bell since the candidate read.
  const stamped = await db('notifications')
    .where({ id: row.id })
    .whereRaw(OPEN_UNREAD)
    .whereRaw("COALESCE(metadata->>'repushed_at', '') = ''")
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repushed_at', ?::text)", [now.toISOString()]) });
  if (!stamped) return false;
  const payload = row.metadata?.payload || {};
  const stillOpen = async () => Boolean(await db('notifications').where({ id: row.id })
    .whereRaw(OPEN_UNREAD).first('id'));
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
      { beforeDispatch: stillOpen, beforeHandoff: stillOpen },
    );
  } catch (err) {
    logger.warn(`[missed-call-repush] push failed for notification ${row.id}: ${err.message}`);
  }
  const sent = Number(stats?.sent || 0);
  await db('notifications').where({ id: row.id })
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('repush_sent', ?::int)", [sent]) })
    .catch(() => {});
  return sent > 0;
}

async function sweepMissedCallRepush({ now = new Date(), limit = 20, hours = undefined } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('missedCallRepush')) return 0;
  try {
    const nowMs = now.getTime();
    const officeHours = hours !== undefined ? hours : await require('./voice-agent/relay-context').loadOfficeHours();
    if (!officeOpenAt(officeHours, now)) return 0;

    const candidates = await db('notifications')
      .where({ recipient_type: 'admin', category: 'missed_call' })
      .whereRaw("metadata->>'triggerKey' = ?", [TRIGGER_KEY])
      .whereRaw(OPEN_UNREAD)
      .whereRaw("COALESCE(metadata->>'repushed_at', '') = ''")
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

    const ctx = { triggers, trigger, to, PushService: require('./push-notifications') };
    let repushed = 0;
    for (const row of candidates) {
      if (await repushOne(row, now, ctx)) repushed += 1;
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
