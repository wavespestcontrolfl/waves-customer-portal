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
 * one at a time across every server process (a deploy overlap runs two): a second transaction-scoped
 * advisory lock, the send lock on 'live_card_pause_send:' || callSid, is held for a whole drain (claim,
 * request, record the outcome, claim again). The state decisions keep their own short transactions on
 * the first lock, so a decision never waits on a Twilio request in flight. After each request the
 * wanted state is read again, so the last request Twilio receives always matches the newest committed
 * decision: an older resume or pause still in flight, in this process or in another, can never land
 * after a newer decision. A crash after a decision leaves `pending` set, and the next stored
 * utterance or the timer finishes it. The decision makers (a card trigger, the window-end timer, which
 * is the resume guarantee) wait for the send lock. A stored utterance that finds the send lock held
 * skips: the holder claims again after its request, and the timer waits for the window end. Each
 * waiter holds a pool connection, so only those two wait. The Twilio client's own request timeout
 * (30 s, the SDK default) bounds how long a request can hold the lock. A pause whose outcome is unknown (timeout, socket reset, 5xx)
 * keeps `pending` and the window, so the resume still goes out at the window end (resuming a
 * recording that never paused is harmless).
 *
 * Risk: if a resume fails, the rest of that call's recording is silent and the post-call transcript
 * loses it. The gate is the instant off switch: off starts no new pause, and a running pause still
 * ends on time. Never throws, never on the webhook's response path.
 */

const twilio = require('twilio');
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const PAUSE_MS = 90 * 1000;
// A timer can fire a few ms before the stored end; the timer path treats an end this close as due.
const TIMER_SLACK_MS = 1000;
const CURRENT_RECORDING = 'Twilio.CURRENT';
// Retrying cannot help: two active recordings (16108), call or recording already gone.
const TERMINAL_RESUME_CODES = new Set(['16108', '21220', '20404']);
// One pass sends at most this many requests (a resume, then the pause that replaced it, ...).
const MAX_SENDS_PER_PASS = 4;

const CARD_INTENT_RE = /\b(?:card\s+numbers?|credit\s+card|debit\s+card|card\s+ending|expir(?:ation|y)\s+date|security\s+code|cvv|cvc|code\s+on\s+the\s+back)\b/i;

const timers = new Map();

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
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

// Hold the call's send lock while fn runs: its Twilio requests go out one at a time, across processes.
// The transaction writes nothing and is only the lock's owner; the decisions use their own transactions.
// wait=false skips (and sends nothing) when another sender holds it.
async function withSendLock(callSid, wait, fn) {
  return db.transaction(async (trx) => {
    const key = [`live_card_pause_send:${callSid}`];
    if (wait) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', key);
    } else {
      const res = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked', key);
      if (!res?.rows?.[0]?.locked) return { action: 'send_busy' };
    }
    return fn();
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

// Decide, under the lock, what request this call needs next (if any) and commit the decision first.
async function claimStep(callSid, { slackMs = 0, allowPause = true } = {}) {
  return withCallLock(callSid, async (trx, state) => {
    if (!isPaused(state)) return { action: 'none' };
    const dueAtMs = new Date(state.resume_due_at).getTime();
    let kind = state.pending || null;
    if (dueAtMs - slackMs <= Date.now() && kind !== 'resume') {
      if (kind === 'pause' && !state.pause_sent) {
        // No pause request was ever sent and the window is over: there is nothing to undo.
        await stampCardPause(trx, callSid, { ...state, resumed_at: new Date().toISOString(), pending: null });
        return { action: 'none', reason: 'pause_not_sent' };
      }
      // Whatever the recording is doing, it must run again now (a resume of a running one is harmless).
      kind = 'resume';
      await stampCardPause(trx, callSid, { ...state, pending: 'resume' });
    }
    // Gate off starts no pause of its own; the window end still resumes.
    if (!kind || (kind === 'pause' && !allowPause)) return { action: 'not_due', dueAtMs };
    if (kind === 'pause') await stampCardPause(trx, callSid, { ...state, pause_sent: true });
    return { send: kind, dueAtMs, first: !state.pause_sent };
  });
}

// What a confirmed request does to the state. Never touches a decision committed while it was in flight.
function stateAfterSuccess(current, step) {
  if (!isPaused(current)) return current;
  if (current.pending === step.send) {
    return step.send === 'pause'
      ? { ...current, pending: null }
      : { ...current, resumed_at: new Date().toISOString(), pending: null, pause_sent: false };
  }
  // A card trigger replaced the resume while it was in flight: the recording runs again, so the pause
  // that follows is a first request.
  return step.send === 'resume' ? { ...current, pause_sent: false } : current;
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
// it (a resume in flight when a card trigger moved the window: the pause goes out after it).
async function drain(callSid, opts) {
  let sent = null;
  for (let i = 0; i < MAX_SENDS_PER_PASS; i += 1) {
    const step = await claimStep(callSid, opts);
    if (!step.send) return sent ? { ...step, action: sent } : step;
    const out = await sendStep(callSid, step);
    if (out.error_code) return out;
    sent = out.action;
  }
  return { action: sent };
}

// A decision maker (a card trigger, the timer) waits for the send lock, then drains.
const reconcile = (callSid, opts) => withSendLock(callSid, true, () => drain(callSid, opts));

// The ordinary stored-utterance path. A call with no open pause costs one plain read and no
// transaction; a pause not yet due with nothing pending costs the same. Otherwise it drains, but never
// waits for the send lock: the holder claims again after its request, and the timer covers the end.
async function selfHeal(callSid, opts) {
  const row = await readCardPauseRow(db, callSid);
  if (!row) return { action: 'none', reason: 'not_started_here' };
  const state = cardPauseOf(row);
  if (!isPaused(state)) return { action: 'none' };
  const dueAtMs = new Date(state.resume_due_at).getTime();
  if (!state.pending && dueAtMs > Date.now()) return { action: 'not_due', dueAtMs };
  const out = await withSendLock(callSid, false, () => drain(callSid, opts));
  // Busy: hand back the stored end so a restart that lost the timer arms it again.
  return out.action === 'send_busy' ? { ...out, dueAtMs } : out;
}

function armTimer(callSid, dueAtMs) {
  clearTimeout(timers.get(callSid));
  const timer = setTimeout(() => {
    timers.delete(callSid);
    reconcile(callSid, { slackMs: TIMER_SLACK_MS, allowPause: isEnabled('callRecordingCardPause') }).then((out) => {
      // Another process extended the pause (or a pause is still open): wait for the end.
      if (out?.dueAtMs) armTimer(callSid, out.dueAtMs);
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
  return out?.action === 'pause_failed' ? out : claim;
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

module.exports = {
  onUtteranceStored,
  isCardIntent,
  PAUSE_MS,
  _test: { timers },
};
