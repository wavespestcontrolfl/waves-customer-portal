'use strict';

/**
 * Pause the call recording while card details are spoken (GATE_CALL_RECORDING_CARD_PAUSE, dark; owner
 * 2026-11-16 "ok build all": "When someone says 'card number', the recording pauses for 90 seconds").
 *
 * live-call-transcription.js calls onUtteranceStored after each final utterance is stored (card
 * digits already masked). When the stored text asks for or names card details, or the store masked
 * a card number, the <Dial record="record-from-answer-dual"> recording on the caller's call is
 * paused by REST (Status=paused, PauseBehavior=silence, which keeps the audio aligned with the live
 * text) and resumed 90 seconds later. A new trigger while paused only moves the end out.
 *
 * Resume has two paths: an in-process timer, and a self-heal on any later stored utterance for the
 * call (the live text keeps flowing while the recording is paused, so a restart during the pause
 * still resumes). State is call_log.metadata.live_transcription.card_pause: the wanted state
 * (paused_at, resume_due_at; resumed_at only once the resume is confirmed) plus `pending`, the
 * transition ('pause' or 'resume') that was decided and committed but that Twilio has not yet
 * confirmed. Every decision is made under pg_advisory_xact_lock(hashtext('live_card_pause:' ||
 * callSid)) and committed before the Twilio request is sent. The requests for one call are sent
 * one at a time across every server process (a deploy overlap runs two), and no database connection
 * is held while a request is in flight (a held connection plus the decision transactions of the same
 * pass could exhaust a small pool). The sender owns a lease in the same state: `sender` = { token,
 * until }, taken or renewed by claimStep in the same stamp as its decision, so a crash leaves both.
 * Another live lease makes claimStep answer send_busy; an expired one is taken over. After each
 * request the wanted state is read again, so the last request Twilio receives always matches the
 * newest committed decision: an older resume or pause still in flight, in this process or in another,
 * can never land after a newer decision. The lease is released when the pass ends (cleared by its last
 * claim, or by releaseLease when the pass stops early).
 *
 * A crash after a decision leaves `pending` set, and the next
 * stored utterance or the timer finishes it. A pause whose outcome is unknown (timeout, socket reset,
 * 5xx) keeps `pending` and the window, so the resume still goes out at the window end (resuming a
 * recording that never paused is harmless).
 *
 * The decision makers (a card trigger, the window-end timer, which is the resume guarantee) that find
 * the lease busy retry on a short timer, one retry per call, holding no connection between attempts,
 * and give up once the lease would have expired plus a margin (claimStep takes over an expired lease
 * anyway, and the window-end timer and later utterances cover the rest). A stored utterance that finds
 * it busy skips. LEASE_MS is above the Twilio request timeout, so a crashed sender blocks the others
 * for seconds only.
 *
 * The lease is re-validated and extended right before each request (fenceLease), so a sender that
 * stalled after its claim and lost the lease sends nothing. A request that still lands late, after
 * another sender moved on, is reconciled against the wanted state even when that is closed
 * (stateAfterSuccess): a pause that landed on a closed state reopens a resume, a resume that landed
 * into a newer open window reopens a pause.
 *
 * A resume that failed in a way a retry can fix (a timeout, a 5xx, a thrown database error) does not
 * wait for another utterance: a backoff retry (2 s, 4, 8, 16, then every 30 s, for 10 minutes after the
 * first failure) runs through the same lease and claim path, one timer per call. It stops on a
 * confirmed resume, a terminal resume code, or a call that has ended (a terminal status or ended_at;
 * not live_transcription.stopped_at, which a hold or a stream fault sets while the recording runs on).
 *
 * A restart loses every timer, and the live text may have stopped (a hold, a stream fault) or the gate
 * gone off, so recoverOpenPauses runs every minute from scheduler.js whatever the gate says: it re-arms
 * the timer of a pause whose end is ahead, and sends what is due or pending through the same lease and
 * claim path. It skips an ended call and never writes on its own.
 *
 * Risk: if a resume fails, the rest of that call's recording is silent and the post-call transcript
 * loses it. The gate is the instant off switch: off starts no new pause, and a running pause still
 * ends on time. Never throws, never on the webhook's response path.
 */

const crypto = require('crypto');
const twilio = require('twilio');
const RequestClient = require('twilio/lib/base/RequestClient');
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { TERMINAL_CALL_STATUSES } = require('../utils/call-timeline');

const PAUSE_MS = 90 * 1000;
// A timer can fire a few ms before the stored end; the timer path treats an end this close as due.
const TIMER_SLACK_MS = 1000;
const CURRENT_RECORDING = 'Twilio.CURRENT';
// Retrying cannot help: two active recordings (16108), call or recording already gone.
const TERMINAL_RESUME_CODES = new Set(['16108', '21220', '20404']);
// One pass sends at most this many requests (a resume, then the pause that replaced it, ...).
const MAX_SENDS_PER_PASS = 4;
// A request that takes longer is abandoned (an unknown outcome, handled like any other lost response).
const REQUEST_TIMEOUT_MS = 5 * 1000;
// The sender's lease is longer than the longest request, plus the claim and record steps around it.
const LEASE_MS = 8 * 1000;
const RETRY_MS = 250;
const RETRY_MARGIN_MS = 2 * 1000;
// After a failed resume (or a thrown error) a retry runs without waiting for an utterance: 2 s, 4, 8,
// 16, then every 30 s, until this long after the first failure.
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const RESUME_RETRY_WINDOW_MS = 10 * 60 * 1000;
// The recovery sweep looks at calls started in this long, at most this many at a time.
const RECOVERY_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const RECOVERY_LIMIT = 25;

const CARD_INTENT_RE = /\b(?:card\s+numbers?|credit\s+card|debit\s+card|card\s+ending|expir(?:ation|y)\s+date|security\s+code|cvv|cvc|code\s+on\s+the\s+back)\b/i;

const timers = new Map();
// One retry timer per call (a busy lease, or a failed pass), and how long its delay is.
const retries = new Map();
const retryDelays = new Map();
let requestClient = null;

function maskSid(sid) {
  const value = String(sid || '');
  return value.length > 8 ? `${value.slice(0, 2)}…${value.slice(-6)}` : 'none';
}

function isCardIntent(text, panMasked) {
  return !!panMasked || CARD_INTENT_RE.test(String(text || ''));
}

function errorCode(err) {
  const code = err?.code ?? err?.status ?? null;
  return code === null ? 'unknown' : String(code).slice(0, 16);
}

// Twilio answered with an error code: it refused the request, so the recording did not change. A
// timeout, a socket reset, a 5xx or a 429 (no code, or an answer that says nothing) leaves it unknown.
function isDefiniteRejection(err) {
  const status = Number(err?.status);
  if (status >= 500 || status === 429) return false;
  return typeof err?.code === 'number' || /^\d+$/.test(String(err?.code ?? ''));
}

function warn(what, callSid, err) {
  // The SID is masked and no transcript text is ever logged.
  logger.warn(`[live-card-pause] ${what} for ${maskSid(callSid)}: ${errorCode(err)}`);
}

async function setRecording(callSid, status) {
  requestClient = requestClient || new RequestClient({ timeout: REQUEST_TIMEOUT_MS });
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { httpClient: requestClient });
  const update = { status };
  if (status === 'paused') update.pauseBehavior = 'silence';
  await client.calls(callSid).recordings(CURRENT_RECORDING).update(update);
}

function cardPauseOf(row) {
  const value = row?.card_pause;
  return value && typeof value === 'object' ? value : {};
}

function readCardPauseRow(conn, callSid) {
  return conn('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .first(conn.raw("metadata -> 'live_transcription' -> 'card_pause' AS card_pause"));
}

// Run one decision under the per-call advisory lock; commit before any Twilio request is sent.
async function withCallLock(callSid, fn) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`live_card_pause:${callSid}`]);
    const row = await readCardPauseRow(trx, callSid);
    if (!row) return { action: 'none', reason: 'not_started_here' };
    return fn(trx, cardPauseOf(row));
  });
}

async function stampCardPause(conn, callSid, next) {
  return conn('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
    .update({
      metadata: conn.raw(
        "jsonb_set(metadata, '{live_transcription}', (metadata -> 'live_transcription') || ?::jsonb, true)",
        [JSON.stringify({ card_pause: next })],
      ),
      updated_at: new Date(),
    });
}

// Open = the recording is, or may still be, paused: no resume has been confirmed yet.
const isPaused = (state) => !!state.paused_at && !state.resumed_at;

// Decide what request this call needs next (if any), from the state as it is now. Returns the answer
// and the state to commit with it: a send also takes or renews this pass's lease; any answer that
// sends nothing clears this pass's own lease.
function planClaim(state, token, { slackMs = 0, allowPause = true }) {
  const now = Date.now();
  const mine = state.sender?.token === token;
  const clearMine = (st) => (mine ? { ...st, sender: null } : st);
  if (!isPaused(state)) return { res: { action: 'none' }, next: clearMine(state) };
  const dueAtMs = new Date(state.resume_due_at).getTime();
  let kind = state.pending || null;
  let next = state;
  if (dueAtMs - slackMs <= now && kind !== 'resume') {
    if (kind === 'pause' && !state.pause_sent) {
      // No pause request was ever sent and the window is over: there is nothing to undo.
      const closed = { ...state, resumed_at: new Date(now).toISOString(), pending: null };
      return { res: { action: 'none', reason: 'pause_not_sent' }, next: clearMine(closed) };
    }
    // Whatever the recording is doing, it must run again now (a resume of a running one is harmless).
    kind = 'resume';
    next = { ...state, pending: 'resume' };
  }
  // Gate off starts no pause of its own; the window end still resumes.
  if (!kind || (kind === 'pause' && !allowPause)) return { res: { action: 'not_due', dueAtMs }, next: clearMine(next) };
  const lease = state.sender;
  if (lease && lease.token !== token && Number(lease.until) > now) return { res: { action: 'send_busy', dueAtMs }, next };
  next = { ...next, sender: { token, until: now + LEASE_MS }, ...(kind === 'pause' ? { pause_sent: true } : {}) };
  return { res: { send: kind, dueAtMs, first: !state.pause_sent }, next };
}

// Commit the decision (and the lease with it) before any Twilio request is sent.
async function claimStep(callSid, token, opts) {
  return withCallLock(callSid, async (trx, state) => {
    const { res, next } = planClaim(state, token, opts || {});
    if (next !== state) await stampCardPause(trx, callSid, next);
    return res;
  });
}

// Right before a request: still the sender? One short state-lock transaction extends the lease from now
// (the client's request timeout is shorter than the lease, so the request cannot outlive it) when the
// token is still ours; otherwise nothing is sent (a stalled sender whose lease ran out and was taken over).
async function fenceLease(callSid, token) {
  const out = await withCallLock(callSid, async (trx, state) => {
    if (state.sender?.token !== token) return { owned: false };
    await stampCardPause(trx, callSid, { ...state, sender: { token, until: Date.now() + LEASE_MS } });
    return { owned: true };
  });
  return out.owned === true;
}

// Give the lease back when a pass stops without a claim that cleared it (an error, the send cap).
async function releaseLease(callSid, token) {
  try {
    await withCallLock(callSid, async (trx, state) => {
      if (state.sender?.token === token) await stampCardPause(trx, callSid, { ...state, sender: null });
      return { action: 'none' };
    });
  } catch (err) {
    // The lease expires by itself.
    warn('lease release failed', callSid, err);
  }
}

// What a confirmed request does to the state. Never touches a decision committed while it was in flight,
// but a request that landed late (after its sender's lease ran out and another sender moved on) can
// leave the recording against the wanted state, and that is recorded as a step to send:
//   - a pause that landed on a closed state: the recording is silent, a resume is wanted again;
//   - a resume that landed while a newer window is open with nothing pending: the recording runs, a pause
//     is wanted again.
function stateAfterSuccess(current, step) {
  const nowMs = Date.now();
  if (!isPaused(current)) {
    if (step.send !== 'pause') return current;
    const iso = new Date(nowMs).toISOString();
    return {
      ...current, paused_at: current.paused_at || iso, resume_due_at: current.resume_due_at || iso, resumed_at: null, pending: 'resume', pause_sent: true,
    };
  }
  if (current.pending === step.send) {
    return step.send === 'pause'
      ? { ...current, pending: null }
      : { ...current, resumed_at: new Date(nowMs).toISOString(), pending: null, pause_sent: false };
  }
  if (step.send !== 'resume') return current;
  // The recording runs again, so the pause that follows is a first request. With the window still ahead
  // and nothing pending, the pause must be sent again.
  const windowAhead = new Date(current.resume_due_at).getTime() > nowMs;
  return windowAhead && !current.pending ? { ...current, pending: 'pause', pause_sent: false } : { ...current, pause_sent: false };
}

function stateAfterFailure(current, step, err, code) {
  const base = { ...current, last_error_code: code };
  if (!isPaused(current) || current.pending !== step.send) return base;
  if (step.send === 'pause') {
    // Unknown outcome: the pause may have landed. Keep the pending pause and the window, so the resume
    // still goes out at the end and a later utterance can try the pause again.
    if (!isDefiniteRejection(err)) return base;
    // Refused for good: the first request never paused anything, so go back to unpaused. A retry may
    // follow an earlier request that landed: keep the window and let the end resume it.
    return step.first
      ? { ...base, paused_at: null, resume_due_at: null, pending: null, pause_sent: false }
      : { ...base, pending: null };
  }
  // A failure a retry cannot fix is kept; any other is released: the next stored utterance retries.
  return TERMINAL_RESUME_CODES.has(code)
    ? { ...base, resumed_at: new Date().toISOString(), pending: null, pause_sent: false }
    : base;
}

// Record the outcome of one request under the lock, from the state as it is now (never from a copy
// read before the request: a decision may have been committed while it was in flight).
async function recordOutcome(callSid, nextState) {
  try {
    await withCallLock(callSid, async (trx, current) => {
      const next = nextState(current);
      if (next !== current) await stampCardPause(trx, callSid, next);
      return { action: 'none' };
    });
  } catch (stampErr) {
    // The decision stays pending, so a later stored utterance or the timer sends it again.
    warn('error stamp failed', callSid, stampErr);
  }
}

async function sendStep(callSid, step) {
  const pausing = step.send === 'pause';
  try {
    await setRecording(callSid, pausing ? 'paused' : 'in-progress');
  } catch (err) {
    const code = errorCode(err);
    warn(`${step.send} failed`, callSid, err);
    await recordOutcome(callSid, (current) => stateAfterFailure(current, step, err, code));
    return { action: pausing ? 'pause_failed' : 'resume_failed', error_code: code, ...(pausing ? { dueAtMs: step.dueAtMs } : {}) };
  }
  await recordOutcome(callSid, (current) => stateAfterSuccess(current, step));
  return { action: pausing ? 'paused' : 'resumed' };
}

// Send what is pending, then read the wanted state again and send again if a newer decision replaced
// it (a resume in flight when a card trigger moved the window: the pause goes out after it). One token
// owns the lease for the whole pass; no connection is held while a request is in flight.
async function drain(callSid, opts) {
  const token = crypto.randomUUID();
  let sent = null;
  let holding = false;
  try {
    for (let i = 0; i < MAX_SENDS_PER_PASS; i += 1) {
      const step = await claimStep(callSid, token, opts);
      holding = !!step.send;
      if (!step.send) return sent ? { ...step, action: sent } : step;
      if (!(await fenceLease(callSid, token))) {
        holding = false;
        return sent ? { action: sent } : { action: 'send_busy', dueAtMs: step.dueAtMs };
      }
      const out = await sendStep(callSid, step);
      if (out.error_code) return out;
      sent = out.action;
    }
    return { action: sent };
  } finally {
    if (holding) await releaseLease(callSid, token);
  }
}

// The recording is gone once the call is over: Twilio reported a terminal status, or the status callback
// stamped metadata.ended_at. live_transcription.stopped_at is NOT such a sign: a hold, a transfer or a
// stream fault stops the live text while the Dial recording keeps running, and a pause that began
// before it must still be resumed.
async function callEnded(callSid) {
  const row = await db('call_log')
    .where('twilio_call_sid', callSid)
    .first('status', db.raw("metadata ->> 'ended_at' AS ended_at"));
  return !!row && (TERMINAL_CALL_STATUSES.has(String(row.status || '')) || !!row.ended_at);
}

// A retry plan from the chain it continues (or a new one): a busy lease retries quickly until the lease
// would have expired plus a margin; a failed pass backs off, until RESUME_RETRY_WINDOW_MS after its first
// failure.
function retryPlan(chain) {
  if (chain.kind === 'busy') return { delayMs: RETRY_MS, stopAt: chain.startedAt + LEASE_MS + RETRY_MARGIN_MS };
  return { delayMs: BACKOFF_MS[Math.min(chain.attempt, BACKOFF_MS.length - 1)], stopAt: chain.startedAt + RESUME_RETRY_WINDOW_MS };
}

const nextChain = (chain, kind) => (chain?.kind === kind
  ? { ...chain, attempt: chain.attempt + 1 }
  : { kind, startedAt: Date.now(), attempt: 0 });

// One timer per call, never stacked: a sooner retry replaces a later one. It holds no connection while
// it waits, and goes through the lease and claim path like any other pass.
function scheduleRetry(callSid, chain) {
  const { delayMs, stopAt } = retryPlan(chain);
  if (Date.now() + delayMs > stopAt) return;
  const live = retries.get(callSid);
  if (live) {
    if (retryDelays.get(callSid) <= delayMs) return;
    clearTimeout(live);
  }
  const timer = setTimeout(() => {
    retries.delete(callSid);
    retryDelays.delete(callSid);
    pass(callSid, { slackMs: TIMER_SLACK_MS, allowPause: isEnabled('callRecordingCardPause') }, { decisionMaker: true, chain }).then((out) => {
      if (out?.dueAtMs && out.action !== 'send_busy' && !timers.has(callSid)) armTimer(callSid, out.dueAtMs);
    });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  retries.set(callSid, timer);
  retryDelays.set(callSid, delayMs);
}

// One drain, then what must follow it. Never rejects. A resume that failed in a way a retry can fix, or
// a thrown error (the database), schedules a backoff retry, so the resume does not wait for an
// utterance; a decision maker that found the lease busy retries quickly. A retry stops on a confirmed
// resume (nothing pending), a terminal resume code (the state is closed), or a call that has ended.
async function pass(callSid, opts, { decisionMaker = false, chain = null } = {}) {
  try {
    if (chain && await callEnded(callSid)) return { action: 'call_ended' };
    const out = await drain(callSid, opts);
    if (out.action === 'resume_failed' && !TERMINAL_RESUME_CODES.has(out.error_code)) scheduleRetry(callSid, nextChain(chain, 'backoff'));
    else if (out.action === 'send_busy' && decisionMaker) scheduleRetry(callSid, nextChain(chain, 'busy'));
    return out;
  } catch (err) {
    warn('pass failed', callSid, err);
    scheduleRetry(callSid, nextChain(chain, 'backoff'));
    return { action: 'error' };
  }
}

// A decision maker (a card trigger, the timer) drains, and retries if another sender holds the lease.
const reconcile = (callSid, opts) => pass(callSid, opts, { decisionMaker: true });

// The ordinary stored-utterance path. A call with no open pause costs one plain read and no
// transaction; a pause not yet due with nothing pending costs the same. Otherwise it drains, but a busy
// lease is skipped: the holder claims again after its request, and the timer covers the end.
async function selfHeal(callSid, opts) {
  const row = await readCardPauseRow(db, callSid);
  if (!row) return { action: 'none', reason: 'not_started_here' };
  const state = cardPauseOf(row);
  if (!isPaused(state)) return { action: 'none' };
  const dueAtMs = new Date(state.resume_due_at).getTime();
  if (!state.pending && dueAtMs > Date.now()) return { action: 'not_due', dueAtMs };
  return pass(callSid, opts);
}

function armTimer(callSid, dueAtMs) {
  clearTimeout(timers.get(callSid));
  const timer = setTimeout(() => {
    timers.delete(callSid);
    reconcile(callSid, { slackMs: TIMER_SLACK_MS, allowPause: isEnabled('callRecordingCardPause') }).then((out) => {
      // Another process extended the pause (or a pause is still open): wait for the end. A busy lease
      // is the retry's job, not a reason to fire again at once.
      if (out?.dueAtMs && out.action !== 'send_busy') armTimer(callSid, out.dueAtMs);
    }).catch(() => {});
  }, Math.max(0, dueAtMs - Date.now()));
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(callSid, timer);
}

async function pauseOrExtend(callSid) {
  const claim = await withCallLock(callSid, async (trx, state) => {
    const nowMs = Date.now();
    const dueAtMs = nowMs + PAUSE_MS;
    const dueAt = new Date(dueAtMs).toISOString();
    if (isPaused(state)) {
      // A resume that was decided but not confirmed is replaced: the recording must end up paused.
      const pending = state.pending === 'resume' ? 'pause' : state.pending || null;
      await stampCardPause(trx, callSid, { ...state, resume_due_at: dueAt, pending });
      return { action: 'extend', dueAtMs, pending };
    }
    await stampCardPause(trx, callSid, {
      ...state, paused_at: new Date(nowMs).toISOString(), resume_due_at: dueAt, resumed_at: null,
      pauses: (Number(state.pauses) || 0) + 1, pending: 'pause', pause_sent: false,
    });
    return { action: 'pause', dueAtMs, pending: 'pause' };
  });
  if (claim.action !== 'pause' && claim.action !== 'extend') return claim;
  // Armed before the request: a pause whose outcome is unknown still resumes at the end.
  armTimer(callSid, claim.dueAtMs);
  if (!claim.pending) return claim;
  const out = await reconcile(callSid, { allowPause: true });
  return out?.action === 'pause_failed' || out?.action === 'error' ? out : claim;
}

/**
 * Called after a final utterance is stored. A card trigger pauses (or extends) the pause; any other
 * stored utterance finishes a pending request and resumes a pause that is past its end. Resolves
 * with what it did; never rejects.
 */
async function onUtteranceStored({ callSid, text, panMasked, pauseOpen = false } = {}) {
  try {
    const gateOn = isEnabled('callRecordingCardPause');
    // Gate off starts no pause, but a pause that began while it was on still ends on time: the off
    // switch never leaves the rest of a live call unrecorded.
    if (!gateOn && !pauseOpen) return { action: 'none', reason: 'gate_off' };
    if (!callSid || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { action: 'none', reason: 'not_configured' };
    if (gateOn && isCardIntent(text, panMasked)) return await pauseOrExtend(callSid);
    const out = await selfHeal(callSid, { allowPause: gateOn });
    // A restart (a gate flip restarts the server) loses the timer of a running pause: arm one again.
    if (out?.dueAtMs && !timers.has(callSid)) armTimer(callSid, out.dueAtMs);
    return out;
  } catch (err) {
    warn('failed', callSid, err);
    return { action: 'error' };
  }
}

let recovering = false;

// Every minute (scheduler.js), whatever the gate says: a pause that began before a restart lost its
// timer, and nothing else wakes it if the live text has stopped (a hold, a stream fault) or the gate went
// off. Reads only recent calls with an unfinished pause (created_at is indexed; an idle server finds none),
// skips an ended call, and writes nothing itself: a pause whose end is still ahead only gets its timer
// back, and one that is due or has a step pending goes through the same lease and claim path as the timer.
async function recoverOpenPauses() {
  if (recovering) return { action: 'busy' };
  recovering = true;
  try {
    const cutoff = new Date(Date.now() - RECOVERY_LOOKBACK_MS);
    const rows = await db('call_log')
      .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb))
      .where('created_at', '>', cutoff)
      .whereRaw("(metadata -> 'live_transcription' -> 'card_pause' ->> 'paused_at') IS NOT NULL")
      .whereRaw("(metadata -> 'live_transcription' -> 'card_pause' ->> 'resumed_at') IS NULL")
      .whereRaw("(metadata ->> 'ended_at') IS NULL")
      .whereNotIn(db.raw("COALESCE(status, '')"), [...TERMINAL_CALL_STATUSES])
      .orderBy('created_at', 'desc')
      .limit(RECOVERY_LIMIT)
      .select('twilio_call_sid', db.raw("metadata -> 'live_transcription' -> 'card_pause' AS card_pause"));
    let handled = 0;
    for (const row of rows) {
      const callSid = row.twilio_call_sid;
      const state = cardPauseOf(row);
      if (!callSid || !isPaused(state)) continue;
      const dueAtMs = new Date(state.resume_due_at).getTime();
      if (!state.pending && dueAtMs > Date.now()) {
        if (!timers.has(callSid)) armTimer(callSid, dueAtMs);
        continue;
      }
      handled += 1;
      const out = await reconcile(callSid, { slackMs: TIMER_SLACK_MS, allowPause: isEnabled('callRecordingCardPause') });
      if (out?.dueAtMs && out.action !== 'send_busy' && !timers.has(callSid)) armTimer(callSid, out.dueAtMs);
    }
    return { action: 'swept', open: rows.length, handled };
  } catch (err) {
    logger.warn(`[live-card-pause] recovery sweep failed: ${errorCode(err)}`);
    return { action: 'error' };
  } finally {
    recovering = false;
  }
}

module.exports = {
  recoverOpenPauses,
  onUtteranceStored,
  isCardIntent,
  PAUSE_MS,
  _test: { timers, retries, LEASE_MS, REQUEST_TIMEOUT_MS, RESUME_RETRY_WINDOW_MS },
};
