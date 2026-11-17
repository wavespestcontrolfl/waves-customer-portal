'use strict';

/**
 * Conference call path for the main office staff ring (GATE_CALL_CONFERENCE_PATH, owner 2026-11-16
 * "ok build all"). It is the base the hold, hold timer, warm transfer, voice trigger and ring-fact
 * builds need: Twilio can hold or move a caller only while the caller is a conference participant.
 *
 * Today /voice bridges the caller to a staff cell with <Dial><Number url=press-1 screen>. On this path:
 *   1. /voice plays the same greeting, then <Redirect>s to /conference-enter.
 *   2. /conference-enter claims the call (metadata.conference_path) and places one REST call per staff
 *      number. Each runs the same press-1 screen. The staff phone shows the caller's number when the
 *      /voice request carried Twilio's CallToken, else the Waves line the caller dialed (Twilio allows
 *      only owned numbers as From without it). The caller waits in room waves-<CallSid> and hears a US
 *      ringback tone until a staff member joins. No leg placed = today's <Dial> ring (fail open).
 *   3. The first press 1 wins one conditional UPDATE. It starts the call recording on the caller's call
 *      (dual channel, the same /recording-status callback), writes forward_acceptance exactly as
 *      today, ends the other legs and joins the room.
 *   4. No press 1 (every leg ended, or the ring timeout + 20 s backstop): the caller is redirected to
 *      /call-complete?conf=1&conf_status=<status>, which runs today's voicemail / AI backstop path.
 *   5. The winning staff call ends (its status callback: Twilio requests no <Dial> action when the call
 *      that runs the <Dial> hangs up): the room is ended, so the caller's <Dial> action runs
 *      /call-complete as it does when a bridged staff leg hangs up today. Staff join with
 *      endConferenceOnExit=false, so a later star-key hold can leave the room without ending it.
 *      The caller's call ends: the room ends by itself (caller endConferenceOnExit=true) and
 *      /call-status ends every staff leg still up.
 *
 * State: call_log.metadata.conference_path { room, mode, started_at, ring_timeout_sec, leg_count,
 * legs: { "<i>": { sid, status } }, accepted_leg_sid, accepted_at, voicemail_at, closed_at, recording,
 * fallback }. Call SIDs and times only: no customer data, no staff numbers.
 * Every claim is one conditional UPDATE, so two staff, a backstop and a hang-up can race safely.
 * This module holds the state and the Twilio REST calls; the TwiML and the webhook routes live in
 * routes/twilio-voice-webhook.js.
 */

const twilio = require('twilio');
const db = require('../models/db');
const logger = require('./logger');
const { toE164 } = require('../utils/phone');
const featureGates = require('../config/feature-gates');

const WEBHOOK_BASE = '/api/webhooks/twilio';
const TERMINAL_LEG_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const VOICEMAIL_STATUSES = new Set(['no-answer', 'busy', 'failed']);
const NO_ANSWER_BACKSTOP_EXTRA_SEC = 20;
const VOICEMAIL_RETRY_SEC = 10;
const VOICEMAIL_ATTEMPTS = 3;
const CALL_TOKEN_TTL_MS = 2 * 60 * 1000;
const CALL_TOKEN_MAX = 500;
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const OPEN_SQL = [
  "(metadata -> 'conference_path') IS NOT NULL",
  "(metadata #>> '{conference_path,voicemail_at}') IS NULL",
  "(metadata #>> '{conference_path,closed_at}') IS NULL",
];
// The caller's call has no terminal status yet (the same set as a staff leg's). Built from constants.
const CALLER_LIVE_SQL = `(status IS NULL OR status NOT IN (${[...TERMINAL_LEG_STATUSES].map((s) => `'${s}'`).join(', ')}))`;

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const conferenceMode = () => (typeof featureGates.callConferencePathMode === 'function' ? featureGates.callConferencePathMode() : 'off');
const conferenceRingOn = () => conferenceMode() !== 'off';
const masked = (sid) => (sid ? `…${String(sid).slice(-6)}` : 'none');
// Errors are logged by code only: a Twilio error message can carry a phone number.
const errorCode = (err) => String(err?.code || err?.status || err?.name || 'error');
const client = () => twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const publicUrl = (path) => `https://${process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com'}${path}`;
const roomFor = (callSid) => `waves-${callSid}`;
const parent = (callSid) => `parent=${encodeURIComponent(callSid)}`;

function testCallers() {
  return new Set(String(process.env.CALL_CONFERENCE_TEST_CALLERS || '').split(',')
    .map((n) => n.trim()).filter(Boolean).map((n) => toE164(n)));
}

// 'on' admits every main office ring; 'test' only the listed callers; anything else nothing.
function admitsConferencePath({ from } = {}) {
  const mode = conferenceMode();
  if (mode === 'on') return true;
  if (mode !== 'test' || !from) return false;
  return testCallers().has(toE164(from));
}

// The /voice request carries Twilio's CallToken; the <Redirect> to /conference-enter may not. Kept
// in memory for 2 minutes only, never written to the database. A miss rings from the Waves line.
const callTokens = new Map();
function stashCallToken(callSid, token) {
  if (!callSid || !token) return;
  const now = Date.now();
  for (const [sid, entry] of callTokens) if (entry.expires <= now) callTokens.delete(sid);
  if (callTokens.size >= CALL_TOKEN_MAX) callTokens.delete(callTokens.keys().next().value);
  callTokens.set(callSid, { token: String(token), expires: now + CALL_TOKEN_TTL_MS });
}
function takeCallToken(callSid) {
  const entry = callTokens.get(callSid);
  callTokens.delete(callSid);
  return entry && entry.expires > Date.now() ? entry.token : null;
}

function readState(row) {
  let meta = row?.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  const state = meta && typeof meta === 'object' ? meta.conference_path : null;
  return state && typeof state === 'object' ? state : null;
}

async function loadState(callSid) {
  return readState(await db('call_log').where('twilio_call_sid', callSid).first('metadata'));
}

// One jsonb_set per [path, value] under conference_path. Path parts are fixed names or leg indexes.
function setPaths(entries) {
  let expr = "COALESCE(metadata, '{}'::jsonb)";
  const bindings = [];
  for (const [path, value] of entries) {
    expr = `jsonb_set(${expr}, '{conference_path,${path.join(',')}}', ?::jsonb, true)`;
    bindings.push(JSON.stringify(value));
  }
  return db.raw(expr, bindings);
}

function updateState(callSid, entries, conditions = ["(metadata -> 'conference_path') IS NOT NULL"]) {
  let query = db('call_log').where('twilio_call_sid', callSid);
  for (const sql of conditions) query = query.whereRaw(sql);
  return query.update({ metadata: setPaths(entries), updated_at: new Date() }).then(Number);
}

function stampLeg(callSid, index, fields) {
  return updateState(callSid, Object.entries(fields).map(([key, value]) => [['legs', String(index), key], value]));
}

// { claim: 'claimed' | 'retry' (a redelivered redirect: the legs already ring) | 'ended' (the caller's
// call already has a terminal status: no leg may ring for it) | 'no_row', state }.
async function claimStart(callSid, { legCount, ringTimeoutSec }) {
  const state = {
    room: roomFor(callSid),
    mode: conferenceMode(),
    started_at: new Date().toISOString(),
    ring_timeout_sec: ringTimeoutSec,
    leg_count: legCount,
    legs: Object.fromEntries(Array.from({ length: legCount }, (_, i) => [String(i), {}])),
  };
  const claimed = await db('call_log').where('twilio_call_sid', callSid)
    .whereRaw("(metadata -> 'conference_path') IS NULL")
    .whereRaw(CALLER_LIVE_SQL)
    .update({
      metadata: db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{conference_path}', ?::jsonb, true)", [JSON.stringify(state)]),
      updated_at: new Date(),
    });
  if (Number(claimed) > 0) return { claim: 'claimed', state };
  const row = await db('call_log').where('twilio_call_sid', callSid).first('metadata', 'status');
  const existing = readState(row);
  if (existing) return { claim: 'retry', state: existing };
  return { claim: row ? 'ended' : 'no_row', state: null };
}

async function placeStaffLegs({ callSid, numbers, ringTimeoutSec, callerFrom, wavesLine, callToken }) {
  const api = client();
  const placed = await Promise.all(numbers.map(async (to, index) => {
    const params = {
      to,
      url: publicUrl(`${WEBHOOK_BASE}/conference-staff-screen?${parent(callSid)}`),
      method: 'POST',
      timeout: ringTimeoutSec,
      statusCallback: publicUrl(`${WEBHOOK_BASE}/conference-staff-status?${parent(callSid)}&leg=${index}`),
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
    };
    try {
      let call = null;
      if (callToken && callerFrom) {
        call = await api.calls.create({ ...params, from: callerFrom, callToken }).catch((err) => {
          // Only an API refusal falls back; a network error may have placed the call already.
          if (!(err?.status >= 400 && err?.status < 500)) throw err;
          logger.warn(`[conference] caller-ID passthrough refused for leg ${index} (${errorCode(err)}); ringing from the Waves line`);
          return null;
        });
      }
      if (!call) call = await api.calls.create({ ...params, from: wavesLine });
      await stampLeg(callSid, index, { sid: call.sid })
        .catch((err) => logger.warn(`[conference] leg ${index} SID stamp failed for ${masked(callSid)} (${errorCode(err)})`));
      // The call may have settled while this leg was placed (the caller left, voicemail, another leg
      // won), and that clean-up could not see this SID. Read after the stamp, so one of the two ends it.
      const latest = await loadState(callSid).catch(() => null);
      if (latest && (latest.closed_at || latest.voicemail_at || (latest.accepted_leg_sid && latest.accepted_leg_sid !== call.sid))) {
        await api.calls(call.sid).update({ status: 'completed' })
          .catch((err) => logger.info(`[conference] late leg ${masked(call.sid)} not ended (${errorCode(err)})`));
      }
      return call.sid;
    } catch (err) {
      logger.error(`[conference] staff leg ${index} not placed for ${masked(callSid)} (${errorCode(err)})`);
      await stampLeg(callSid, index, { status: 'failed' }).catch(() => {});
      return null;
    }
  }));
  return placed.filter(Boolean);
}

// { won, first }: first = this request took the claim; a redelivered accept of the winner is won, not first.
async function claimAccept(callSid, legSid) {
  if (!legSid) return { won: false, first: false };
  const won = await updateState(callSid, [[['accepted_leg_sid'], legSid], [['accepted_at'], new Date().toISOString()]],
    [...OPEN_SQL, "(metadata #>> '{conference_path,accepted_leg_sid}') IS NULL"]);
  if (won > 0) return { won: true, first: true };
  return { won: (await loadState(callSid))?.accepted_leg_sid === legSid, first: false };
}

async function startCallerRecording(callSid) {
  try {
    await client().calls(callSid).recordings.create({
      recordingChannels: 'dual',
      recordingTrack: 'both',
      recordingStatusCallback: publicUrl(`${WEBHOOK_BASE}/recording-status`),
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: ['completed'],
    });
    return 'started';
  } catch (err) {
    const call = await client().calls(callSid).fetch().catch(() => null);
    if (call && call.status !== 'in-progress') return 'caller_gone';
    logger.error(`[conference] recording not started for ${masked(callSid)} (${errorCode(err)})`);
    return 'failed';
  }
}

async function endLegs(state, { except = null } = {}) {
  const live = Object.values(state?.legs || {})
    .filter((leg) => leg?.sid && leg.sid !== except && !TERMINAL_LEG_STATUSES.has(leg.status));
  if (!live.length) return 0;
  const api = client();
  // completed hangs up a leg whether it still rings or already plays the screen.
  const ended = await Promise.all(live.map((leg) => api.calls(leg.sid).update({ status: 'completed' })
    .then(() => 1, (err) => { logger.info(`[conference] leg ${masked(leg.sid)} not ended (${errorCode(err)})`); return 0; })));
  return ended.reduce((sum, n) => sum + n, 0);
}

function everyLegEnded(state) {
  const count = Number(state?.leg_count) || 0;
  if (count < 1) return false;
  return Array.from({ length: count }, (_, i) => state.legs?.[String(i)]?.status).every((s) => TERMINAL_LEG_STATUSES.has(s));
}

function noAnswerStatus(state) {
  const statuses = Object.values(state?.legs || {}).map((leg) => leg?.status);
  if (statuses.length && statuses.every((s) => s === 'failed')) return 'failed';
  if (statuses.length && statuses.every((s) => s === 'busy' || s === 'failed')) return 'busy';
  return 'no-answer';
}

// One claim: never after a press 1, never twice, never after the caller left. Ends every leg still up.
async function claimVoicemail(callSid) {
  const won = await updateState(callSid, [[['voicemail_at'], new Date().toISOString()]],
    [...OPEN_SQL, "(metadata #>> '{conference_path,accepted_leg_sid}') IS NULL"]);
  if (won) await endLegs(await loadState(callSid));
  return won > 0;
}

// The caller to today's voicemail path (/call-complete?conf=1&conf_status=...): 'redirected',
// 'not_needed' (a press 1, the caller left, or another trigger holds the claim) or 'redirect_failed'.
// A failed redirect releases the claim and tries again in 10 s (3 tries), so a Twilio hiccup cannot
// leave the caller alone in the room; a later leg callback or the backstop may also take it.
async function sendCallerToVoicemail(callSid, status, attempt = 1) {
  if (!(await claimVoicemail(callSid))) return 'not_needed';
  const confStatus = VOICEMAIL_STATUSES.has(status) ? status : 'no-answer';
  try {
    await client().calls(callSid).update({ url: publicUrl(`${WEBHOOK_BASE}/call-complete?conf=1&conf_status=${confStatus}`), method: 'POST' });
    return 'redirected';
  } catch (err) {
    logger.warn(`[conference] caller ${masked(callSid)} not redirected to voicemail (${errorCode(err)}), try ${attempt} of ${VOICEMAIL_ATTEMPTS}`);
    await updateState(callSid, [[['voicemail_at'], null]])
      .catch((releaseErr) => logger.warn(`[conference] voicemail claim not released for ${masked(callSid)} (${errorCode(releaseErr)})`));
    if (attempt < VOICEMAIL_ATTEMPTS) {
      const timer = setTimeout(() => {
        sendCallerToVoicemail(callSid, confStatus, attempt + 1)
          .catch((retryErr) => logger.warn(`[conference] voicemail retry failed for ${masked(callSid)} (${errorCode(retryErr)})`));
      }, VOICEMAIL_RETRY_SEC * 1000);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return 'redirect_failed';
  }
}

function scheduleNoAnswerBackstop(callSid, ringTimeoutSec) {
  const timer = setTimeout(() => {
    sendCallerToVoicemail(callSid, 'no-answer')
      .catch((err) => logger.warn(`[conference] no-answer backstop failed for ${masked(callSid)} (${errorCode(err)})`));
  }, (ringTimeoutSec + NO_ANSWER_BACKSTOP_EXTRA_SEC) * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// The winning staff call ended. End the room: the caller's <Dial> then runs /call-complete, as a
// bridged call does today when the staff hang up first. No open room, or it will not end: hang up
// the caller, so no one is left alone in it.
async function endRoomAfterStaffHangup(callSid, state) {
  if (state.closed_at) return 'caller_gone';
  const api = client();
  try {
    const rooms = await api.conferences.list({ friendlyName: roomFor(callSid), limit: 5 });
    const open = rooms.filter((room) => room.status !== 'completed');
    for (const room of open) await api.conferences(room.sid).update({ status: 'completed' });
    if (open.length) return 'room_ended';
  } catch (err) {
    logger.warn(`[conference] room end failed for ${masked(callSid)} (${errorCode(err)})`);
  }
  return api.calls(callSid).update({ status: 'completed' }).then(() => 'caller_hung_up', () => 'caller_gone');
}

async function onStaffLegStatus({ callSid, index, legSid, status }) {
  if (!TERMINAL_LEG_STATUSES.has(status) || !Number.isInteger(index) || index < 0) return 'ignored';
  await stampLeg(callSid, index, legSid ? { sid: legSid, status } : { status });
  const state = await loadState(callSid);
  if (!state) return 'no_state';
  if (state.accepted_leg_sid) {
    return state.accepted_leg_sid === legSid ? endRoomAfterStaffHangup(callSid, state) : 'accepted';
  }
  if (!everyLegEnded(state)) return 'waiting';
  return (await sendCallerToVoicemail(callSid, noAnswerStatus(state))) === 'redirected' ? 'voicemail' : 'settled';
}

// The caller's call ended (/call-status): close the claim and end every leg still ringing.
async function closeForCallerEnd(callSid) {
  const closed = await updateState(callSid, [[['closed_at'], new Date().toISOString()]],
    ["(metadata -> 'conference_path') IS NOT NULL", "(metadata #>> '{conference_path,closed_at}') IS NULL"]);
  if (!closed) return 0;
  // Every leg, the winner too: a staff member still hearing the announcement must not join an empty room.
  return endLegs(await loadState(callSid));
}

// /call-complete?conf=1: a conference <Dial> sends no DialCallSid or DialCallDuration and reports
// 'answered', so the outcome comes from the claim. Talk time counts from the press 1, as a bridged
// <Dial>'s DialCallDuration does today.
async function conferenceDialOutcome(callSid, confStatus) {
  if (VOICEMAIL_STATUSES.has(confStatus)) return { status: confStatus, duration: 0, accepted: false };
  const acceptedAt = Date.parse((await loadState(callSid))?.accepted_at || '');
  if (Number.isFinite(acceptedAt)) {
    return { status: 'completed', duration: Math.max(0, Math.round((Date.now() - acceptedAt) / 1000)), accepted: true };
  }
  // The caller left the room with no press 1 and no redirect (a join error): stop the ring first.
  await claimVoicemail(callSid)
    .catch((err) => logger.warn(`[conference] ring not stopped for ${masked(callSid)} (${errorCode(err)})`));
  return { status: 'no-answer', duration: 0, accepted: false };
}

module.exports = {
  CALL_SID_RE,
  errorCode,
  roomFor,
  admitsConferencePath,
  conferenceRingOn,
  stashCallToken,
  takeCallToken,
  claimStart,
  placeStaffLegs,
  claimAccept,
  startCallerRecording,
  endLegs,
  loadState,
  updateState,
  scheduleNoAnswerBackstop,
  sendCallerToVoicemail,
  onStaffLegStatus,
  closeForCallerEnd,
  conferenceDialOutcome,
  _test: { callTokens },
};
