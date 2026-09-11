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
 * claim right now, and — for the rest — find the earliest unread eligible
 * message that has NO delivery covering it (codex #4210 round-11 P1: a
 * receipt is per-MESSAGE coverage, not a phone-wide "anything ever
 * delivered" flag — an older message that delivered successfully but is
 * still sitting unread must not block recovery of a genuinely later,
 * genuinely failed one; each candidate is checked against receipts at or
 * after ITS OWN arrival, not the oldest unread message's). Delivery
 * coverage itself is durable evidence (codex #4210 round-10 P1), not a
 * live-bell snapshot: ringSmsReplyBell stamps sms_log.metadata.
 * sms_reply_alerted on any genuine delivery (bell OR push — the same
 * definition used throughout this feature, e.g.
 * hasRecentUnknownSenderReceipt), which survives a bell being dismissed
 * through the admin notification feed without the SMS itself being read,
 * and survives a push-only success that never wrote a bell row at all —
 * both of which a live-bell check alone would misread as orphaned. If
 * nothing durably proves delivery for that message, re-run the SAME
 * throttled dispatch an ordinary inbound webhook uses, inheriting every
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
    // instead, a quiet reaction, ...), not that one was lost. This is a
    // coarse pre-filter only — the precise per-message decision is
    // findOrphanMessage below.
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

// The earliest unread, sms_reply-eligible message from `phone` with NO
// delivery covering it — "covering" meaning a genuine delivery receipt
// (sms_log.metadata.sms_reply_alerted) at or after THAT message's own
// arrival (codex #4210 round-11 P1). Checking coverage per candidate,
// rather than once against the oldest unread message, is what lets a
// later genuinely-failed message get recovered even when an older one
// from the same phone already delivered successfully but is still
// sitting unread (delivered-but-unread is normal — staff simply hasn't
// looked yet — and must not mask an unrelated, later failure).
async function findOrphanMessage(phone) {
  return db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .join('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound', 'l.from_phone': phone })
    .whereRaw("l.metadata->>'sms_reply_eligible' = 'true'")
    .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
    .whereNotNull('m.twilio_sid')
    .whereNotExists(function delivered() {
      this.select(1).from('sms_log as l2')
        .where({ 'l2.direction': 'inbound', 'l2.from_phone': phone })
        .whereRaw("l2.metadata->>'sms_reply_alerted' = 'true'")
        .whereRaw('l2.created_at >= l.created_at');
    })
    .orderBy('m.created_at', 'asc')
    .first('m.twilio_sid', 'm.body');
}

// `dispatch` is injectable for tests — defaults to the real throttled
// dispatch path so production behavior is a single lazy require (avoids
// requiring routes/twilio-webhook.js's whole dependency tree at module load
// time for callers — the scheduler tick — that will usually find nothing to
// recover).
async function recoverPhone(phone, dispatch) {
  if (await hasActiveClaim(phone)) return false; // a dispatch is genuinely still in flight — don't race it
  const orphan = await findOrphanMessage(phone);
  if (!orphan) return false; // every unread eligible message already has delivery coverage
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
