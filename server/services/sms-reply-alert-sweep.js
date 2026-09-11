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
 * message that has NO delivery covering it. "Covering" is a SYMMETRIC
 * window bound — |R.created_at - M.created_at| < WINDOW for a receipt R
 * and candidate M — not "any later receipt" (round 11, which missed
 * legitimate throttling entirely — see round 12) and not a one-directional
 * "R before M" bound either (codex #4210 round-13 P1, correcting round
 * 12): the claim is per-PHONE, contended by every concurrent message in a
 * burst, so the row that lands in the `messages`/`sms_log` tables FIRST
 * (by created_at) is not necessarily the one whose request actually won
 * the atomic claim and delivered — a message persisted moments earlier can
 * still lose that race to one persisted moments later. A directional
 * bound (round 12) missed exactly that inversion: once the true winner's
 * confirmed window eventually expired, it no longer recognized the
 * winner's (later) receipt as covering the (earlier) loser, and replayed a
 * stale alert for a message nothing new ever arrived for. The window is
 * still narrow enough (WINDOW, same constant either direction) that it
 * doesn't bridge two genuinely unrelated messages: an alert whose dispatch
 * failed HOURS after any nearby receipt (round 11's case) still reads as
 * uncovered — receipts and their genuinely-covered siblings are always
 * close together in time; a real failure is not. Coverage itself is
 * durable evidence (codex #4210 round-10 P1), not a live-bell snapshot:
 * ringSmsReplyBell stamps
 * sms_log.metadata.sms_reply_alerted on any genuine delivery (bell OR
 * push — the same definition used throughout this feature, e.g.
 * hasRecentUnknownSenderReceipt), which survives a bell being dismissed
 * through the admin notification feed without the SMS itself being read,
 * and survives a push-only success that never wrote a bell row at all —
 * both of which a live-bell check alone would misread as orphaned. If
 * nothing durably proves coverage for that message, re-run the SAME
 * throttled dispatch an ordinary inbound webhook uses, inheriting every
 * existing safeguard (atomic claim, secondary receipt check, fail-open
 * behavior) for free.
 */
const db = require('../models/db');
const logger = require('./logger');

// Mirrors twilio-webhook.js's UNKNOWN_SENDER_ALERT_WINDOW_MS — the same 4h
// throttle window a confirmed delivery covers. Kept as a local constant
// (not required from twilio-webhook.js) so requiring this module never
// pulls in that file's whole dependency tree just to read one number; the
// two are small enough, and change together rarely enough, that a
// same-value comment here is the right amount of coupling.
const UNKNOWN_SENDER_ALERT_WINDOW_MS = 4 * 60 * 60 * 1000;

async function findCandidatePhones() {
  const rows = await db('messages as m')
    // Required, not left-joined (codex #4210 round-9 P1): a message with no
    // matching sms_log row, or one that was never stamped eligible by
    // dispatchUnknownSenderAlert, is NOT a recovery candidate — it means
    // the webhook itself decided no sms_reply alert was owed (an AI reply
    // that answered it, a tracking-line first-contact routed to new_lead
    // instead, a quiet reaction, ...), not that one was lost. This is a
    // coarse pre-filter only — the precise per-message decision is
    // findOrphanMessage below. Scoped by the eligibility stamp alone, NOT
    // conversations.customer_id (codex #4210 round-14 P1): a still-unread,
    // never-delivered message's conversation can be promoted to a customer
    // before this sweep ever runs — promotion moves rows, it does not
    // deliver the missing bell — and gating on customer_id IS NULL would
    // permanently exclude it from recovery the instant that happens. The
    // eligibility stamp itself is durable and was only ever written for
    // genuine unknown-sender dispatch attempts, so it's already the
    // correct scope on its own.
    .join('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
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
// delivery covering it — checked per candidate, not once against the
// oldest unread message (codex #4210 round-11 P1), so a later genuinely-
// failed message is recoverable even when an older one from the same
// phone already delivered successfully but is still sitting unread
// (delivered-but-unread is normal — staff simply hasn't looked yet — and
// must not mask an unrelated, later failure). Scoped by phone alone, not
// through a conversations join (codex #4210 round-14 P1) — same
// promotion-safety reasoning as findCandidatePhones above.
async function findOrphanMessage(phone) {
  return db('messages as m')
    .join('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound', 'l.from_phone': phone })
    .whereRaw("l.metadata->>'sms_reply_eligible' = 'true'")
    .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
    .whereNotNull('m.twilio_sid')
    .whereNotExists(function covered() {
      // A receipt R covers this candidate M when they fall within the SAME
      // throttle window of each other — |R.updated_at - M.created_at| <
      // WINDOW — not a one-directional "R before M" bound (codex #4210
      // round-13 P1, correcting round 12's own directionality assumption).
      // The claim is per-PHONE, contended by every concurrent message in a
      // burst, and the DB row order they land in (created_at) need not
      // match which one actually won the atomic claim and delivered: a
      // message persisted first can still lose the race to one persisted
      // moments later if THAT request reaches the claim step first — the
      // "earlier" row (by created_at) is then the one covered by a
      // "later" receipt. A one-directional bound (round 12) missed exactly
      // that inversion and, once the winner's confirmed window eventually
      // expired, treated the earlier, already-covered message as orphaned
      // and replayed a stale alert. The symmetric bound still correctly
      // treats a genuinely later, hours-away failure (round 11) as
      // uncovered — the two messages that matter for THIS decision are
      // never far enough apart in time for the window's radius to
      // accidentally bridge an unrelated pair.
      //
      // R's own anchor is `updated_at` (when delivery was actually
      // confirmed), not `created_at` (when R itself arrived) — codex
      // #4210 round-14 P1: a dispatch — a sweep recovery in particular —
      // can land minutes after the message's own arrival, and the
      // CONFIRMED claim window starts from confirm time, not arrival
      // time. Anchoring on arrival time understates how far the window
      // actually reaches, wrongly treating a later message that was
      // genuinely still within the confirmed window as uncovered once
      // enough time passes for arrival-based math to disagree with the
      // real (confirm-time-based) expiry the claim row itself used.
      this.select(1).from('sms_log as l2')
        .where({ 'l2.direction': 'inbound', 'l2.from_phone': phone })
        .whereRaw("l2.metadata->>'sms_reply_alerted' = 'true'")
        .whereRaw('l2.updated_at > l.created_at - (? * interval \'1 millisecond\')', [UNKNOWN_SENDER_ALERT_WINDOW_MS])
        .whereRaw('l2.updated_at < l.created_at + (? * interval \'1 millisecond\')', [UNKNOWN_SENDER_ALERT_WINDOW_MS]);
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
