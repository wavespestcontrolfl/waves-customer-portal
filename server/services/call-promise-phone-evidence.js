'use strict';

/**
 * Phone-keyed evidence for the AI close of a Waves promise made on a call with NO customer record
 * (owner 2026-11-05, "A, AI"; GATE_CALL_PROMISE_AI_NO_CUSTOMER). The customer path of
 * call-promise-ai-close.js reads texts, calls, emails and visits by customer id; a promise on an unlinked
 * call (a job candidate, a vendor, a prospect not yet on file) has no id to read by, so it was never judged
 * and never closed (Nov 4: a "text you time frames" promise sat open after the same number called back and
 * a person talked to them for 3.5 minutes).
 *
 * This file is the phone-keyed twin of the record loader (loadSmsFulfillmentEvidence) and of its witness
 * rule, and nothing else. It reads texts and calls in BOTH directions on the caller's phone identity
 * (phoneIdentityKey), with the fields the customer path gives the checker. It reads no emails, visits,
 * estimates or payments: none can belong to a number with no customer. Every guard of the AI close stays
 * (admissibleWitness, the evidence-hash cache, the later-human-text hold, the model budgets); the
 * additions are:
 *   - a shared-phone guard: a number that is one of ours, a carrier sentinel, or that more than one customer
 *     record carries is skipped (the evidence could belong to anyone);
 *   - recruiting texts are never evidence (excludeRecruitingSmsLog), as in the thread check;
 *   - a daily cap on model calls for these promises, counted in audit_log so the watchdog pass and the
 *     Owed-queue pass share it across processes.
 * Reads only, except the cap's audit rows. Sends nothing to anyone.
 */

const logger = require('./logger');
const { phoneIdentityKey } = require('../utils/phone');
const { phoneIdentitySql } = require('./sms-response-policy');
const { isSentinelPhone } = require('./external-phone');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { smsContactSelects, callContactSelects, operatorReply, personCallBack, smsDelivered } = require('./staff-contact');

// Model calls per Eastern day for promises on calls with no customer, across the watchdog pass and the
// Owed-queue pass (owner 2026-11-05: about $0.05 a day expected; 10 calls caps the worst case near $0.33).
const NO_CUSTOMER_DAILY_MODEL_CALLS = 10;
const MODEL_CALL_ACTION = 'call_promise_ai_no_customer_model_call';
const LIMIT = 50;
const TEXT_LIMIT = 16000;

const isOutboundCall = (call) => String(call?.direction || '').startsWith('outbound');
const contactPhoneOf = (call) => (isOutboundCall(call) ? call?.to_phone : call?.from_phone);

// The caller's phone identity from a call row (or a joined candidate row), or null when the number cannot
// identify anyone: blank, a carrier sentinel (anonymous, restricted), or one of our own lines.
function phoneIdentityOf(call) {
  const raw = contactPhoneOf(call);
  if (!raw || isSentinelPhone(raw) || TWILIO_NUMBERS.isInternalNumber(raw)) return null;
  return phoneIdentityKey(raw);
}

// Why a no-customer promise must NOT be judged by phone, or null. 'unusable_phone' = no identity;
// 'multiple_customers' = more than one live customer record carries the number.
async function sharedPhoneReason(conn, call) {
  const key = phoneIdentityOf(call);
  if (!key) return 'unusable_phone';
  const rows = await conn('customers').whereNull('deleted_at')
    .whereRaw(`${phoneIdentitySql('customers.phone')} = ?`, [key]).limit(2).select('id');
  return rows.length > 1 ? 'multiple_customers' : null;
}

// The record loader's phone-keyed twin: { records, failures } in the shape loadSmsFulfillmentEvidence returns.
// `message` is the pseudo message subjectOf builds (created_at = the evidence floor, phone_identity = the key).
async function loadPhoneEvidence(conn, commitment, message, now) {
  const after = new Date(message.created_at);
  const key = message.phone_identity;
  const smsPeer = phoneIdentitySql("(CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END)");
  const callPeer = phoneIdentitySql("(CASE WHEN direction LIKE 'outbound%' THEN to_phone ELSE from_phone END)");
  const sources = {
    // Texts both ways. A reservation placeholder is no text (codex #4331 P2); recruiting threads are owner-only.
    sms: excludeRecruitingSmsLog(excludeUnresolvedSendReservations(conn('sms_log')))
      .whereRaw(`${smsPeer} = ?`, [key]).whereIn('direction', ['inbound', 'outbound'])
      .where('created_at', '>', after).where('created_at', '<=', now).orderBy('created_at', 'desc').limit(LIMIT + 1)
      .select('id', 'direction', 'status', 'message_type', 'message_body', 'created_at', 'from_phone', ...smsContactSelects(conn),
        conn.raw(`CASE WHEN sms_log.metadata->>'scheduled_sms_log_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (SELECT q.created_at FROM sms_log q WHERE q.id = (sms_log.metadata->>'scheduled_sms_log_id')::uuid) END as scheduled_at`)),
    // Calls both ways, with the transcript the customer path reads and who placed or answered them.
    call: require('./voice-agent/relay-protocol').whereNotSandboxCall(conn('call_log'))
      .whereRaw(`${callPeer} = ?`, [key])
      .where('created_at', '>', after).where('created_at', '<=', now).orderBy('created_at', 'desc').limit(LIMIT + 1)
      .select('id', 'direction', 'status', 'duration_seconds', 'transcription', 'answered_by', 'created_at', ...callContactSelects(conn)),
  };
  const entries = Object.entries(sources);
  const results = await Promise.allSettled(entries.map(([, query]) => query));
  const records = [];
  const failures = [];
  results.forEach((result, index) => {
    const type = entries[index][0];
    if (result.status === 'rejected') { failures.push(type); return; }
    if (result.value.length > LIMIT) failures.push(`${type}_truncated`);
    for (const row of result.value.slice(0, LIMIT)) {
      const text = String(row.message_body || row.transcription || '');
      if (text.length > TEXT_LIMIT) failures.push(`${type}_body_truncated`);
      records.push({ ...row, ref: `${type}:${row.id}`, type, text: text.slice(0, TEXT_LIMIT) });
    }
  });
  return { records, failures };
}

// Who counts as a witness for a promise judged by phone (admissibleWitness delegates here):
//   - a text a PERSON sent that was delivered (never an automated send), after the promise;
//   - a call that connected and a person was on it, after the promise: one a person placed through the staff
//     bridge that reached the caller (personCallBack), or one a person answered (answered_by 'human', as the
//     Messages reader reads it), at least a minute long like every call witness. Voicemail, missed, failed
//     and AI-answered calls never count.
// Inbound texts and shorter calls stay context for the model. Whether a witness DELIVERED the promise is the
// model's judgement, quoted and grounded as always.
function phoneWitness(record, commitment) {
  const after = new Date(commitment.sms_context?.source_at);
  if (!(new Date(record.created_at) > after)) return false;
  if (record.type === 'sms') return record.direction === 'outbound' && smsDelivered(record) && operatorReply(record);
  if (record.type === 'call') {
    if (record.status !== 'completed' || !(Number(record.duration_seconds) >= 60)) return false;
    return isOutboundCall(record) ? personCallBack(record) : record.answered_by === 'human';
  }
  return false;
}

// ── The daily cap ───────────────────────────────────────────────────────────

// Model calls already made today (Eastern day) for no-customer promises, across processes.
async function noCustomerCallsToday(conn, etDay) {
  const row = await conn('audit_log').where({ action: MODEL_CALL_ACTION }).whereRaw("metadata->>'etDay' = ?", [etDay]).count({ n: '*' }).first();
  return Number(row?.n) || 0;
}

// One audit row per model call made. Bookkeeping: a failed write is logged and never fails the pass.
async function recordNoCustomerCalls(conn, commitmentId, count, etDay) {
  if (!(count > 0)) return;
  try {
    await conn('audit_log').insert(Array.from({ length: count }, () => ({
      actor_type: 'system', action: MODEL_CALL_ACTION, resource_type: 'call_commitment', resource_id: commitmentId,
      metadata: JSON.stringify({ etDay }),
    })));
  } catch (err) {
    logger.warn(`[call-promise-phone-evidence] could not record ${count} model call(s): ${err.code || err.name}`);
  }
}

module.exports = {
  NO_CUSTOMER_DAILY_MODEL_CALLS, MODEL_CALL_ACTION,
  phoneIdentityOf, sharedPhoneReason, loadPhoneEvidence, phoneWitness, noCustomerCallsToday, recordNoCustomerCalls,
};
