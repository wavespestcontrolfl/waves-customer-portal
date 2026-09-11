/**
 * Recovery sweep for the unknown-sender sms_reply alert claim (codex #4210
 * round-8 P1). claimUnknownSenderAlertWindow's winner can crash — or simply
 * never get a chance to run its confirm/release branch (process killed
 * mid-dispatch) — after taking the short lease but before either confirming
 * it (delivery proven) or releasing it (delivery failed, observed). A
 * message that LOST that claim race already returned "handled" without
 * ever verifying a bell actually rang (dispatchUnknownSenderAlert's
 * `if (!claimed) return true;`), on the assumption the winner has it
 * covered. With no LATER message from the same sender to reclaim the row,
 * that assumption goes unchecked forever — the thread stays unread with no
 * bell, and nothing alive ever retries. This covers BOTH ways the claim row
 * can end up not reflecting reality: an abandoned lease still sitting there
 * expired (the winner crashed before touching it), and a released one that
 * no longer exists at all (the winner observed the failure and released it
 * correctly, but no later message ever came along to notice) — neither
 * needs a special marker, since this sweep never looks at the claim row to
 * decide whether something is WRONG, only to avoid racing a genuinely
 * in-flight dispatch.
 *
 * This sweep is the recovery path that does not depend on either the loser
 * or the crashed winner still being alive: on a bounded interval
 * (server/services/scheduler.js), find every phone with a still-unlinked
 * (never promoted) conversation holding an unread, sms_reply-eligible
 * inbound message, skip any phone with a genuinely active (unexpired)
 * claim right now, and — for the rest — check whether delivery ACTUALLY
 * already succeeded since the earliest currently-unread such message (not
 * merely whether a live bell exists for it — codex #4210 round-10 P1: a
 * bell that staff already saw and dismissed through the admin notification
 * feed, without opening the SMS thread itself, leaves messages.is_read
 * false while the notification's read_at is set — findLiveBell alone
 * would treat that as "nothing covering it" and re-alert on a message
 * staff already acted on; the same gap hid a push-only success, where
 * ringSmsReplyBell's "delivered" definition — stats.bellWritten OR
 * push.sent > 0 — never required a bell row to exist at all). If nothing
 * durably proves delivery, re-run the SAME throttled dispatch an ordinary
 * inbound webhook uses for the earliest such message, inheriting every
 * existing safeguard (atomic claim, secondary receipt check, fail-open
 * behavior) for free.
 */
const db = require('../models/db');
const logger = require('./logger');

async function findCandidatePhones() {
  const rows = await db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    // Required, not left-joined (codex #4210 round-9 P1): a message with no
    // matching sms_log row, or one that was never stamped eligible by
    // dispatchUnknownSenderAlert, is NOT a recovery candidate — it means
    // the webhook itself decided no sms_reply alert was owed (an AI reply
    // that answered it, a tracking-line first-contact routed to new_lead
    // instead, a quiet reaction, ...), not that one was lost.
    .join('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .whereNull('c.customer_id')
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
    .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
    .whereRaw("l.metadata->>'sms_reply_eligible' = 'true'")
    .select(db.raw('DISTINCT l.from_phone as phone'));
  return rows.map((r) => r.phone).filter(Boolean);
}

async function hasActiveClaim(phone) {
  const row = await db('sms_reply_alert_claims').where({ phone }).where('expires_at', '>=', new Date()).first('phone');
  return Boolean(row);
}

async function earliestUnreadFor(phone) {
  // Same eligibility requirement as findCandidatePhones — the earliest
  // unread message THIS SWEEP is allowed to re-alert for, not merely the
  // earliest unread message overall (which could be an AI-answered one
  // sitting unread for entirely unrelated, non-urgent reasons).
  return db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .join('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound', 'l.from_phone': phone })
    .whereRaw("l.metadata->>'sms_reply_eligible' = 'true'")
    .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
    .whereNotNull('m.twilio_sid')
    .orderBy('m.created_at', 'asc')
    .first('m.twilio_sid', 'm.body', 'm.created_at');
}

// Durable delivery evidence, not a live-bell snapshot (codex #4210
// round-10 P1): ringSmsReplyBell stamps sms_log.metadata.sms_reply_alerted
// on the exact row it delivered for, and ONLY on a genuine delivery
// (bellWritten OR push.sent > 0 — the same "delivered" definition used
// throughout this feature, e.g. hasRecentUnknownSenderReceipt). A bell
// notification row can be dismissed by staff (read_at set) without the
// underlying SMS ever being opened, and a push-only delivery may never
// have written a bell row at all — neither means the message was
// orphaned. Bounded to `since` (the current orphan candidate's own
// created_at) so a genuinely NEW, later contact from the same phone is
// never suppressed by a stamp left over from an much earlier, already-
// resolved conversation.
async function deliveredSince(phone, since) {
  const row = await db('sms_log')
    .where({ direction: 'inbound', from_phone: phone })
    .where('created_at', '>=', since)
    .whereRaw("metadata->>'sms_reply_alerted' = 'true'")
    .first('id');
  return Boolean(row);
}

// `dispatch` is injectable for tests — defaults to the real throttled
// dispatch path so production behavior is a single lazy require (avoids
// requiring routes/twilio-webhook.js's whole dependency tree at module load
// time for callers — the scheduler tick — that will usually find nothing to
// recover).
async function recoverPhone(phone, dispatch) {
  if (await hasActiveClaim(phone)) return false; // a dispatch is genuinely still in flight — don't race it
  const orphan = await earliestUnreadFor(phone);
  if (!orphan) return false; // nothing unread for this phone
  if (await deliveredSince(phone, orphan.created_at)) return false; // already delivered — a dismissed bell or push-only success is not a lost one
  const delivered = await dispatch({ From: phone, MessageSid: orphan.twilio_sid, message: orphan.body });
  return Boolean(delivered);
}

async function sweepUnknownSenderAlertClaims({ dispatch } = {}) {
  const dispatchFn = dispatch || ((args) => require('../routes/twilio-webhook')._internals.dispatchUnknownSenderAlert(args));
  let dispatched = 0;
  let checked = 0;
  try {
    const candidatePhones = await findCandidatePhones();
    for (const phone of candidatePhones) {
      checked += 1;
      try {
        if (await recoverPhone(phone, dispatchFn)) dispatched += 1;
      } catch (e) {
        logger.warn(`[sms-reply-alert-sweep] recovery failed for one phone: ${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`[sms-reply-alert-sweep] sweep failed: ${e.message}`);
  }
  return { checked, dispatched };
}

module.exports = { sweepUnknownSenderAlertClaims, recoverPhone };
