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
 *   gone       the caller's room was already gone when a step ran,
 *   sender     { token, until }: the lease of the one sender }.
 *
 * SENDS. Only the lease holder talks to Twilio for a call, one step at a time (participant hold + recording
 * pause | unhold + recording resume | end the room), across every server process. claimStep decides the next
 * step from the wanted state AND takes or renews the lease in the same stamp; after each step the outcome is
 * recorded from the state as it is NOW and the state is read again, so a newer decision gets its own step
 * before the lease is released. Twilio therefore sees the steps in decision order and the last step matches the
 * newest decision: a pause can never land after a resume, and a voicemail can never end a room a return is
 * working on. A crashed sender's lease expires (LEASE_MS) and the next fetch of a loop finishes the step.
 *
 * WHAT FINISHES A WANTED STATE (no wanted state is left without an actor):
 *   held, not confirmed    the star request itself (it waits for the step, then aborts the hold on a failure or
 *                          a timeout: the staff go back in the room and a later sender unholds the caller);
 *   returned, not confirmed  the press 1 request (waits up to WAIT_MS); then the staff menu loop (every ~15 s,
 *                          the staff are still on it); if the staff hung up instead, that is a voicemail event;
 *   voicemail, not confirmed the caller on hold: the facts loop (every ~10 s); the caller not on hold (a return
 *                          finished first, or a voicemail step failed): the sender re-holds the caller so the
 *                          facts loop exists again, and the staff-left handler tries once itself.
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
const conferencePath = require('./call-conference-path');

const WEBHOOK_BASE = '/api/webhooks/twilio';
// A hold open this long is told to the staff phone (reminder) and sent to voicemail (limit). Owner-approved.
const HOLD_REMINDER_SEC = 180;
const HOLD_LIMIT_SEC = 300;
// A request that takes longer is abandoned (an unknown outcome). A step is up to 3 requests, so the 8 s lease
// is longer than a whole step: 3 x 2.5 s, plus the claim and record transactions around it.
const REQUEST_TIMEOUT_MS = 2500;
const LEASE_MS = 8 * 1000;
// One pass sends at most this many steps (a hold, the return that replaced it, the voicemail that replaced that).
const MAX_SENDS_PER_PASS = 4;
// The press 1 and star requests wait this long (in steps) for a step another sender holds the lease on.
const WAIT_MS = 6 * 1000;
const WAIT_STEP_MS = 250;

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const isEnabled = () => typeof featureGates.callHoldLive === 'function' && featureGates.callHoldLive();
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
      sender: prev.sender || null,
    },
    answer: 'start',
  };
}

function planPressOne(hold, nowMs) {
  if (isIdle(hold)) return { next: hold, answer: 'closed' };
  if (hold.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  if (hold.phase === 'returned') return { next: hold, answer: 'return' };
  const total = (Number(hold.total_sec) || 0) + secondsSince(hold.open_at, nowMs);
  return { next: { ...hold, phase: 'returned', ret_by: 'press1', total_sec: total }, answer: 'return' };
}

// The caller goes to voicemail: the limit, or the staff phone is gone.
function toVoicemail(hold, reason, nowMs) {
  const total = hold.phase === 'held' ? (Number(hold.total_sec) || 0) + secondsSince(hold.open_at, nowMs) : Number(hold.total_sec) || 0;
  return { ...hold, phase: 'voicemail', voicemail_reason: reason, voicemail_at: isoAt(nowMs), total_sec: total };
}

// The loops' check: the 5 minute limit sends the caller to voicemail while the hold is held (a decided return
// means the staff are there, so it waits); the 3 minute reminder is said once per hold.
function planCheck(hold, ev, nowMs) {
  if (hold?.phase !== 'held') return { next: hold, answer: { remind: false } };
  const seconds = secondsSince(hold.open_at, nowMs);
  if (seconds >= HOLD_LIMIT_SEC) return { next: toVoicemail(hold, 'timeout', nowMs), answer: { remind: false } };
  if (ev.remind && seconds >= HOLD_REMINDER_SEC && !hold.reminded_at) {
    return { next: { ...hold, reminded_at: isoAt(nowMs) }, answer: { remind: true } };
  }
  return { next: hold, answer: { remind: false } };
}

// The staff leg ended: during a hold, or during a return in flight (the staff are gone), the caller goes to
// voicemail. A hold that is over leaves today's room end to the caller of this ('ordinary').
function planStaffLeft(hold, nowMs, closed) {
  if (closed || isIdle(hold)) return { next: hold, answer: 'ordinary' };
  if (hold.phase === 'voicemail') return { next: hold, answer: 'voicemail' };
  return { next: toVoicemail(hold, 'staff_left', nowMs), answer: 'voicemail' };
}

const APPLIED_BY_STEP = { hold: 'held', rehold: 'held', return: 'returned', voicemail: 'voicemail' };

function planStepDone(hold, ev) {
  if (!hold || hold.gen !== ev.gen) return { next: hold, answer: null };
  return { next: { ...hold, applied: APPLIED_BY_STEP[ev.step], vm_failed: false, gone: Boolean(ev.gone), last_error_code: null }, answer: null };
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
  return { next: base, answer: null };
}

// A star that waited too long for its hold request: abort it (the same as a failed request).
function planAbort(hold, ev) {
  if (!hold || hold.gen !== ev.gen || hold.phase !== 'held' || hold.applied === 'held') return { next: hold, answer: null };
  return { next: { ...hold, phase: 'returned', ret_by: 'abort' }, answer: null };
}

function planEvent(hold, ev, nowMs, closed) {
  switch (ev.type) {
    case 'star': return closed ? { next: hold, answer: 'no_room' } : planStar(hold, ev, nowMs);
    case 'press1': return planPressOne(hold, nowMs);
    case 'check': return planCheck(hold, ev, nowMs);
    case 'staff_left': return planStaffLeft(hold, nowMs, closed);
    case 'step_done': return planStepDone(hold, ev);
    case 'step_failed': return planStepFailed(hold, ev);
    case 'abort': return planAbort(hold, ev);
    default: return { next: hold, answer: null };
  }
}

// The step the wanted state needs next, or null. 'rehold' puts a caller whose voicemail step failed back on
// hold (the caller is not held, so no facts loop would run to retry it).
function nextStep(hold) {
  if (!hold?.phase) return null;
  const { phase, applied } = hold;
  if (phase === 'held') return applied === 'held' ? null : 'hold';
  if (phase === 'returned') return applied === 'returned' ? null : 'return';
  if (applied === 'voicemail') return null;
  return hold.vm_failed && applied !== 'held' ? 'rehold' : 'voicemail';
}

// Decide the next step AND take the lease in the same stamp. A step another sender holds a live lease on is
// 'busy'; an expired lease is taken over. Any answer that sends nothing clears this pass's own lease.
function planClaim(hold, token, nowMs, closed) {
  const mine = hold?.sender?.token === token;
  const clearMine = (h) => (mine ? { ...h, sender: null } : h);
  const step = closed ? null : nextStep(hold);
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

function writeHold(conn, callSid, hold) {
  return conn('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'conference_path') IS NOT NULL")
    .update({ metadata: conn.raw("jsonb_set(metadata, '{conference_path,hold}', ?::jsonb, true)", [JSON.stringify(hold)]), updated_at: new Date() });
}

// fn(hold, closed) -> { next, answer, ... }; the write (when next changed) commits with the lock released.
async function withHoldLock(callSid, fn) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`call_hold:${callSid}`]);
    const state = conferencePath.readState(await trx('call_log').where('twilio_call_sid', callSid).first('metadata'));
    if (!state) return { answer: 'no_state', next: null };
    const hold = holdFrom(state);
    const out = fn(hold, Boolean(state.closed_at));
    if (out.next !== hold) await writeHold(trx, callSid, out.next);
    return out;
  });
}

const decide = (callSid, ev) => withHoldLock(callSid, (hold, closed) => planEvent(hold, ev, Date.now(), closed));

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

// true when Twilio accepted the resume, false when it did not. Never throws.
async function resumeRecording(callSid) {
  try {
    await client().calls(callSid).recordings('Twilio.CURRENT').update({ status: 'in-progress' });
    return true;
  } catch (err) {
    logger.error(`[call-hold] recording NOT resumed for ${masked(callSid)} (${errorCode(err)}); the rest of the recording is silent`);
    return false;
  }
}

const holdParticipant = (callSid, roomSid) => client().conferences(roomSid).participants(callSid).update({
  hold: true,
  holdUrl: publicUrl(`${WEBHOOK_BASE}/conference-hold-facts?parent=${encodeURIComponent(callSid)}&step=0`),
  holdMethod: 'POST',
});

// Ends every open room of the call. A room that is already gone (404) does not count. Throws on any other error.
async function endOpenRooms(callSid) {
  const api = client();
  const rooms = await api.conferences.list({ friendlyName: conferencePath.roomFor(callSid), status: 'in-progress', limit: 5 });
  let ended = 0;
  for (const room of rooms || []) {
    try {
      await api.conferences(room.sid).update({ status: 'completed' });
      ended += 1;
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }
  return ended;
}

// One Twilio step. { ok, gone } or throws a REST error. `gone`: the caller's room is already gone.
async function runStep(callSid, step) {
  if (step === 'voicemail') return { ok: true, gone: (await endOpenRooms(callSid)) === 0 };
  const roomSid = await findRoomSid(callSid);
  if (!roomSid) return { ok: false, gone: true };
  try {
    if (step === 'return') {
      await client().conferences(roomSid).participants(callSid).update({ hold: false });
      await resumeRecording(callSid);
    } else {
      await holdParticipant(callSid, roomSid);
      if (step === 'hold') await pauseRecording(callSid);
    }
  } catch (err) {
    if (isGone(err)) return { ok: false, gone: true };
    throw err;
  }
  return { ok: true, gone: false };
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

// Record the outcome of one step from the state as it is now (a newer decision may have replaced it meanwhile).
async function recordOutcome(callSid, ev) {
  try {
    await decide(callSid, ev);
  } catch (err) {
    // The wanted state stays unconfirmed, so the next claim sends the step again.
    logger.warn(`[call-hold] step outcome not recorded for ${masked(callSid)} (${errorCode(err)})`);
  }
}

// { failed } when the step failed (the pass stops: the loops and the waiters retry it later).
async function sendStep(callSid, claim) {
  const { gen, send: step } = claim;
  let out;
  try {
    out = await runStep(callSid, step);
  } catch (err) {
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
  await recordOutcome(callSid, { type: 'step_done', gen, step, gone: out.gone });
  if (step === 'voicemail' && !out.gone) {
    logger.info(`[call-hold] caller ${masked(callSid)} sent to voicemail (${claim.reason})`);
    await raiseVoicemailAlert(callSid, claim.reason);
  } else if (step === 'return') {
    logger.info(`[call-hold] caller ${masked(callSid)} back from hold`);
  }
  return { failed: false };
}

// Send what the wanted state needs, then read it again and send again if a newer decision replaced it. One
// token owns the lease for the whole pass. { busy } when another sender holds it: nothing is sent and nothing waits.
async function drain(callSid) {
  const token = crypto.randomUUID();
  let holding = false;
  let sent = 0;
  try {
    for (let i = 0; i < MAX_SENDS_PER_PASS; i += 1) {
      const claim = await claimStep(callSid, token);
      holding = Boolean(claim.send);
      if (!claim.send) return { busy: Boolean(claim.busy), sent };
      const out = await sendStep(callSid, claim);
      sent += 1;
      // A failed step stops the pass; so does a re-hold (the next fetch of the facts loop retries the voicemail).
      if (out.failed || claim.send === 'rehold') return { failed: out.failed, sent };
    }
    return { sent };
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
    await recordOutcome(callSid, { type: 'abort', gen });
    return 'failed';
  } catch (err) {
    logger.warn(`[call-hold] hold not started for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

// 'returned' | 'voicemail' | 'no_room' | 'failed'. A press 1: it answers 'returned' only once the unhold is
// confirmed; 'voicemail' when the voicemail is decided; 'failed' (the staff stay on the menu, whose loop finishes
// the return) when it could not be confirmed in time.
async function endHold(callSid) {
  try {
    const decision = await decide(callSid, { type: 'press1' });
    if (decision.answer === 'no_state') return 'failed';
    if (decision.answer === 'closed') return 'returned';
    if (decision.answer === 'voicemail') {
      await drain(callSid);
      return 'voicemail';
    }
    const result = await settle(callSid, (view) => {
      if (view.phase === 'voicemail') return 'voicemail';
      if (view.phase === 'returned' && view.applied === 'returned') return view.gone ? 'no_room' : 'returned';
      return null;
    });
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
    if (nextStep(decision.next)) await drain(callSid);
    return { ...(await holdState(callSid)), remind: decision.answer?.remind === true };
  } catch (err) {
    logger.warn(`[call-hold] hold check failed for ${masked(callSid)} (${errorCode(err)})`);
    return { found: false, open: true, closed: false, phase: 'held', applied: 'held', error: true, remind: false };
  }
}

// 'voicemail' | 'ordinary'. The winning staff leg ended. A hold open or a return in flight: the caller goes to
// voicemail ('voicemail'; one try here, the facts loop finishes it). Otherwise the ordinary room end runs. A
// database error propagates: the status callback is Twilio's to retry, and ending the room blind could drop a
// held caller.
async function staffLeft(callSid) {
  const decision = await decide(callSid, { type: 'staff_left' });
  if (decision.answer !== 'voicemail') return 'ordinary';
  await drain(callSid);
  return 'voicemail';
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
};

// One bell per call (dedupeKey on the CallSid). A failure is logged by code and never stops the voicemail.
async function raiseVoicemailAlert(callSid, reason) {
  try {
    const call = await db('call_log').where('twilio_call_sid', callSid).first('id', 'customer_id', 'from_phone');
    if (!call) return;
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const name = await callerNameFor(call);
    await raiseAdminAlert('voicemail_callback', {
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
  } catch (err) {
    logger.error(`[call-hold] voicemail alert not raised for ${masked(callSid)} (${errorCode(err)})`);
  }
}

module.exports = {
  HOLD_REMINDER_SEC, HOLD_LIMIT_SEC, LEASE_MS, isEnabled, startHold, endHold, checkHold, staffLeft, holdState, roomIsOpen, heldSeconds, resumeRecording,
  _test: { planEvent, planClaim, nextStep, decide },
};
