'use strict';

/**
 * Star-key hold on the conference call path (GATE_CALL_HOLD, owner 2026-11-16 "ok build all").
 * The staff press star in the room (<Dial hangupOnStar>): Twilio takes them out and the action URL
 * runs startHold. The caller (a conference participant) is put on hold with a holdUrl that speaks the
 * pest-fact script, and the call recording pauses. The staff press 1 on the menu: endHold takes the caller
 * off hold and resumes the recording. Hold timer (same gate): a 3 minute staff reminder and a 5 minute limit
 * that sends the caller to voicemail; the staff phone hanging up during a hold does too. A voicemail ENDS THE
 * ROOM: the caller's <Dial> action then runs /call-complete?conf=1, which lets the caller leave a message inside
 * the call's own recording (never a <Record>, never a redirect).
 *
 * ONE DECISION POINT (same shape as live-call-card-pause.js). Every hold event (a star, a press 1, the
 * reminder and limit check of the two loops, the staff phone hanging up) is decided in one short transaction
 * under pg_advisory_xact_lock(hashtext('call_hold:' || callSid)): it reads the hold, runs ONE pure planner
 * (planEvent) and writes the new WANTED state, then commits. No Twilio request runs inside a transaction, and
 * no connection is held while a request is in flight.
 *
 * State: call_log.metadata.conference_path.hold {
 *   gen        the hold generation: +1 each time a star opens a new hold (an event for an old one is a no-op),
 *   phase      the wanted phase: 'held' | 'returned' | 'voicemail' (voicemail_reason: 'timeout' | 'staff_left'),
 *   applied    what Twilio has confirmed for this gen: null | 'held' | 'returned' | 'voicemail',
 *   ret_by     'press1' | 'abort' (a star whose hold request failed: the staff were put back in the room),
 *   open_at, by, leg_sid, count, total_sec, reminded_at, voicemail_at, voicemail_reason,
 *   vm_failed  a voicemail step failed while the caller was not on hold (re-held so a loop exists),
 *   rec_pending  a press 1 return was confirmed but the recording resume was not: step 'resume' retries it,
 *   alert_pending  the voicemail was confirmed but its callback bell was not delivered: step 'alert' retries it,
 *   alerted_at  when that bell was delivered,
 *   vm_answered_at  when /call-complete?conf=1 answered the hold voicemail (the caller is in it: the bell is wanted),
 *   gone       the caller's room was already gone when a step ran,
 *   sender     { token, until }: the lease of the one sender }.
 *
 * SENDS. Only the lease holder talks to Twilio for a call, one step at a time (participant hold + recording
 * pause | unhold + recording resume | end the room), across every server process. claimStep decides the next
 * step from the wanted state AND takes or renews the lease in the same stamp; after each step the outcome is
 * recorded from the state as it is NOW and the state is read again, so a newer decision gets its own step
 * before the lease is released. Twilio therefore sees the steps in decision order and the last step matches the
 * newest decision: a pause can never land after a resume, and a voicemail can never end a room a return is
 * working on. A crashed sender's lease expires (LEASE_MS) and the next fetch of a loop finishes the step. Right
 * before each Twilio request that changes the call, fenceLease re-checks and extends the lease in one short
 * transaction: a sender that stalled past its lease, and was taken over, sends nothing more.
 *
 * WHAT FINISHES A WANTED STATE (no wanted state is left without an actor):
 *   held, not confirmed    the star request itself (it waits for the step, then aborts the hold on a failure or
 *                          a timeout: the staff go back in the room and a later sender unholds the caller);
 *   returned, not confirmed  the press 1 request (waits up to WAIT_MS); then the staff menu loop (every ~15 s,
 *                          the staff are still on it); if the staff hung up instead, that is a voicemail event
 *                          (call-conference-path.js retries it when its handling throws, and its minute sweep
 *                          ends the room of a winning leg that is over, so no caller is left alone in the room);
 *   voicemail, not confirmed the caller on hold: the facts loop (every ~10 s); the caller not on hold (a return
 *                          finished first): a failed voicemail step is followed, in the same pass, by a re-hold of
 *                          the caller, so the facts loop exists again (nothing else runs for a caller alone in the
 *                          room); the staff-left handler tries once itself.
 *
 * TWO PENDING STATES THAT NEVER BLOCK A NEW DECISION (isIdle ignores both). A return confirms the unhold at once (the
 * staff rejoin) and records whether the recording resume was confirmed; if not, rec_pending keeps step 'resume' wanted
 * (a fenced resume request only) until it is confirmed, Twilio gives a code a retry cannot fix (TERMINAL_RESUME_CODES),
 * or the call is over. A voicemail records alert_pending in the same write that confirms it; step 'alert' (no Twilio
 * request, still the lease holder) raises the callback bell with its dedupe key and clears it only on a written row (an
 * id, or an intentional suppression). Retries: a failed resume gets a 2, 4, 8, 16 s in-process backoff (one chain per
 * call), then recoverPendingHolds, a 1 minute sweep (scheduler.js, whatever the gates say) that drains any recent call
 * with either state pending through the same lease path, so two server processes send one resume and raise one bell.
 *
 * THE CARD PAUSE (live-call-card-pause.js) pauses this recording too, while card details are spoken. Every resume of
 * the hold (press 1, its retries, the voicemail) goes out through resumeOutsideCardWindow, as the card pause's lease
 * holder: never inside a card window whose pause was sent (that window's own end resumes the recording, and the hold
 * counts its resume as done; the voicemail counts it as not resumed and invites no message), and always before a card
 * pause decided while it is in flight. The card pause reads this hold's phase in every decision: a card window that ends
 * while the caller is held sends no resume (the return resumes the recording), and a card resume that lands as a hold
 * starts is followed by a pause. So the recording runs again only once both are over.
 *
 * THE HOLD BUTTON (the Live call panel, admin-call-recordings.js POST /live/:id/hold) and THE VOICE TRIGGER: requestHold moves the staff leg
 * that won the press 1 out of the room by REST, to the star's own route with by=button or by=voice. From there the hold IS a star
 * hold: the same decision, sender, menu, timer and press 1. Moving a call that is in a <Dial> also makes Twilio request
 * that <Dial>'s action URL, which is the same route: the second request is a duplicate star that replaces nothing, and
 * both answer the same TwiML. The voice trigger (call-hold-voice.js, GATE_CALL_HOLD_VOICE) asks the same way, with
 * by=voice, when the staff say "please hold" or "let me put you on hold" on the live call. Nothing here texts or calls anyone.
 *
 * THE WARM TRANSFER (GATE_CALL_WARM_TRANSFER, owner 2026-11-16 "ok build all", part 6): the staff on the hold menu press 2 and
 * the server places ONE call to CALL_TRANSFER_TO. The state is hold.transfer { n (unique on the call: hold.transfers counts
 * the call's transfers and a new star carries it), status 'ringing' | 'accepted' | 'failed' |
 * 'canceled', leg_sid, from_leg_sid, from_name, at, ended_at, end_reason, from_left_at, accepted_at } (no phone numbers). It lives
 * inside the hold, so a new star starts with none, and it is decided at the same one decision point. The owner's press 1
 * (transfer_accept) is a press 1 return (ret_by 'transfer') and, in the SAME transaction, makes his leg the call's winning leg
 * (conference_path.accepted_leg_sid): one commit for both, or neither. The staff pressing 1 while it rings cancels it (the
 * owner's call is ended: cancelLegSid). The staff hanging up while it rings defers the voicemail (from_left_at): the owner's
 * answer then returns the caller, and no answer (the call ended, or 75 s) sends the caller to voicemail (transfer_unanswered).
 * What finishes a ringing transfer: the owner's call status callback (endTransfer), the staff wait loop and the caller's facts
 * loop (checkHold expires it after TRANSFER_EXPIRY_SEC), the voicemail (it ends the owner's call), the caller hanging up.
 * A transfer whose return is not confirmed is finished like any press 1 return (see WHAT FINISHES A WANTED STATE).
 * The lock passes the call's winning leg (accepted_leg_sid) to the planner, and the accept moves it in its own write. So a
 * staff leg end read as the winner's just before the accept ends nothing ('not_winner'), and a placement write that lands
 * after the accept answers 'ok' and never ends his call.
 *
 * Left open: Twilio unreachable for every request of a re-hold as well (see the report), and a database that
 * is down while the caller is held (no decision can be made; the caller keeps the script).
 *
 * No function here throws to a route; logs carry masked SIDs and error codes only.
 */

const crypto = require('crypto');
const twilio = require('twilio');
const RequestClient = require('twilio/lib/base/RequestClient');
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { toE164, isValidNanpNumber } = require('../utils/phone');
const conferencePath = require('./call-conference-path');
const { TERMINAL_CALL_STATUSES } = require('../utils/call-timeline');
// The card pause pauses this recording too (see THE CARD PAUSE above). Its rule for the Twilio answers a resume retry
// cannot fix (16108, 21220, 20404) is the hold's rule too.
const cardPause = require('./live-call-card-pause');

const { TERMINAL_RESUME_CODES } = cardPause;

const WEBHOOK_BASE = '/api/webhooks/twilio';
// A hold open this long is told to the staff phone (reminder) and sent to voicemail (limit). Owner-approved.
const HOLD_REMINDER_SEC = 180;
const HOLD_LIMIT_SEC = 300;
// A request that takes longer is abandoned (an unknown outcome). Each request is fenced (the lease re-checked and
// extended right before it), so a request never outlives the lease it went out under; a whole step (up to 3
// requests) also fits in one lease.
const REQUEST_TIMEOUT_MS = 2500;
const LEASE_MS = 8 * 1000;
// One pass runs at most this many steps (a hold, the return that replaced it, its resume, the voicemail that replaced
// that, its bell).
const MAX_SENDS_PER_PASS = 6;
// The press 1 and star requests wait this long (in steps) for a step another sender holds the lease on.
const WAIT_MS = 6 * 1000;
const WAIT_STEP_MS = 250;
// The owner's phone rings this long; a transfer still ringing after the expiry is over whatever Twilio says.
const TRANSFER_RING_SEC = 20;
const TRANSFER_EXPIRY_SEC = 75;
// A failed recording resume is retried in this process after these delays (one chain per call), then by the sweep.
const RESUME_BACKOFF_MS = [2000, 4000, 8000, 16000];
// The 1 minute sweep reads calls created in this window, at most this many.
const SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const SWEEP_LIMIT = 25;

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const isEnabled = () => typeof featureGates.callHoldLive === 'function' && featureGates.callHoldLive();
// The warm transfer (GATE_CALL_WARM_TRANSFER): the one US number a transfer rings (E.164), or null when it is unset or not a
// valid US number (toE164 passes malformed input through, so the result is checked). Never logged.
const transferTarget = () => {
  const target = toE164(process.env.CALL_TRANSFER_TO);
  return target && isValidNanpNumber(target) ? target : null;
};
const masked = (sid) => (sid ? `…${String(sid).slice(-6)}` : 'none');
// Errors are logged by code only: a Twilio error message can carry a phone number.
const errorCode = (err) => String(err?.code || err?.status || err?.name || 'error');
const isGone = (err) => err?.status === 404 || Number(err?.code) === 20404;
let requestClient = null;
function client() {
  requestClient = requestClient || new RequestClient({ timeout: REQUEST_TIMEOUT_MS });
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { httpClient: requestClient });
}
const publicUrl = (path) => `https://${process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com'}${path}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------
// The planner: pure. (hold, event) -> { next, answer }. `next === hold` means nothing is written.
// ---------------------------------------------------------------------------------------------------------

const secondsSince = (iso, nowMs) => Math.max(0, Math.round((nowMs - Date.parse(iso || '')) / 1000)) || 0;
const isoAt = (nowMs) => new Date(nowMs).toISOString();

// A transfer that is ringing and not yet expired.
const transferRinging = (t, nowMs) => t?.status === 'ringing' && secondsSince(t.at, nowMs) < TRANSFER_EXPIRY_SEC;
// The owner's call to end when a decision leaves a ringing transfer behind (null: none, or not placed yet).
const ringingLegOf = (hold) => (hold?.transfer?.status === 'ringing' ? hold.transfer.leg_sid || null : null);
const withCancel = (out, legSid) => (legSid ? { ...out, cancelLegSid: legSid } : out);
const endTransferState = (t, status, reason, nowMs) => ({ ...t, status, ended_at: isoAt(nowMs), end_reason: reason });

// No hold, or one that is over: the caller is back (confirmed), or the star that opened it was aborted.
const isIdle = (hold) => !hold?.phase || (hold.phase === 'returned' && (hold.applied === 'returned' || hold.ret_by === 'abort'));

function planStar(hold, ev, nowMs) {
  if (hold?.phase === 'voicemail') return { next: hold, answer: 'no_room' };
  // Held, or a press 1 return still in flight: a duplicate or redelivered star. It replaces nothing.
  if (!isIdle(hold)) return { next: hold, answer: 'held' };
  const prev = hold || {};
  return {
    next: {
      gen: (Number(prev.gen) || 0) + 1,
      phase: 'held',
      applied: null,
      ret_by: null,
      open_at: isoAt(nowMs),
      by: ev.by || 'star',
      leg_sid: ev.legSid || null,
      count: (Number(prev.count) || 0) + 1,
      total_sec: Number(prev.total_sec) || 0,
      reminded_at: null,
      voicemail_at: null,
      voicemail_reason: null,
      vm_failed: false,
      gone: false,
      rec_pending: false, // this hold pauses the recording again
      alert_pending: false,
      vm_answered_at: null,
      sender: prev.sender || null,
      // The transfers placed on this call so far, across holds: each transfer's n is unique on the call, so a late
      // callback of an earlier hold's transfer never matches this hold's.
      transfers: Math.max(Number(prev.transfers) || 0, Number(prev.transfer?.n) || 0),
    },
    answer: 'start',
  };
}

// The caller comes off hold: the wanted phase becomes 'returned' (ret_by says who asked for it).
const toReturned = (hold, retBy, nowMs) => ({
  ...hold, phase: 'returned', ret_by: retBy, total_sec: (Number(hold.total_sec) || 0) + secondsSince(hold.open_at, nowMs),
});

// A press 1 while a transfer rings cancels it: the owner's call is ended (cancelLegSid), the staff go back.
function planPressOne(hold, nowMs) {
  if (isIdle(hold)) return { next: hold, answer: 'closed' };
  if (hold.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  if (hold.phase === 'returned') return { next: hold, answer: 'return' };
  const next = toReturned(hold, 'press1', nowMs);
  if (!transferRinging(hold.transfer, nowMs)) return { next, answer: 'return' };
  return withCancel({ next: { ...next, transfer: endTransferState(hold.transfer, 'canceled', 'staff_back', nowMs) }, answer: 'return' }, hold.transfer.leg_sid);
}

// The caller goes to voicemail: the limit, or the staff phone is gone.
// A transfer still ringing ends with it (the caller of this carries cancelLegSid, so the owner's call is ended too).
function toVoicemail(hold, reason, nowMs) {
  const total = hold.phase === 'held' ? (Number(hold.total_sec) || 0) + secondsSince(hold.open_at, nowMs) : Number(hold.total_sec) || 0;
  const next = { ...hold, phase: 'voicemail', voicemail_reason: reason, voicemail_at: isoAt(nowMs), total_sec: total };
  if (hold.transfer?.status === 'ringing') next.transfer = endTransferState(hold.transfer, 'failed', 'voicemail', nowMs);
  return next;
}

// The loops' check: the 5 minute limit sends the caller to voicemail while the hold is held (a decided return
// means the staff are there, so it waits); the 3 minute reminder is said once per hold.
// A transfer that rings past its expiry fails first; when the staff already left, the caller goes to voicemail
// (transfer_unanswered). The limit and the reminder then run on the result.
function planCheck(hold, ev, nowMs) {
  if (hold?.phase !== 'held') return { next: hold, answer: { remind: false } };
  const ringingLeg = ringingLegOf(hold);
  let cur = hold;
  let expiredLeg = null;
  if (hold.transfer?.status === 'ringing' && !transferRinging(hold.transfer, nowMs)) {
    cur = { ...hold, transfer: endTransferState(hold.transfer, 'failed', 'expired', nowMs) };
    expiredLeg = ringingLeg;
    if (hold.transfer.from_left_at) return withCancel({ next: toVoicemail(cur, 'transfer_unanswered', nowMs), answer: { remind: false } }, expiredLeg);
  }
  const seconds = secondsSince(cur.open_at, nowMs);
  if (seconds >= HOLD_LIMIT_SEC) return withCancel({ next: toVoicemail(cur, 'timeout', nowMs), answer: { remind: false } }, ringingLeg);
  if (ev.remind && seconds >= HOLD_REMINDER_SEC && !cur.reminded_at) {
    return withCancel({ next: { ...cur, reminded_at: isoAt(nowMs) }, answer: { remind: true } }, expiredLeg);
  }
  return withCancel({ next: cur, answer: { remind: false } }, expiredLeg);
}

// The staff leg ended: during a hold, or during a return in flight (the staff are gone), the caller goes to
// voicemail. A hold that is over leaves today's room end to the caller of this ('ordinary').
// A transfer ringing while the caller is held defers the voicemail: the owner's answer decides (from_left_at).
function planStaffLeft(hold, nowMs, closed) {
  if (closed || isIdle(hold)) return { next: hold, answer: 'ordinary' };
  if (hold.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  if (hold.phase === 'held' && transferRinging(hold.transfer, nowMs)) {
    if (hold.transfer.from_left_at) return { next: hold, answer: 'transfer_pending' };
    return { next: { ...hold, transfer: { ...hold.transfer, from_left_at: isoAt(nowMs) } }, answer: 'transfer_pending' };
  }
  return withCancel({ next: toVoicemail(hold, 'staff_left', nowMs), answer: 'voicemail' }, ringingLegOf(hold));
}

// ---- The warm transfer (pure) ----

function planTransferStart(hold, ev, nowMs, closed) {
  if (hold?.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  if (closed || hold?.phase !== 'held') return { next: hold, answer: 'not_held' };
  if (transferRinging(hold.transfer, nowMs)) return { next: hold, answer: 'busy' };
  const n = Math.max(Number(hold.transfers) || 0, Number(hold.transfer?.n) || 0) + 1; // unique on the call
  const transfer = {
    n, status: 'ringing', leg_sid: null, from_leg_sid: ev.legSid || null, from_name: ev.fromName || null,
    at: isoAt(nowMs), ended_at: null, end_reason: null, from_left_at: null, accepted_at: null,
  };
  return { next: { ...hold, transfers: n, transfer }, answer: 'start' };
}

// The owner's call was placed: record its SID. A transfer that ended meanwhile (or another n) is stale: the caller ends the call.
// His leg already the winning leg (he took the call before this write landed): the placement is done, and his call is
// never ended.
function planTransferPlaced(hold, ev, winner = null) {
  const t = hold?.transfer;
  if (ev.legSid && ev.legSid === winner) return { next: hold, answer: 'ok' };
  if (!t || t.n !== ev.n || t.status !== 'ringing' || t.leg_sid) return { next: hold, answer: 'stale' };
  return { next: { ...hold, transfer: { ...t, leg_sid: ev.legSid } }, answer: 'ok' };
}

// The owner pressed 1. The caller comes off hold as a press 1 return (ret_by 'transfer', NOT planPressOne: that cancels a
// ringing transfer), and the result carries acceptedLegSid so the same write makes his leg the winning leg.
function planTransferAccept(hold, ev, nowMs, closed) {
  const t = hold?.transfer;
  if (hold?.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  // A closed call (the caller hung up) has no room to join, also on a re-press or a retry after he took it.
  if (closed) return { next: hold, answer: 'closed' };
  if (t?.status === 'accepted' && t.leg_sid === ev.legSid) return { next: hold, answer: 'return' };
  if (!t || t.n !== ev.n || !transferRinging(t, nowMs) || (t.leg_sid && t.leg_sid !== ev.legSid) || hold.phase !== 'held') return { next: hold, answer: 'over' };
  const accepted = { ...t, status: 'accepted', leg_sid: ev.legSid, accepted_at: isoAt(nowMs) };
  return { next: { ...toReturned(hold, 'transfer', nowMs), transfer: accepted }, answer: 'return', acceptedLegSid: ev.legSid };
}

// The owner's call ended without a press 1 (or was never placed). With the staff gone, the caller goes to voicemail.
function planTransferEnd(hold, ev, nowMs, closed, winner = null) {
  // He took the call between the status callback's read and this decision: his leg is the winner, so its end is the
  // winner's end ('winner'; the caller of this hands it on), never a transfer nobody took.
  if (ev.legSid && ev.legSid === winner) return { next: hold, answer: 'winner' };
  const t = hold?.transfer;
  const matches = t && t.n === ev.n && t.status === 'ringing' && (!ev.legSid || !t.leg_sid || t.leg_sid === ev.legSid);
  if (!matches) return { next: hold, answer: 'stale' };
  const next = { ...hold, transfer: endTransferState(t, 'failed', ev.reason || null, nowMs) };
  if (t.from_left_at && hold.phase === 'held' && !closed) return { next: toVoicemail(next, 'transfer_unanswered', nowMs), answer: 'voicemail' };
  return { next, answer: 'failed' };
}

const APPLIED_BY_STEP = { hold: 'held', rehold: 'held', return: 'returned', voicemail: 'voicemail' };

// A confirmed return records whether its recording resume was confirmed too (resumed === false keeps step 'resume'
// wanted). It stays pending only while the phase is still 'returned': a voicemail decided meanwhile resumes the
// recording itself (/call-complete?conf=1). A confirmed voicemail (room ended, caller not gone) wants its bell.
function planStepDone(hold, ev, nowMs) {
  if (!hold || hold.gen !== ev.gen) return { next: hold, answer: null };
  const done = { ...hold, last_error_code: null };
  if (ev.step === 'resume') return { next: hold.rec_pending ? { ...done, rec_pending: false } : hold, answer: null };
  if (ev.step === 'alert') return { next: hold.alert_pending ? { ...done, alert_pending: false, alerted_at: isoAt(nowMs) } : hold, answer: null };
  return {
    next: {
      ...done,
      applied: APPLIED_BY_STEP[ev.step],
      vm_failed: false,
      gone: Boolean(ev.gone),
      rec_pending: ev.step === 'return' ? ev.resumed === false && hold.phase === 'returned' : Boolean(hold.rec_pending),
      // A room end whose answer was lost reads as no room on its retry; the voicemail answer (vm_answered_at) still
      // wants the bell. A delivered bell is never wanted again.
      alert_pending: ev.step === 'voicemail' ? !hold.alerted_at && (!ev.gone || Boolean(hold.vm_answered_at)) : Boolean(hold.alert_pending),
    },
    answer: null,
  };
}

function planStepFailed(hold, ev) {
  if (!hold || hold.gen !== ev.gen) return { next: hold, answer: null };
  const base = { ...hold, last_error_code: ev.code || null };
  // The star's hold request failed (or the room is gone): the hold is aborted and the staff go back in the room.
  // A later sender unholds the caller in case the request landed after all.
  if (ev.step === 'hold' && hold.phase === 'held' && hold.applied !== 'held') {
    return { next: { ...base, phase: 'returned', ret_by: 'abort', gone: Boolean(ev.gone) }, answer: null };
  }
  if (ev.step === 'voicemail') return { next: { ...base, vm_failed: hold.applied !== 'held' }, answer: null };
  // A resume Twilio will never accept ends the pending state; any other failure leaves it pending. A bell that was
  // not delivered stays pending too.
  if (ev.step === 'resume' && TERMINAL_RESUME_CODES.has(String(ev.code))) return { next: { ...base, rec_pending: false }, answer: null };
  return { next: base, answer: null };
}

// A star that waited too long for its hold request: abort it (the same as a failed request). A hold another sender
// confirmed after the star's last read is not aborted: 'held' (the caller is on hold, the staff go to the menu).
function planAbort(hold, ev) {
  if (!hold || hold.gen !== ev.gen || hold.phase !== 'held') return { next: hold, answer: null };
  if (hold.applied === 'held') return { next: hold, answer: 'held' };
  return { next: { ...hold, phase: 'returned', ret_by: 'abort' }, answer: 'aborted' };
}

// /call-complete?conf=1 answered the hold voicemail: the room is over and the caller is in the voicemail, whatever the
// room-end step's own answer said (one whose answer was lost reads as no room on its retry, and that retry would mark
// the caller gone). The bell is wanted once: 'alert' while it is not yet delivered.
function planVoicemailAnswered(hold, nowMs) {
  if (hold?.phase !== 'voicemail') return { next: hold, answer: null };
  if (hold.alerted_at) return { next: hold, answer: null };
  if (hold.vm_answered_at) return { next: hold, answer: hold.alert_pending ? 'alert' : null };
  return { next: { ...hold, applied: 'voicemail', vm_failed: false, alert_pending: true, vm_answered_at: isoAt(nowMs) }, answer: 'alert' };
}

// `winner` is the call's winning leg (conference_path.accepted_leg_sid) as read under the lock: a warm transfer the owner
// takes moves it in the same write as his accept, so a leg end or a placement decided after that sees the new one.
// The events a staff leg sends about itself: a menu key (press 1, press 2) and its own end. From a leg that is no longer
// the call's winner (the staff who pressed 2, after the owner took the call: a key in their wait loop, also during a later
// hold of his, or their leg's end read as the winner's just before his accept) it changes nothing: they can neither return
// nor transfer his hold, nor end the room. The routes join them as staff-2. No leg named, or no winner stored, decides as
// before.
const LEG_EVENTS = new Set(['press1', 'transfer_start', 'staff_left']);
const notWinner = (ev, winner) => Boolean(LEG_EVENTS.has(ev.type) && ev.legSid && winner && ev.legSid !== winner);

function planEvent(hold, ev, nowMs, closed, winner = null) {
  if (notWinner(ev, winner)) return { next: hold, answer: 'not_winner' };
  switch (ev.type) {
    case 'star': return closed ? { next: hold, answer: 'no_room' } : planStar(hold, ev, nowMs);
    case 'press1': return planPressOne(hold, nowMs);
    case 'check': return planCheck(hold, ev, nowMs);
    case 'staff_left': return planStaffLeft(hold, nowMs, closed);
    case 'step_done': return planStepDone(hold, ev, nowMs);
    case 'step_failed': return planStepFailed(hold, ev);
    case 'abort': return planAbort(hold, ev);
    // The sweep found the call over: no resume can land on its recording.
    case 'resume_over': return { next: hold?.rec_pending ? { ...hold, rec_pending: false } : hold, answer: null };
    case 'vm_answered': return planVoicemailAnswered(hold, nowMs);
    case 'transfer_start': return planTransferStart(hold, ev, nowMs, closed);
    case 'transfer_placed': return planTransferPlaced(hold, ev, winner);
    case 'transfer_accept': return planTransferAccept(hold, ev, nowMs, closed);
    case 'transfer_end': return planTransferEnd(hold, ev, nowMs, closed, winner);
    default: return { next: hold, answer: null };
  }
}

// The step the wanted state needs next, or null. 'rehold' puts a caller whose voicemail step failed back on
// hold (the caller is not held, so no facts loop would run to retry it). 'resume' finishes a return whose recording
// resume was not confirmed; 'alert' raises the callback bell of a confirmed voicemail. Neither blocks a new decision.
function nextStep(hold) {
  if (!hold?.phase) return null;
  const { phase, applied } = hold;
  if (phase === 'held') return applied === 'held' ? null : 'hold';
  if (phase === 'returned') {
    if (applied !== 'returned') return 'return';
    return hold.rec_pending ? 'resume' : null;
  }
  if (applied === 'voicemail') return hold.alert_pending ? 'alert' : null;
  return hold.vm_failed && applied !== 'held' ? 'rehold' : 'voicemail';
}

// Decide the next step AND take the lease in the same stamp. A step another sender holds a live lease on is
// 'busy'; an expired lease is taken over. Any answer that sends nothing clears this pass's own lease.
function planClaim(hold, token, nowMs, closed) {
  const mine = hold?.sender?.token === token;
  const clearMine = (h) => (mine ? { ...h, sender: null } : h);
  const wanted = nextStep(hold);
  // A closed call (the caller's call ended) sends nothing to Twilio, and no resume can land on its recording; its
  // voicemail bell is still raised (no Twilio request).
  if (closed && wanted === 'resume') return { res: { send: null }, next: { ...clearMine(hold), rec_pending: false } };
  const step = closed && wanted !== 'alert' ? null : wanted;
  if (!step) return { res: { send: null }, next: clearMine(hold) };
  const lease = hold.sender;
  if (lease && lease.token !== token && Number(lease.until) > nowMs) return { res: { send: null, busy: true }, next: hold };
  return { res: { send: step, gen: hold.gen, reason: hold.voicemail_reason }, next: { ...hold, sender: { token, until: nowMs + LEASE_MS } } };
}

// ---------------------------------------------------------------------------------------------------------
// The decision point: a short transaction under the per-call advisory lock.
// ---------------------------------------------------------------------------------------------------------

function holdFrom(state) {
  const hold = state?.hold;
  return hold && typeof hold === 'object' ? hold : null;
}

// An accepted transfer also makes the owner's leg the call's winning leg: one UPDATE, so both commit or neither does.
function writeHold(conn, callSid, hold, acceptedLegSid = null) {
  const holdSql = "jsonb_set(metadata, '{conference_path,hold}', ?::jsonb, true)";
  const metadata = acceptedLegSid
    ? conn.raw(`jsonb_set(${holdSql}, '{conference_path,accepted_leg_sid}', ?::jsonb, true)`, [JSON.stringify(hold), JSON.stringify(acceptedLegSid)])
    : conn.raw(holdSql, [JSON.stringify(hold)]);
  return conn('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'conference_path') IS NOT NULL")
    .update({ metadata, updated_at: new Date() });
}

// fn(hold, closed) -> { next, answer, ... }; the write (when next changed) commits with the lock released.
async function withHoldLock(callSid, fn) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`call_hold:${callSid}`]);
    const state = conferencePath.readState(await trx('call_log').where('twilio_call_sid', callSid).first('metadata'));
    if (!state) return { answer: 'no_state', next: null };
    const hold = holdFrom(state);
    const out = fn(hold, Boolean(state.closed_at), state.accepted_leg_sid || null);
    if (out.next !== hold) await writeHold(trx, callSid, out.next, out.acceptedLegSid);
    return out;
  });
}

const decide = (callSid, ev) => withHoldLock(callSid, (hold, closed, winner) => planEvent(hold, ev, Date.now(), closed, winner));

const transferView = (t) => (t
  ? { n: t.n, status: t.status, ringing: transferRinging(t, Date.now()), legSid: t.leg_sid || null, fromName: t.from_name || null }
  : null);

// What the routes read: the wanted phase, what Twilio confirmed, and the times. A read error answers { error }.
function viewOf(state) {
  const hold = holdFrom(state);
  return {
    found: Boolean(state),
    closed: Boolean(state?.closed_at),
    gen: hold?.gen || 0,
    phase: hold?.phase || null,
    applied: hold?.applied || null,
    retBy: hold?.ret_by || null,
    gone: Boolean(hold?.gone),
    open: hold?.phase === 'held',
    openAt: hold?.open_at || null,
    voicemailAt: hold?.voicemail_at || null,
    reason: hold?.voicemail_reason || null,
    transfer: transferView(hold?.transfer),
    // The call's winning leg, across holds: after a warm transfer it is the owner's leg (the routes join any other leg
    // as a second staff).
    winnerLegSid: state?.accepted_leg_sid || null,
  };
}

async function holdState(callSid) {
  try {
    return viewOf(await conferencePath.loadState(callSid));
  } catch (err) {
    logger.warn(`[call-hold] state read failed for ${masked(callSid)} (${errorCode(err)})`);
    return { found: false, open: true, closed: false, phase: 'held', applied: 'held', error: true };
  }
}

// Seconds the open hold has lasted, or 0 when none is open.
const heldSeconds = (state) => (state?.phase === 'held' && state.openAt ? secondsSince(state.openAt, Date.now()) : 0);

// ---------------------------------------------------------------------------------------------------------
// The sender: one step at a time, the lease holder only.
// ---------------------------------------------------------------------------------------------------------

// The open room of the call: its SID, or null when the caller's room is gone. Throws on a REST error.
async function findRoomSid(callSid) {
  const rooms = await client().conferences.list({ friendlyName: conferencePath.roomFor(callSid), status: 'in-progress', limit: 5 });
  return rooms?.[0]?.sid || null;
}

// True when the caller's room is open. A lookup error answers true: the staff rejoin rather than hang up.
async function roomIsOpen(callSid) {
  try {
    return Boolean(await findRoomSid(callSid));
  } catch (err) {
    logger.warn(`[call-hold] room lookup failed for ${masked(callSid)} (${errorCode(err)})`);
    return true;
  }
}

async function pauseRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'paused', pauseBehavior: 'silence' });
  } catch (err) {
    logger.error(`[call-hold] recording not paused for ${masked(callSid)} (${errorCode(err)}); the hold stays`);
  }
}

async function sendResume(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'in-progress' });
    return { ok: true };
  } catch (err) {
    logger.error(`[call-hold] recording NOT resumed for ${masked(callSid)} (${errorCode(err)}); the rest of the recording is silent until a retry`);
    return { ok: false, code: errorCode(err) };
  }
}

// { ok: true } when Twilio accepted the resume; { ok: true, deferred: true } when a card-pause window holds the
// recording (live-call-card-pause.js: the hold sends nothing inside one, and the window's own end resumes it) or a
// newer hold holds the caller (a star decided while this resume was on its way: that hold's return resumes it); else
// { ok: false, code }. The resume goes out as the card pause's lease holder, so a card pause decided meanwhile lands
// after it. A card-pause request in flight ('card_busy') or a failed check ('card_check') is a failure the pending
// resume retries. Never throws.
async function resumeOutcome(callSid) {
  let out;
  try {
    out = await cardPause.resumeOutsideCardWindow(callSid, () => sendResume(callSid));
  } catch (err) {
    logger.error(`[call-hold] recording resume for ${masked(callSid)} not sent: the card-pause check failed (${errorCode(err)})`);
    return { ok: false, code: 'card_check' };
  }
  if (out.sent) return out.ok ? { ok: true } : { ok: false, code: out.code };
  if (out.reason === 'card_window') {
    logger.info(`[call-hold] recording resume for ${masked(callSid)} left to the card pause: its window is open`);
    return { ok: true, deferred: true };
  }
  if (out.reason === 'hold_held') {
    logger.info(`[call-hold] recording resume for ${masked(callSid)} not sent: a newer hold holds the caller, and its return resumes it`);
    return { ok: true, deferred: true };
  }
  logger.warn(`[call-hold] recording resume for ${masked(callSid)} waits: a card-pause request is in flight`);
  return { ok: false, code: 'card_busy' };
}

// The voicemail's resume (/call-complete?conf=1): true only when the recording runs again. Inside a card-pause window
// it does not, so no message is invited. Never throws.
async function resumeRecording(callSid) {
  const out = await resumeOutcome(callSid);
  return out.ok && !out.deferred;
}

const holdParticipant = (callSid, roomSid) => client().conferences(roomSid).participants(callSid).update({
  hold: true,
  holdUrl: publicUrl(`${WEBHOOK_BASE}/conference-hold-facts?parent=${encodeURIComponent(callSid)}&step=0`),
  holdMethod: 'POST',
});

// Ends every open room of the call. A room that is already gone (404) does not count. Throws on any other error.
async function endOpenRooms(callSid, fence) {
  const api = client();
  const rooms = await api.conferences.list({ friendlyName: conferencePath.roomFor(callSid), status: 'in-progress', limit: 5 });
  let ended = 0;
  for (const room of rooms || []) {
    await fence();
    try {
      await api.conferences(room.sid).update({ status: 'completed' });
      ended += 1;
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  return ended;
}

// One step. { ok, gone } or throws a REST error (or LeaseLost). `gone`: the caller's room is already gone. A return
// also answers `resumed` (the recording resume was confirmed); 'resume' answers `resume` ({ ok, code }); 'alert' answers
// `delivered`. fence() runs right before each request that changes the call (and before the bell is raised).
async function runStep(callSid, step, fence, reason) {
  if (step === 'voicemail') return { ok: true, gone: (await endOpenRooms(callSid, fence)) === 0 };
  if (step === 'alert') {
    await fence();
    return { ok: true, delivered: await raiseVoicemailAlert(callSid, reason) };
  }
  if (step === 'resume') {
    await fence();
    return { ok: true, resume: await resumeOutcome(callSid) };
  }
  const roomSid = await findRoomSid(callSid);
  if (!roomSid) return { ok: false, gone: true };
  let resumed;
  try {
    await fence();
    if (step === 'return') {
      await client().conferences(roomSid).participants(callSid).update({ hold: false });
      await fence();
      resumed = (await resumeOutcome(callSid)).ok;
    } else {
      await holdParticipant(callSid, roomSid);
      if (step === 'hold') {
        await fence();
        await pauseRecording(callSid);
      }
    }
  } catch (err) {
    if (isGone(err)) return { ok: false, gone: true };
    throw err;
  }
  return { ok: true, gone: false, resumed };
}

// Commit the decision (and the lease with it) before any Twilio request is sent.
const claimStep = (callSid, token) => withHoldLock(callSid, (hold, closed) => {
  const { res, next } = planClaim(hold, token, Date.now(), closed);
  return { ...res, next: hold ? next : hold };
});

// Give the lease back when a pass stops without a claim that cleared it. It expires by itself otherwise.
async function releaseLease(callSid, token) {
  try {
    await withHoldLock(callSid, (hold) => (hold?.sender?.token === token ? { next: { ...hold, sender: null } } : { next: hold }));
  } catch (err) {
    logger.warn(`[call-hold] lease release failed for ${masked(callSid)} (${errorCode(err)})`);
  }
}

// This pass's lease was taken over by another sender (the pass stalled past LEASE_MS): it sends nothing more.
class LeaseLost extends Error {}

// Right before each Twilio request that changes the call: one short transaction under the lock checks that this pass
// still holds the lease and extends it. A lease another sender took over throws LeaseLost, so a stalled sender never
// lands a step after the newer one (the same fence as live-call-card-pause.js).
async function fenceLease(callSid, token) {
  const out = await withHoldLock(callSid, (hold) => (hold?.sender?.token === token
    ? { next: { ...hold, sender: { token, until: Date.now() + LEASE_MS } }, kept: true }
    : { next: hold, kept: false }));
  if (!out.kept) throw new LeaseLost('lease lost');
}

// Record the outcome of one step from the state as it is now (a newer decision may have replaced it meanwhile).
async function recordOutcome(callSid, ev) {
  try {
    await decide(callSid, ev);
  } catch (err) {
    // The wanted state stays unconfirmed, so the next claim sends the step again.
    logger.warn(`[call-hold] step outcome not recorded for ${masked(callSid)} (${errorCode(err)})`);
  }
}

// A failed recording resume is retried in this process after 2, 4, 8 and 16 s (one chain per call, unref'd timers).
// A retry stops once the next step is no longer 'resume' or after the fourth try; recoverPendingHolds is the rest.
const resumeRetries = new Map();

function scheduleResumeRetry(callSid, attempt = 0) {
  if (attempt >= RESUME_BACKOFF_MS.length || resumeRetries.has(callSid)) return;
  const timer = setTimeout(async () => {
    resumeRetries.delete(callSid);
    try {
      await drain(callSid, { retry: false });
      if (nextStep(holdFrom(await conferencePath.loadState(callSid))) === 'resume') scheduleResumeRetry(callSid, attempt + 1);
    } catch (err) {
      logger.warn(`[call-hold] resume retry failed for ${masked(callSid)} (${errorCode(err)})`);
      scheduleResumeRetry(callSid, attempt + 1);
    }
  }, RESUME_BACKOFF_MS[attempt]);
  if (typeof timer.unref === 'function') timer.unref();
  resumeRetries.set(callSid, timer);
}

// The two steps that finish a confirmed decision: the recording resume, and the voicemail's callback bell.
async function settleFollowUp(callSid, { gen, send: step }, out, retry) {
  if (step === 'alert') {
    await recordOutcome(callSid, out.delivered ? { type: 'step_done', gen, step } : { type: 'step_failed', gen, step, code: 'alert' });
    if (!out.delivered) logger.warn(`[call-hold] callback bell not delivered for ${masked(callSid)}; the sweep retries it`);
    return { failed: !out.delivered };
  }
  if (out.resume.ok) {
    await recordOutcome(callSid, { type: 'step_done', gen, step });
    if (!out.resume.deferred) logger.info(`[call-hold] recording resumed for ${masked(callSid)}`);
    return { failed: false };
  }
  await recordOutcome(callSid, { type: 'step_failed', gen, step, code: out.resume.code });
  if (TERMINAL_RESUME_CODES.has(String(out.resume.code))) {
    logger.warn(`[call-hold] recording resume for ${masked(callSid)} dropped: Twilio code ${out.resume.code} cannot be retried`);
    return { failed: false };
  }
  if (retry) scheduleResumeRetry(callSid);
  return { failed: true };
}

// { failed } when the step failed (the loops and the waiters retry it later); { lost } when another sender took the
// lease over (it records nothing: the new lease holder owns the state now).
async function sendStep(callSid, claim, fence, retry) {
  const { gen, send: step } = claim;
  let out;
  try {
    out = await runStep(callSid, step, fence, claim.reason);
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger.warn(`[call-hold] ${step} step stopped for ${masked(callSid)}: another sender took the lease`);
      return { lost: true };
    }
    logger.warn(`[call-hold] ${step} step failed for ${masked(callSid)} (${errorCode(err)})`);
    await recordOutcome(callSid, { type: 'step_failed', gen, step, code: errorCode(err) });
    return { failed: true };
  }
  if (!out.ok) {
    // No room: a star's hold is aborted (the staff go back in the room); a return is over (nobody to unhold); a
    // re-hold means the caller's room is gone, so the voicemail has nothing left to end.
    const done = { type: 'step_done', gen, step: step === 'rehold' ? 'voicemail' : step, gone: true };
    await recordOutcome(callSid, step === 'hold' ? { type: 'step_failed', gen, step, gone: true, code: 'gone' } : done);
    return { failed: step === 'hold', gone: true };
  }
  if (step === 'alert' || step === 'resume') return settleFollowUp(callSid, claim, out, retry);
  await recordOutcome(callSid, { type: 'step_done', gen, step, gone: out.gone, resumed: out.resumed });
  if (step === 'voicemail' && !out.gone) {
    logger.info(`[call-hold] caller ${masked(callSid)} sent to voicemail (${claim.reason})`);
  } else if (step === 'return') {
    logger.info(`[call-hold] caller ${masked(callSid)} back from hold`);
  }
  return { failed: false };
}

// Send what the wanted state needs, then read it again and send again if a newer decision replaced it. One
// token owns the lease for the whole pass. { busy } when another sender holds it (or took it over): this pass sends
// nothing more and nothing waits. A failed step ends the pass, with one exception: a failed voicemail step that left
// the caller unheld and alone in the room is followed by the re-hold (no loop would run for that caller otherwise).
// A re-hold ends the pass too: the facts loop's next fetch retries the voicemail. A failed resume or bell ends the pass
// (a failed resume starts the backoff unless `retry` is false: the backoff's own pass and the sweep).
async function drain(callSid, { retry = true } = {}) {
  const token = crypto.randomUUID();
  const fence = () => fenceLease(callSid, token);
  let holding = false;
  let sent = 0;
  let failed = false;
  try {
    for (let i = 0; i < MAX_SENDS_PER_PASS; i += 1) {
      const claim = await claimStep(callSid, token);
      holding = Boolean(claim.send);
      if (!claim.send || (failed && claim.send !== 'rehold')) return { busy: Boolean(claim.busy), failed, sent };
      const out = await sendStep(callSid, claim, fence, retry);
      sent += 1;
      if (out.lost) {
        holding = false;
        return { busy: true, failed, sent };
      }
      if (claim.send === 'rehold' || (out.failed && claim.send !== 'voicemail')) return { failed: Boolean(out.failed), sent };
      failed = Boolean(out.failed);
    }
    return { failed, sent };
  } catch (err) {
    logger.warn(`[call-hold] send pass failed for ${masked(callSid)} (${errorCode(err)})`);
    return { failed: true, sent };
  } finally {
    if (holding) await releaseLease(callSid, token);
  }
}

// Drain and read until `done(view)` answers, up to WAIT_MS, in WAIT_STEP_MS steps. A step that failed ends the
// wait at once (null). Never throws.
async function settle(callSid, done) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const out = await drain(callSid);
    const view = await holdState(callSid);
    const answer = view.error ? null : done(view);
    if (answer) return answer;
    if (out.failed || Date.now() + WAIT_STEP_MS >= until) return null;
    await sleep(WAIT_STEP_MS);
  }
}

// ---------------------------------------------------------------------------------------------------------
// What the routes call. Each records ONE event, then lets the sender finish; none throws.
// ---------------------------------------------------------------------------------------------------------

// 'held' | 'no_room' | 'failed'. A star. A duplicate or redelivered star while a hold or a return is open is a
// no-op ('held'): it never closes, replaces or restarts anything.
async function startHold(callSid, { by = 'star', legSid = null } = {}) {
  try {
    const decision = await decide(callSid, { type: 'star', by, legSid });
    if (decision.answer === 'no_state') return 'failed';
    if (decision.answer === 'no_room') return 'no_room';
    if (decision.answer === 'held') return 'held';
    const gen = decision.next.gen;
    const result = await settle(callSid, (view) => {
      if (view.gen !== gen || view.phase === 'voicemail') return 'held'; // the staff hung up meanwhile: the menu says so
      if (view.phase === 'held') return view.applied === 'held' ? 'held' : null;
      return view.gone ? 'no_room' : 'failed'; // aborted: the hold request failed
    });
    if (result) {
      if (result === 'held') logger.info(`[call-hold] caller ${masked(callSid)} on hold (${by})`);
      return result;
    }
    // The wait ran out: abort the hold, unless another sender confirmed it after this star's last read.
    const abort = await decide(callSid, { type: 'abort', gen });
    if (abort.answer === 'held') {
      logger.info(`[call-hold] caller ${masked(callSid)} on hold (${by})`);
      return 'held';
    }
    return 'failed';
  } catch (err) {
    logger.warn(`[call-hold] hold not started for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// Ends the owner's ringing call (a decision left a ringing transfer behind). Best effort: never throws, and a call that is
// already over (404) is the expected answer.
async function endTransferCall(legSid) {
  if (!legSid) return;
  try {
    await client().calls(legSid).update({ status: 'completed' });
  } catch (err) {
    logger.info(`[call-hold] transfer call ${masked(legSid)} not ended (${errorCode(err)})`);
  }
}

// What a return waits for: the unhold confirmed, or the voicemail decided first.
function settledReturn(view) {
  if (view.phase === 'voicemail') return 'voicemail';
  if (view.phase === 'returned' && view.applied === 'returned') return view.gone ? 'no_room' : 'returned';
  return null;
}

// 'returned' | 'voicemail' | 'no_room' | 'failed' | 'second_staff'. A press 1: it answers 'returned' only once the unhold is
// confirmed; 'voicemail' when the voicemail is decided; 'failed' (the staff stay on the menu, whose loop finishes
// the return) when it could not be confirmed in time. 'second_staff': the press came from a leg that is no longer the
// call's winner (`legSid`, read under the lock): nothing changed, and the route joins it as staff-2.
async function endHold(callSid, { legSid = null } = {}) {
  try {
    const decision = await decide(callSid, { type: 'press1', legSid });
    if (decision.answer === 'not_winner') return 'second_staff';
    if (decision.answer === 'no_state') return 'failed';
    if (decision.answer === 'closed') return 'returned';
    if (decision.answer === 'voicemail') {
      await drain(callSid);
      return 'voicemail';
    }
    const canceling = endTransferCall(decision.cancelLegSid); // a ringing transfer is canceled: the owner's call ends
    const result = await settle(callSid, settledReturn);
    await canceling;
    return result || 'failed';
  } catch (err) {
    logger.warn(`[call-hold] hold not ended for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// The loops' event: the 5 minute limit, the 3 minute reminder (once), then ONE try at any step the wanted state
// needs. It never waits for the lease: another sender's step is finished by its own pass or the next fetch.
// { ...view, remind }; a read or database error answers { error: true } (the staff stay, the caller keeps the script).
async function checkHold(callSid, { remind = false } = {}) {
  try {
    const decision = await decide(callSid, { type: 'check', remind });
    if (decision.answer === 'no_state') return { found: false, closed: false, phase: null, remind: false };
    const canceling = endTransferCall(decision.cancelLegSid); // the limit, or an expired transfer: the owner's call ends
    if (nextStep(decision.next)) await drain(callSid);
    await canceling;
    return { ...(await holdState(callSid)), remind: decision.answer?.remind === true };
  } catch (err) {
    logger.warn(`[call-hold] hold check failed for ${masked(callSid)} (${errorCode(err)})`);
    return { found: false, open: true, closed: false, phase: 'held', applied: 'held', error: true, remind: false };
  }
}

// 'voicemail' | 'ordinary' | 'transfer_pending' | 'not_winner'. The winning staff leg ended. `legSid` is the leg that ended:
// it is checked against the winning leg under the lock ('not_winner' when a transfer moved the winner meanwhile). A hold open or a return in flight: the caller goes to
// voicemail ('voicemail'; one try here, the facts loop finishes it). Otherwise the ordinary room end runs. A
// database error propagates: the status callback is Twilio's to retry, and ending the room blind could drop a
// held caller.
async function staffLeft(callSid, { legSid = null } = {}) {
  const decision = await decide(callSid, { type: 'staff_left', legSid });
  if (decision.answer === 'not_winner') return 'not_winner'; // the owner took a transfer meanwhile: his leg is the winner
  if (decision.answer === 'transfer_pending') return 'transfer_pending'; // the owner's answer decides: no voicemail, no room end
  if (decision.answer !== 'voicemail') return 'ordinary';
  const canceling = endTransferCall(decision.cancelLegSid);
  await drain(callSid);
  await canceling;
  return 'voicemail';
}

// ---------------------------------------------------------------------------------------------------------
// The warm transfer (see THE WARM TRANSFER above).
// ---------------------------------------------------------------------------------------------------------

// The warm transfer's gate and the hold's, read at call time.
function transferOn() {
  return typeof featureGates.callWarmTransferLive === 'function' && featureGates.callWarmTransferLive() && isEnabled();
}

// The transfer is offered on a menu request: the gate, the hold, a valid CALL_TRANSFER_TO, and a menu leg that is not the
// target (the owner never transfers to himself, including after he took a transfer).
function transferAvailable(menuNumber) {
  const target = transferTarget();
  return Boolean(transferOn() && target && toE164(menuNumber) !== target);
}

// Places the one call to the transfer number. 'ringing' | 'failed'. The caller's own Waves line is the caller ID.
async function placeTransferCall(callSid, n) {
  const row = await db('call_log').where('twilio_call_sid', callSid).first('to_phone');
  const from = toE164(row?.to_phone);
  const to = transferTarget();
  const query = `parent=${encodeURIComponent(callSid)}&n=${n}`;
  let placed;
  try {
    if (!from || !to) throw Object.assign(new Error('no number'), { code: 'no_number' });
    placed = await client().calls.create({
      to,
      from,
      url: publicUrl(`${WEBHOOK_BASE}/conference-transfer-answer?${query}`),
      method: 'POST',
      timeout: TRANSFER_RING_SEC,
      statusCallback: publicUrl(`${WEBHOOK_BASE}/conference-transfer-status?${query}`),
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
    });
  } catch (err) {
    logger.warn(`[call-hold] transfer call not placed for ${masked(callSid)} (${errorCode(err)})`);
    await decide(callSid, { type: 'transfer_end', n, legSid: null, reason: 'not_placed' });
    return 'failed';
  }
  let recorded;
  try {
    recorded = await decide(callSid, { type: 'transfer_placed', n, legSid: placed.sid });
  } catch (err) {
    // The call is out and rings; its answer route needs no SID. Only a cancel could not reach it (its ring ends in 20 s).
    logger.warn(`[call-hold] transfer call ${masked(placed.sid)} not recorded for ${masked(callSid)} (${errorCode(err)})`);
    return 'ringing';
  }
  if (recorded.answer === 'ok') return 'ringing';
  await endTransferCall(placed.sid); // the transfer ended while the call was placed
  return 'failed';
}

// 'ringing' | 'busy' | 'not_held' | 'voicemail' | 'failed' | 'second_staff'. The staff pressed 2: one transfer at a time
// per hold. 'second_staff': a press from a leg that is no longer the call's winner places no call.
async function startTransfer(callSid, { legSid = null, fromName = null } = {}) {
  try {
    const decision = await decide(callSid, { type: 'transfer_start', legSid, fromName });
    if (decision.answer === 'not_winner') return 'second_staff';
    if (decision.answer === 'start') {
      logger.info(`[call-hold] transfer ${decision.next.transfer.n} asked for ${masked(callSid)}`);
      return await placeTransferCall(callSid, decision.next.transfer.n);
    }
    return ['busy', 'not_held', 'voicemail'].includes(decision.answer) ? decision.answer : 'failed';
  } catch (err) {
    logger.warn(`[call-hold] transfer not started for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// 'returned' | 'voicemail' | 'over' | 'no_room' | 'failed'. The owner pressed 1: the caller comes off hold as a press 1
// return does, and his leg becomes the winning leg in the same write. A re-press or a redelivery settles again.
async function acceptTransfer(callSid, { n, legSid }) {
  try {
    const decision = await decide(callSid, { type: 'transfer_accept', n, legSid });
    if (decision.answer === 'voicemail') {
      await drain(callSid);
      return 'voicemail';
    }
    if (decision.answer === 'closed') return 'no_room';
    if (decision.answer === 'over') return 'over';
    if (decision.answer !== 'return') return 'failed';
    if (decision.acceptedLegSid) logger.info(`[call-hold] transfer ${n} taken for ${masked(callSid)}`);
    // The caller can hang up while the unhold is confirmed: no room to join, so the owner's retry loop ends.
    return (await settle(callSid, (view) => (view.closed ? 'no_room' : settledReturn(view)))) || 'failed';
  } catch (err) {
    logger.warn(`[call-hold] transfer not accepted for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// The owner's call ended without a press 1. Answers the planner's: 'failed' | 'voicemail' | 'stale' | 'winner' (his leg
// became the winning leg before this decision: the caller hands the end to the winner's end). A database error
// propagates (the status callback's retry in call-conference-path.js finishes it), as staffLeft does.
async function endTransfer(callSid, { n, legSid = null, reason = null }) {
  const decision = await decide(callSid, { type: 'transfer_end', n, legSid, reason });
  if (decision.answer === 'voicemail') await drain(callSid);
  return decision.answer;
}

// The alert says who to call back: the customer on the call, else the one name on file for the number.
async function callerNameFor(call) {
  const { realName, nameOnFileForPhone } = require('./admin-alert-names');
  try {
    if (call.customer_id) return realName(await db('customers').where('id', call.customer_id).first('first_name', 'last_name'));
    return await nameOnFileForPhone(db, call.from_phone);
  } catch (err) {
    logger.warn(`[call-hold] caller name lookup failed (${errorCode(err)})`);
    return null;
  }
}

const VOICEMAIL_WHY = {
  timeout: 'Waited 5 minutes on hold, then went to voicemail.',
  staff_left: 'The staff phone hung up during a hold; the caller went to voicemail.',
  transfer_unanswered: 'A transfer was not answered after the staff hung up; the caller went to voicemail.',
};

// One bell per call (dedupeKey on the CallSid). true only when a row was written (an id) or the bell was suppressed on
// purpose; a null answer (notifyAdmin resolves null when its database write fails) or a throw is NOT delivered: step
// 'alert' stays pending and the sweep retries it. A failure is logged by code and never stops the voicemail.
async function raiseVoicemailAlert(callSid, reason) {
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first('id', 'customer_id', 'from_phone');
    if (!call) return false;
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const name = await callerNameFor(call);
    const written = await raiseAdminAlert('voicemail_callback', {
      area: 'Comms',
      action: name ? fitAction('Comms', name, [(n) => `call ${n} back`]) : 'call back an unknown caller',
      why: VOICEMAIL_WHY[reason] || VOICEMAIL_WHY.timeout,
      severity: 'needs-you',
      link: `/admin/communications#tab=calls&call=${encodeURIComponent(call.id)}`,
      subject: { type: 'call', id: String(call.id) },
      doneWhen: 'caller_reached',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `call-hold-voicemail:${callSid}`,
      // payload = what the relevance sweep reads (class hold_voicemail): the caller's number, and no call id, so the
      // bell is judged from its own time and closes once a person reaches the caller after it.
      metadata: { callLogId: call.id, reason, payload: { customerId: call.customer_id || null, phone: call.from_phone || null } },
    });
    const delivered = Boolean(written && (written.id || written.suppressed));
    if (!delivered) logger.error(`[call-hold] voicemail alert not written for ${masked(callSid)}`);
    return delivered;
  } catch (err) {
    logger.error(`[call-hold] voicemail alert not raised for ${masked(callSid)} (${errorCode(err)})`);
    return false;
  }
}

// /call-complete?conf=1 is answering the hold voicemail: marks the one office bell wanted and raises it (the lease path;
// a busy lease leaves it to that sender's next claim or to the sweep). Never throws.
async function voicemailAnswered(callSid) {
  try {
    const out = await decide(callSid, { type: 'vm_answered' });
    if (out.answer === 'alert') await drain(callSid, { retry: false });
  } catch (err) {
    logger.warn(`[call-hold] voicemail answer not recorded for ${masked(callSid)} (${errorCode(err)})`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// A hold the server asks for: the Live call panel's Hold button or the spoken trigger (see THE HOLD BUTTON above).
// ---------------------------------------------------------------------------------------------------------

// The panel's view of a call's hold (GET /live). null off the conference ring and before a staff press 1, else:
//   on_hold   a hold is open (held, or a press 1 return Twilio has not confirmed yet); since = when it opened;
//   can_hold  the Hold button works now: answered, the room open, no hold in progress, no voicemail.
function holdForPanel(state) {
  if (!state?.accepted_leg_sid) return null;
  const hold = state.hold || null;
  if (state.closed_at || state.voicemail_at || hold?.phase === 'voicemail') return { can_hold: false, on_hold: false, since: null };
  if (isIdle(hold)) return { can_hold: true, on_hold: false, since: null };
  return { can_hold: false, on_hold: true, since: hold.open_at || null };
}

// Who may ask the star route for a hold besides a star: the Live call panel's Hold button and the spoken "please
// hold" (call-hold-voice.js). The route reads its `by` query the same way.
const REQUEST_BY = new Set(['button', 'voice']);

// 'requested' | 'on_hold' | 'unavailable' | 'stale' | 'failed'. The REST move of the winning staff leg to the star route; the
// hold itself is then the star's (it answers before the hold is confirmed: the panel's next poll shows it). A move
// of a leg that already hung up is refused by Twilio: 'failed', and nothing changed. Never throws.
// `spokenAt` (the voice trigger only): the time of the speech that asks. Speech from before the newest hold opened asks
// for a hold that already happened (a late transcript after a star and a press 1): 'stale', and nothing is moved.
async function requestHold(callSid, { by, spokenAt = null } = {}) {
  if (!isEnabled() || !REQUEST_BY.has(by) || !conferencePath.CALL_SID_RE.test(String(callSid || ''))) return 'unavailable';
  try {
    const state = await conferencePath.loadState(callSid);
    const view = holdForPanel(state);
    if (view?.on_hold) return 'on_hold';
    if (!view?.can_hold) return 'unavailable';
    if (spokenAt && Date.parse(state.hold?.open_at || '') >= new Date(spokenAt).getTime()) return 'stale';
    await client().calls(state.accepted_leg_sid).update({
      url: publicUrl(`${WEBHOOK_BASE}/conference-staff-left?parent=${encodeURIComponent(callSid)}&by=${by}`),
      method: 'POST',
    });
    logger.info(`[call-hold] hold asked for ${masked(callSid)} (${by})`);
    return 'requested';
  } catch (err) {
    logger.warn(`[call-hold] hold request failed for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------------------
// The recovery sweep (scheduler.js, every minute, whatever the gates say: it only finishes work already started).
// ---------------------------------------------------------------------------------------------------------

let sweeping = false;

async function recoverRow(row) {
  const callSid = row.twilio_call_sid;
  if (!callSid) return;
  const recPending = row.rec_pending === 'true';
  const ended = TERMINAL_CALL_STATUSES.has(String(row.status || '')) || Boolean(row.ended_at);
  // The call is over: no resume can land on its recording. Cleared under the lock, with no Twilio request.
  if (recPending && ended) {
    await decide(callSid, { type: 'resume_over' });
    logger.warn(`[call-hold] pending recording resume for ${masked(callSid)} dropped: the call is over`);
  }
  // Everything else goes through the lease path, like any other pass: two processes send one resume and raise one bell.
  if (row.alert_pending === 'true' || (recPending && !ended)) await drain(callSid, { retry: false });
}

// Calls of the last 6 hours with a pending recording resume or a pending callback bell, newest first, at most 25. An
// idle sweep is this one read (no transaction). Errors are logged by code and never thrown.
async function recoverPendingHolds() {
  if (sweeping) return { action: 'busy' };
  sweeping = true;
  try {
    const rows = await db('call_log')
      .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb))
      .where('created_at', '>', new Date(Date.now() - SWEEP_LOOKBACK_MS))
      .whereRaw("((metadata #>> '{conference_path,hold,rec_pending}') = 'true' OR (metadata #>> '{conference_path,hold,alert_pending}') = 'true')")
      .orderBy('created_at', 'desc')
      .limit(SWEEP_LIMIT)
      .select(
        'twilio_call_sid',
        'status',
        db.raw("metadata ->> 'ended_at' AS ended_at"),
        db.raw("metadata #>> '{conference_path,hold,rec_pending}' AS rec_pending"),
        db.raw("metadata #>> '{conference_path,hold,alert_pending}' AS alert_pending"),
      );
    for (const row of rows) {
      try {
        await recoverRow(row);
      } catch (err) {
        logger.warn(`[call-hold] sweep failed for ${masked(row.twilio_call_sid)} (${errorCode(err)})`);
      }
    }
    return { action: 'swept', open: rows.length };
  } catch (err) {
    logger.warn(`[call-hold] sweep read failed (${errorCode(err)})`);
    return { action: 'error' };
  } finally {
    sweeping = false;
  }
}

module.exports = {
  HOLD_REMINDER_SEC, HOLD_LIMIT_SEC, TRANSFER_RING_SEC, TRANSFER_EXPIRY_SEC, LEASE_MS, isEnabled, startHold, endHold, checkHold, staffLeft,
  holdState, roomIsOpen, heldSeconds, resumeRecording, recoverPendingHolds, voicemailAnswered, requestHold, holdForPanel,
  transferTarget, transferOn, transferAvailable, startTransfer, acceptTransfer, endTransfer,
  _test: { planEvent, planClaim, nextStep, decide, resumeRetries, transferRinging },
};
