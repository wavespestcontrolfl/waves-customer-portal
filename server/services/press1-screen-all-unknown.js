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
 *    than 10 s on an earlier call nobody answered (no person, no Sandy). A bare key
 *    press is never remembered: in the 60 days to 2026-11-20, 5 robocall
 *    numbers had pressed a key before.
 *
 * The reads share one wall-clock deadline (READ_TIMEOUT_MS, pool wait
 * included) and each also has a cancelling statement timeout. All fail OPEN
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
// trial must never ask a technician to press 1). A failed read throws, so the
// caller fails open.
async function activeTechnicianPhone(key) {
  const row = await db('technicians')
    .where({ employment_status: 'active' })
    .whereRaw(`${phoneKeySql('phone')} = ?`, [key])
    .timeout(READ_TIMEOUT_MS, { cancel: true })
    .first('id');
  return Boolean(row);
}

async function onLiveLead(key) {
  const row = await db('leads')
    .whereNull('deleted_at')
    .whereRaw(`${phoneKeySql('phone')} = ?`, [key])
    .timeout(READ_TIMEOUT_MS, { cancel: true })
    .first('id');
  return Boolean(row);
}

async function rememberedCaller(key) {
  const row = await db('call_log')
    .where((who) => who
      .where((inbound) => inbound
        .where('direction', 'inbound')
        .whereRaw(`${phoneKeySql('from_phone')} = ?`, [key])
        .where((proof) => proof
          // Sandy's time counts toward duration_seconds on a transfer, so any
          // call Sandy touched proves nothing here.
          .whereRaw(`COALESCE(call_outcome, '') NOT IN (${AI_OUTCOMES.map(() => '?').join(', ')})`, AI_OUTCOMES)
          .where((proof) => proof
            .where((talked) => talked.where('answered_by', 'human').where('duration_seconds', '>=', TALK_SECONDS))
            .orWhere((message) => message
              .where((unanswered) => unanswered.whereIn('answered_by', UNANSWERED).orWhereNull('answered_by'))
              .where('recording_duration_seconds', '>', MESSAGE_SECONDS)
              .where((rec) => rec.whereNotNull('recording_sid').orWhereNotNull('recording_url'))))))
      // An outbound parent call runs while the customer's phone only rings, so
      // its own length proves nothing: the customer leg must have connected.
      .orWhere((outbound) => outbound
        .where('direction', 'outbound')
        .whereRaw(`${phoneKeySql('to_phone')} = ?`, [key])
        .whereRaw("metadata->'customer_leg'->>'status' = 'completed'")
        .whereRaw("CASE WHEN metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$' THEN (metadata->'customer_leg'->>'duration_seconds')::numeric >= ? ELSE FALSE END", [TALK_SECONDS])))
    .timeout(READ_TIMEOUT_MS, { cancel: true })
    .first('id');
  return Boolean(row);
}

/**
 * Should the all-unknown trial challenge this caller? Called only for a caller
 * with no customer match on a first delivery. Never throws.
 * @returns {Promise<boolean>}
 */
async function checkReads(key) {
  if (await activeTechnicianPhone(key)) return false;
  if (await onLiveLead(key)) return false;
  return !(await rememberedCaller(key));
}

async function screenAllUnknownHit(from) {
  const key = callerKey(from);
  if (key.length < 10) return false;
  if (TWILIO_NUMBERS.isInternalNumber(from)) return false;
  try {
    const verdict = await withinLimit(checkReads(key), 'timeout');
    if (verdict === 'timeout') {
      logger.warn('[preconnect-screen] all-unknown check ran past its limit (failing open, no challenge)');
      return false;
    }
    return verdict;
  } catch (err) {
    // A code only: a Knex error echoes the bound values, here the caller's number.
    logger.warn(`[preconnect-screen] all-unknown check failed (failing open, no challenge): ${err?.code || err?.name || 'error'}`);
    return false;
  }
}

module.exports = { screenAllUnknownHit, withinLimit, callerKey, READ_TIMEOUT_MS, TALK_SECONDS, MESSAGE_SECONDS };
