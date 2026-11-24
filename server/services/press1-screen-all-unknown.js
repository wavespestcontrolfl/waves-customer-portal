'use strict';

/**
 * Press-1 screen for every unknown caller (GATE_CALL_SCREEN_ALL_UNKNOWN; owner
 * 2026-11-24 "trial", 14-day trial). With GATE_CALL_PRECONNECT_SCREEN also on,
 * the voice webhook challenges an unknown caller on ANY attestation, not only B
 * or an exchange-rule hit.
 *
 * The prompt is skipped (the caller rings straight through) for:
 *  - a number on a live customer record (the webhook's known-caller check),
 *  - a Waves line or a staff phone (env staff list, or the phone of any active
 *    technician, read here with the trial's time limit),
 *  - a number on a live lead,
 *  - a remembered caller: on an earlier inbound call the number talked with
 *    the office (30 s or more after the staff press 1, Sandy not involved) or left a message longer
 *    than 10 s on an earlier call nobody answered (no person, no Sandy), with a
 *    finished transcript that holds words (dead air is no message). A bare key
 *    press is never remembered: in the 60 days to 2026-11-20, 5 robocall
 *    numbers had pressed a key before.
 *
 * One statement answers it, with a cancelling statement timeout and a
 * wall-clock limit (READ_TIMEOUT_MS, pool wait included). It fails OPEN
 * (no challenge): a slow or broken query
 * never makes a real caller press a key, and an unsure staff check never
 * challenges a technician.
 */
const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { phoneKeySql } = require('../middleware/spam-block');
const { knownCallerPhoneExists } = require('../utils/known-caller-phone');

const READ_TIMEOUT_MS = 1500;
const TALK_SECONDS = 30;
const MESSAGE_SECONDS = 10;
// The missed-call service's unanswered outcomes and Sandy's call outcomes.
const UNANSWERED = ['missed', 'voicemail', 'unknown'];
const AI_OUTCOMES = ['ai_handled', 'ai_transferred'];

// Same key as phoneKeySql gives a stored column: '1' + last 10 for a US number.
function callerKey(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits;
  return digits.length >= 10 ? `1${digits.slice(-10)}` : digits;
}

// Resolve `promise`, or `onTimeout` once READ_TIMEOUT_MS passes (wall clock,
// so a wait for a pool connection counts too). The reads behind it carry a
// cancelling statement timeout of their own.
function withinLimit(promise, onTimeout) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), READ_TIMEOUT_MS); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Any ACTIVE technician's own phone (not gated on GATE_TECH_STAFF_GUARDS: the
// trial must never ask a technician to press 1).
function technicianRows(key) {
  return db('technicians').select(db.raw('1'))
    .where({ employment_status: 'active' })
    .whereRaw(`${phoneKeySql('phone')} = ?`, [key]);
}

function liveLeadRows(key) {
  return db('leads').select(db.raw('1'))
    .whereNull('deleted_at')
    .whereRaw(`${phoneKeySql('phone')} = ?`, [key]);
}

// The processor's no-speech markers (missed-call-bell.js NO_SPEECH_MARKER_RE):
// a message counts only once its transcript holds real words.
const NO_SPEECH_SQL = String.raw`\[(VOICEMAIL|NO SPEECH)\]|\[Recording had no usable speech;[^\]]*\]`;

// Inbound history only: a person the office called back is almost always on
// a lead, and the lead check already lets them through.
function rememberedRows(key) {
  return db('call_log').select(db.raw('1'))
    .where('direction', 'inbound')
    // The last-10 expression matches call_log_from_phone_last10_index, so the
    // history read is an index lookup; the full key check follows.
    .whereRaw("right(regexp_replace(from_phone, '\\D', '', 'g'), 10) = ?", [key.slice(-10)])
    .whereRaw(`${phoneKeySql('from_phone')} = ?`, [key])
    // Sandy's time counts toward duration_seconds on a transfer, so any call
    // Sandy touched proves nothing here.
    .whereRaw(`COALESCE(call_outcome, '') NOT IN (${AI_OUTCOMES.map(() => '?').join(', ')})`, AI_OUTCOMES)
    // The webhook's isTransferredRow markers: a Sandy transfer can end with a
    // voicemail outcome.
    .whereRaw("NOT COALESCE(jsonb_typeof(metadata->'relay_handoff') = 'object' OR jsonb_exists(metadata, 'relay_transfer_ring_at'), FALSE)")
    .where((proof) => proof
      // Talk time runs from the staff press 1 (forward_acceptance.accepted_at)
      // to the call's end (metadata.ended_at, Twilio's own end time; the status
      // callback writes it). created_at + duration_seconds is not the end, so a
      // call with no ended_at proves nothing here.
      .where((talked) => talked
        .where('answered_by', 'human')
        .whereRaw(`CASE WHEN metadata->'forward_acceptance'->>'accepted_at' IS NULL OR metadata->>'ended_at' IS NULL THEN FALSE
          ELSE (metadata->>'ended_at')::timestamptz
            - (metadata->'forward_acceptance'->>'accepted_at')::timestamptz >= make_interval(secs => ?) END`, [TALK_SECONDS]))
      .orWhere((message) => message
        .where((unanswered) => unanswered.whereIn('answered_by', UNANSWERED).orWhereNull('answered_by'))
        .where('recording_duration_seconds', '>', MESSAGE_SECONDS)
        .where((rec) => rec.whereNotNull('recording_sid').orWhereNotNull('recording_url'))
        // Dead air is no message: the transcript must be done and hold words
        // once the no-speech markers are removed.
        .where('transcription_status', 'completed')
        .whereRaw("regexp_replace(COALESCE(transcription, ''), ?, '', 'gi') ~ '[[:alnum:]]'", [NO_SPEECH_SQL])));
}

/**
 * Should the all-unknown trial challenge this caller? Called only for a caller
 * with no customer match on a first delivery. Never throws.
 * @returns {Promise<boolean>}
 */
// Run `fn(connection, msLeft)` inside one wall-clock limit that also covers
// the wait for a pool connection (the pattern of ai-assistant/portal-turn.js
// withBoundedConnection). Knex starts a query timeout only once it has a
// connection, so the connection is taken here: when the limit passes first, a
// queued request is aborted and never runs; a statement already sent keeps its
// cancelling timeout. Answers 'timeout' when the limit passed.
async function onBoundedConnection(fn) {
  const deadline = Date.now() + READ_TIMEOUT_MS;
  const acquisition = db.client.pool.acquire();
  let connection = null;
  const work = (async () => {
    connection = await acquisition.promise;
    try {
      const left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      return await fn(connection, left);
    } finally {
      await db.client.releaseConnection(connection);
    }
  })();
  try {
    return await withinLimit(work, 'timeout');
  } finally {
    if (!connection) acquisition.abort();
    // Tarn removes an aborted queued request in its promise handler.
    await acquisition.promise.catch(() => {});
    work.catch(() => {}); // a failure after the limit has no one left to tell
  }
}

// The customer-slot check (utils/known-caller-phone), on a bounded connection.
// A timeout counts as known: no challenge.
async function knownCallerWithinLimit(from) {
  const answer = await onBoundedConnection((connection, left) => knownCallerPhoneExists((table) => db(table).connection(connection), from, left));
  return answer === 'timeout' ? true : answer;
}

// A Twilio redelivery of the first /voice request repeats the first
// delivery's trial decision (its call_log stamp) instead of reading again, so
// one call never gets two answers. No stamp, or a failed read: no challenge.
async function storedTrialDecision(callSid) {
  try {
    const row = await onBoundedConnection((connection, left) => db('call_log')
      .connection(connection)
      .where('twilio_call_sid', callSid)
      .timeout(left, { cancel: true })
      .first(db.raw("metadata->>'preconnect_screen_all_unknown' AS decision")));
    return Boolean(row && row !== 'timeout' && row.decision === 'gated');
  } catch (err) {
    logger.warn(`[preconnect-screen] stored trial decision read failed (failing open, no challenge): ${err?.code || err?.name || 'error'}`);
    return false;
  }
}

async function screenAllUnknownHit(from) {
  const key = callerKey(from);
  if (key.length < 10) return false;
  if (TWILIO_NUMBERS.isInternalNumber(from)) return false;
  try {
    // ONE statement answers all three questions, on a bounded connection.
    const row = await onBoundedConnection((connection, left) => db.select(
      db.raw('EXISTS (?) AS tech', [technicianRows(key)]),
      db.raw('EXISTS (?) AS lead', [liveLeadRows(key)]),
      db.raw('EXISTS (?) AS remembered', [rememberedRows(key)]),
    ).connection(connection).timeout(left, { cancel: true }).first());
    if (row === 'timeout') {
      logger.warn('[preconnect-screen] all-unknown check ran past its limit (failing open, no challenge)');
      return false;
    }
    if (!row) return false;
    return !(row.tech || row.lead || row.remembered);
  } catch (err) {
    // A code only: a Knex error echoes the bound values, here the caller's number.
    logger.warn(`[preconnect-screen] all-unknown check failed (failing open, no challenge): ${err?.code || err?.name || 'error'}`);
    return false;
  }
}

module.exports = { screenAllUnknownHit, knownCallerWithinLimit, storedTrialDecision, withinLimit, callerKey, READ_TIMEOUT_MS, TALK_SECONDS, MESSAGE_SECONDS };
