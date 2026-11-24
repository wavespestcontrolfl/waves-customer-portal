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
 *  - a remembered caller: the number talked with the office (an inbound call a
 *    person answered, 30 s or more, Sandy not involved; or an outbound call
 *    whose customer leg connected for 30 s or more) or left a message longer
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

function rememberedRows(key) {
  return db('call_log').select(db.raw('1'))
    .where((who) => who
      .where((inbound) => inbound
        .where('direction', 'inbound')
        .whereRaw(`${phoneKeySql('from_phone')} = ?`, [key])
        .where((proof) => proof
          // Sandy's time counts toward duration_seconds on a transfer, so any
          // call Sandy touched proves nothing here.
          .whereRaw(`COALESCE(call_outcome, '') NOT IN (${AI_OUTCOMES.map(() => '?').join(', ')})`, AI_OUTCOMES)
          // The webhook's isTransferredRow markers: a Sandy transfer can end
          // with a voicemail outcome.
          .whereRaw("NOT COALESCE(jsonb_typeof(metadata->'relay_handoff') = 'object' OR jsonb_exists(metadata, 'relay_transfer_ring_at'), FALSE)")
          .where((proof) => proof
            // Talk time runs from the staff press 1 (forward_acceptance.accepted_at)
            // to the call's end (metadata.ended_at, Twilio's own end time; the
            // status callback writes it). created_at + duration_seconds is not
            // the end, so a call with no ended_at proves nothing here.
            .where((talked) => talked
              .where('answered_by', 'human')
              .whereRaw(`CASE WHEN metadata->'forward_acceptance'->>'accepted_at' IS NULL OR metadata->>'ended_at' IS NULL THEN FALSE
                ELSE (metadata->>'ended_at')::timestamptz
                  - (metadata->'forward_acceptance'->>'accepted_at')::timestamptz >= make_interval(secs => ?) END`, [TALK_SECONDS]))
            .orWhere((message) => message
              .where((unanswered) => unanswered.whereIn('answered_by', UNANSWERED).orWhereNull('answered_by'))
              .where('recording_duration_seconds', '>', MESSAGE_SECONDS)
              .where((rec) => rec.whereNotNull('recording_sid').orWhereNotNull('recording_url'))
              // Dead air is no message: the transcript must be done and hold
              // words once the no-speech markers are removed.
              .where('transcription_status', 'completed')
              .whereRaw("regexp_replace(COALESCE(transcription, ''), ?, '', 'gi') ~ '[[:alnum:]]'", [NO_SPEECH_SQL])))))
      // An outbound parent call runs while the customer's phone only rings, so
      // its own length proves nothing: the customer leg must have connected
      // for 30 s, or (older bridges with no customer_leg) the bridge recorded
      // from the answer for 30 s, the missed-call service's own fallback proof.
      .orWhere((outbound) => outbound
        .where('direction', 'outbound')
        .whereRaw(`${phoneKeySql('to_phone')} = ?`, [key])
        .where((leg) => leg
          .where((connected) => connected
            .whereRaw("metadata->'customer_leg'->>'status' = 'completed'")
            .whereRaw("CASE WHEN metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$' THEN (metadata->'customer_leg'->>'duration_seconds')::numeric >= ? ELSE FALSE END", [TALK_SECONDS]))
          .orWhere((recorded) => recorded
            .whereRaw("metadata->'customer_leg' IS NULL")
            .whereNotNull('bridged_at')
            .where('recording_duration_seconds', '>=', TALK_SECONDS)
            .where((rec) => rec.whereNotNull('recording_sid').orWhereNotNull('recording_url'))))));
}

/**
 * Should the all-unknown trial challenge this caller? Called only for a caller
 * with no customer match on a first delivery. Never throws.
 * @returns {Promise<boolean>}
 */
async function screenAllUnknownHit(from) {
  const key = callerKey(from);
  if (key.length < 10) return false;
  if (TWILIO_NUMBERS.isInternalNumber(from)) return false;
  try {
    // ONE statement (one connection, one cancelling timeout) answers all three
    // questions, and the wall-clock limit also covers the wait for a connection.
    const read = db.select(
      db.raw('EXISTS (?) AS tech', [technicianRows(key)]),
      db.raw('EXISTS (?) AS lead', [liveLeadRows(key)]),
      db.raw('EXISTS (?) AS remembered', [rememberedRows(key)]),
    ).timeout(READ_TIMEOUT_MS, { cancel: true }).first();
    read.catch(() => {}); // a read that fails after the limit has no one left to tell
    const row = await withinLimit(read, 'timeout');
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

module.exports = { screenAllUnknownHit, withinLimit, callerKey, READ_TIMEOUT_MS, TALK_SECONDS, MESSAGE_SECONDS };
