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
 * still resumes). State is call_log.metadata.live_transcription.card_pause. Exactly one request
 * issues a given pause or resume: every decision is made under pg_advisory_xact_lock(hashtext(
 * 'live_card_pause:' || callSid)) and committed before the Twilio request is sent.
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

// Run one decision under the per-call advisory lock; commit before any Twilio request is sent.
async function withCallLock(callSid, fn) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`live_card_pause:${callSid}`]);
    const row = await trx('call_log')
      .where('twilio_call_sid', callSid)
      .whereRaw("(metadata -> 'live_transcription') IS NOT NULL")
      .first(trx.raw("metadata -> 'live_transcription' -> 'card_pause' AS card_pause"));
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

const isPaused = (state) => !!state.paused_at && !state.resumed_at;

function armTimer(callSid, dueAtMs) {
  clearTimeout(timers.get(callSid));
  const timer = setTimeout(() => {
    timers.delete(callSid);
    resumeIfDue(callSid, TIMER_SLACK_MS).then((out) => {
      // Another process extended the pause: wait for the new end.
      if (out?.action === 'not_due' && out.dueAtMs) armTimer(callSid, out.dueAtMs);
    }).catch(() => {});
  }, Math.max(0, dueAtMs - Date.now()));
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(callSid, timer);
}

async function sendResume(callSid, state) {
  try {
    await setRecording(callSid, 'in-progress');
    return { action: 'resumed' };
  } catch (err) {
    const code = errorCode(err);
    warn('resume failed', callSid, err);
    try {
      await withCallLock(callSid, async (trx, current) => {
        // Keep the claim for a failure a retry cannot fix; release it otherwise so the next
        // stored utterance retries.
        const release = !TERMINAL_RESUME_CODES.has(code) && current.paused_at === state.paused_at;
        await stampCardPause(trx, callSid, { ...current, last_error_code: code, resumed_at: release ? null : current.resumed_at });
        return { action: 'none' };
      });
    } catch (stampErr) {
      warn('error stamp failed', callSid, stampErr);
    }
    return { action: 'resume_failed', error_code: code };
  }
}

// Resume a pause whose end has passed and that nobody resumed yet.
async function resumeIfDue(callSid, slackMs = 0) {
  const claim = await withCallLock(callSid, async (trx, state) => {
    if (!isPaused(state)) return { action: 'none' };
    const dueAtMs = new Date(state.resume_due_at).getTime();
    if (!(dueAtMs - slackMs <= Date.now())) return { action: 'not_due', dueAtMs };
    await stampCardPause(trx, callSid, { ...state, resumed_at: new Date().toISOString() });
    return { action: 'resume', state };
  });
  if (claim.action !== 'resume') return claim;
  return sendResume(callSid, claim.state);
}

async function pauseOrExtend(callSid) {
  const claim = await withCallLock(callSid, async (trx, state) => {
    const nowMs = Date.now();
    const dueAt = new Date(nowMs + PAUSE_MS).toISOString();
    if (isPaused(state)) {
      await stampCardPause(trx, callSid, { ...state, resume_due_at: dueAt });
      return { action: 'extend', dueAtMs: nowMs + PAUSE_MS };
    }
    const pausedAt = new Date(nowMs).toISOString();
    await stampCardPause(trx, callSid, {
      ...state, paused_at: pausedAt, resume_due_at: dueAt, resumed_at: null, pauses: (Number(state.pauses) || 0) + 1,
    });
    return { action: 'pause', pausedAt, dueAtMs: nowMs + PAUSE_MS };
  });
  if (claim.action === 'extend') {
    armTimer(callSid, claim.dueAtMs);
    return claim;
  }
  if (claim.action !== 'pause') return claim;
  try {
    await setRecording(callSid, 'paused');
    armTimer(callSid, claim.dueAtMs);
    return claim;
  } catch (err) {
    const code = errorCode(err);
    warn('pause failed', callSid, err);
    try {
      await withCallLock(callSid, async (trx, current) => {
        // The recording never paused: go back to unpaused so a later trigger tries again.
        const mine = current.paused_at === claim.pausedAt;
        await stampCardPause(trx, callSid, {
          ...current, last_error_code: code, ...(mine ? { paused_at: null, resume_due_at: null } : {}),
        });
        return { action: 'none' };
      });
    } catch (stampErr) {
      warn('error stamp failed', callSid, stampErr);
    }
    return { action: 'pause_failed', error_code: code };
  }
}

/**
 * Called after a final utterance is stored. A card trigger pauses (or extends) the pause; any other
 * stored utterance resumes a pause that is past its end. Resolves with what it did; never rejects.
 */
async function onUtteranceStored({ callSid, text, panMasked, pauseOpen = false } = {}) {
  try {
    const gateOn = isEnabled('callRecordingCardPause');
    // Gate off starts no pause, but a pause that began while it was on still ends on time: the off
    // switch never leaves the rest of a live call unrecorded.
    if (!gateOn && !pauseOpen) return { action: 'none', reason: 'gate_off' };
    if (!callSid || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return { action: 'none', reason: 'not_configured' };
    if (gateOn && isCardIntent(text, panMasked)) return await pauseOrExtend(callSid);
    const out = await resumeIfDue(callSid);
    // A restart (a gate flip restarts the server) loses the timer of a running pause: arm one again.
    if (out?.action === 'not_due' && out.dueAtMs && !timers.has(callSid)) armTimer(callSid, out.dueAtMs);
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
