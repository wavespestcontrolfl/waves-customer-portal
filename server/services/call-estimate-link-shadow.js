/**
 * Record-only check for "the after-call estimate text" (owner 2026-11-21, option B, "record-only first").
 *
 * The later job texts the estimate link 2 hours after a call in which the caller said yes to an
 * estimate Waves had already sent, when nothing got booked. THIS module only decides, for each such
 * call, whether that text WOULD go, and writes the verdict on the call's own row:
 * `call_log.metadata.call_estimate_link_shadow`. It sends nothing and mints nothing: no sender, no
 * link or token, no gate, no table, no migration. Undo = revert. A later change adds the sender
 * behind its own gate, after the recorded numbers have been read.
 *
 * Input: the call reader's stored answer `service_request.estimate_response` on
 * `call_log.ai_extraction_enriched` (prompt v35, schema 1.31.0, #8224). The "yes family" is
 * `accepted` and `accepted_with_condition`; the stored row says which one it was.
 *
 * Stored value (ids, the answer, reason codes and ISO times only; never a name, phone, address,
 * link, token or transcript text):
 *   { status: 'skipped', reason, answer, staged_at }                     never eligible (staging)
 *   { status: 'pending', estimate_id, answer, send_at, staged_at }       waiting out the delay
 *   { status: 'would_send', estimate_id, answer, send_at, staged_at, decided_at }
 *   { status: 'skipped', reason, estimate_id, answer, send_at, staged_at, decided_at[, contact] }
 * `would_send` and every `skipped` are terminal. A sweep is `stage` then `decide`.
 *
 * Known limits (each on purpose, each the safe side for a recorder):
 *  - "The estimate" is matched by `call_log.customer_id` only, never by phone. A caller the call
 *    reader did not link to a customer row is `no_customer`, and is never guessed at.
 *  - The estimate is pinned at staging and never re-picked.
 *  - `sms_opted_out` reads the send pipeline's own validators (suppression list and consent
 *    settings) with no send and no write. A read that cannot be answered leaves the row pending.
 *  - The reply check (`customer_replied_since_call`) uses the engagement engine's reply reader on
 *    the shared connection, and it also counts an authenticated email reply, as that reader does.
 *  - A call whose stored extraction is a JSON string rather than an object is not seen by the
 *    staging scan (the jsonb path read returns nothing for it).
 *  - The write does not touch `call_log.updated_at`, so no other job sees this record as a change.
 */

'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { callStartedAt } = require('../utils/call-timeline');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('./messaging/send-window');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { nanpPhoneProblem } = require('../utils/phone');
const { CUSTOMER_ANSWERED_SQL, callLogPhoneFor } = require('./estimate-call-list');
const {
  STAGING_LOOKBACK_DAYS, STAGING_GRACE_MINUTES, STAGING_STALE_MS, QUEUE_SCAN_LOOKBACK_MS, computeSendAt, callEndFor,
  bookedSinceCall, visitStampedWithCall,
} = require('./call-booking-link-text');

const METADATA_KEY = 'call_estimate_link_shadow';
const YES_FAMILY = ['accepted', 'accepted_with_condition'];
const OPEN_STATUSES = ['sent', 'viewed'];
const STAGING_BATCH = 200;
const DECIDE_BATCH = 100;
// A decide that keeps failing to read is given up on this long after its send time.
const UNDECIDED_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// An outbound text that never reached the customer is not contact.
const UNDELIVERED_SMS_STATUSES = ['failed', 'undelivered', 'blocked'];
// The send pipeline purpose the later text would ride; only used to read consent and suppression.
const CONSENT_PURPOSE = 'estimate_followup';
const TRANSIENT_CONSENT_CODES = new Set(['CONSENT_LOOKUP_FAILED', 'SUPPRESSION_LOOKUP_FAILED']);

const CALL_COLUMNS = ['id', 'customer_id', 'direction', 'source', 'bridged_at', 'duration_seconds',
  'recording_duration_seconds', 'created_at', 'metadata'];

function parseMetadata(row) {
  const raw = row?.metadata;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function parseObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// jsonb-merge fragment for `.update({ metadata: ... })`: never clobbers a sibling metadata key.
function metadataPatch(conn, value) {
  return conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [METADATA_KEY]: value })]);
}

const errCode = (err) => err?.code || err?.name || 'error';

// ---------------------------------------------------------------------------------------------
// stage: once per call
// ---------------------------------------------------------------------------------------------

/**
 * The staging scan. SQL does all the narrowing, so an ordinary call is never read or written:
 * a call read as valid, past the grace window, not mid-reprocess, with no record yet, whose stored
 * answer is in the yes family. The stored path is service_request.estimate_response.
 */
function stagingScan(conn, now) {
  const cutoff = new Date(now.getTime() - STAGING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const readyBy = new Date(now.getTime() - STAGING_GRACE_MINUTES * 60 * 1000);
  return conn('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where('v2_extraction_status', 'valid')
    .where('created_at', '>=', cutoff)
    .whereNull('processing_token')
    .where('updated_at', '<=', readyBy)
    .whereRaw('metadata->:key IS NULL', { key: METADATA_KEY })
    .whereRaw("(ai_extraction_enriched->'service_request'->>'estimate_response') = ANY(?)", [YES_FAMILY])
    .orderBy('created_at', 'asc')
    .limit(STAGING_BATCH)
    // processing_token / updated_at / v2_extraction_status: carried so claim() can re-check at UPDATE
    // time what this SELECT filtered on.
    .select(...CALL_COLUMNS, 'processing_token', 'updated_at', 'v2_extraction_status',
      conn.raw("ai_extraction_enriched->'service_request'->>'estimate_response' AS estimate_answer"));
}

// Only the first writer may set the key, and only while the call is still the row the scan read.
async function claim(conn, call, value) {
  const changed = await conn('call_log').where({ id: call.id })
    .whereNull('processing_token')
    .where('v2_extraction_status', 'valid')
    .where('updated_at', call.updated_at)
    .whereRaw('metadata->:key IS NULL', { key: METADATA_KEY })
    .update({ metadata: metadataPatch(conn, value) });
  return changed > 0;
}

// The customer's open sent estimates as of the call's start. Two rows are enough to tell one from several.
function openEstimatesAtCall(conn, customerId, callStart) {
  return conn('estimates').where({ customer_id: customerId })
    .whereIn('status', OPEN_STATUSES)
    .whereNull('archived_at')
    .whereNotNull('sent_at')
    .where('sent_at', '<=', callStart)
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', callStart))
    .limit(2)
    .select('id');
}

// The reason a staged call is skipped at once, or the pinned estimate id.
async function pinEstimate(conn, call, callStart) {
  if (!call.customer_id) return { reason: 'no_customer' };
  const rows = await openEstimatesAtCall(conn, call.customer_id, callStart);
  if (rows.length === 0) return { reason: 'no_open_estimate' };
  if (rows.length > 1) return { reason: 'several_open_estimates' };
  return { estimateId: rows[0].id };
}

// The first moment the later text could go: 2 hours after the call, moved into the send window.
function sendAtFor(call, now) {
  const callEnd = callEndFor(call);
  if (!callEnd) return null;
  // A skewed duration cannot push the time past now: clamp, as the booking-link lane does.
  const clamped = callEnd.getTime() > now.getTime() ? now : callEnd;
  const nominal = computeSendAt(clamped);
  return isWithinSendWindowET(nominal) ? nominal : nextSendWindowOpenET(nominal);
}

async function stageOne(conn, call, now) {
  const staged_at = now.toISOString();
  const answer = call.estimate_answer;
  const skip = (reason) => ({ status: 'skipped', reason, answer, staged_at });
  const callStart = callStartedAt(call) || new Date(call.created_at);
  const pinned = await pinEstimate(conn, call, callStart);
  if (pinned.reason) return { value: skip(pinned.reason), pending: false };
  const sendAt = sendAtFor(call, now);
  if (!sendAt) return { value: skip('no_call_end_time'), pending: false };
  // A time already more than an hour in the past is never queued: a re-enable, downtime or a
  // backlog must not turn into a burst of hours-late records that read as live ones.
  if (now.getTime() - sendAt.getTime() > STAGING_STALE_MS) return { value: skip('stale_at_staging'), pending: false };
  return {
    value: { status: 'pending', estimate_id: pinned.estimateId, answer, send_at: sendAt.toISOString(), staged_at },
    pending: true,
  };
}

/**
 * Evaluates and stamps every yes-family call this job has not yet looked at. Never evaluates a call
 * twice: the metadata key is the "already decided" marker.
 */
async function stage(conn = db, { now = new Date() } = {}) {
  const calls = await stagingScan(conn, now);
  let staged = 0;
  let ineligible = 0;
  for (const call of calls) {
    try {
      const { value, pending } = await stageOne(conn, call, now);
      if (!(await claim(conn, call, value))) continue;
      if (pending) staged += 1; else ineligible += 1;
    } catch (err) {
      logger.warn(`[call-estimate-link-shadow] stage failed for call ${call.id} (${errCode(err)})`);
    }
  }
  // No field named `skipped` here: the scheduler reads `result.skipped` as "no lock for this tick".
  return { staged, ineligible };
}

// ---------------------------------------------------------------------------------------------
// decide: the stops, in order
// ---------------------------------------------------------------------------------------------

// The open-estimate test of the staging rule, without the "sent before the call" part: an estimate
// sent after the call counts here. `now` is the expiry reference.
async function countOpenEstimates(conn, customerId, now) {
  const rows = await conn('estimates').where({ customer_id: customerId })
    .whereIn('status', OPEN_STATUSES)
    .whereNull('archived_at')
    .whereNotNull('sent_at')
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
    .limit(2)
    .select('id');
  return rows.length;
}

const isAfter = (value, instant) => {
  if (!value) return false;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > instant.getTime();
};

// An outbound text to this customer that reached (or may yet reach) them after the call ended.
async function textedSince(conn, { customerId, phones }, since) {
  if (!customerId && !phones.length) return false;
  const row = await excludeRecruitingSmsLog(excludeUnresolvedSendReservations(conn('sms_log')))
    .where({ 'sms_log.direction': 'outbound' })
    .whereNotIn('sms_log.status', UNDELIVERED_SMS_STATUSES)
    .where('sms_log.created_at', '>', since)
    .where((q) => {
      if (customerId) q.where('sms_log.customer_id', customerId);
      if (phones.length) q[customerId ? 'orWhereIn' : 'whereIn']('sms_log.to_phone', phones);
    })
    .first('sms_log.id');
  return !!row;
}

// An outbound call the customer ANSWERED: the Call today list's own proof (CUSTOMER_ANSWERED_SQL).
async function calledSince(conn, phones, since) {
  if (!phones.length) return false;
  const row = await whereNotSandboxCall(conn('call_log'))
    .where({ direction: 'outbound' })
    .whereIn('to_phone', phones)
    .whereRaw(CUSTOMER_ANSWERED_SQL)
    .where('created_at', '>', since)
    .first('id');
  return !!row;
}

// The E.164 forms of the estimate's and the customer's saved phones, without blanks or repeats.
function phoneForms({ estimate, customer }) {
  return [...new Set([estimate?.customer_phone, customer?.phone]
    .map((phone) => callLogPhoneFor({ customer_phone: phone })).filter(Boolean))];
}

async function contactAfterCall(ctx) {
  const { conn, estimate, call, callEnd } = ctx;
  const target = { customerId: call.customer_id || estimate.customer_id, phones: phoneForms(ctx) };
  if (await textedSince(conn, target, callEnd)) return 'text';
  if (await calledSince(conn, target.phones, callEnd)) return 'call';
  if (isAfter(estimate.last_follow_up_at, callEnd)) return 'follow_up';
  if (isAfter(estimate.sent_at, callEnd)) return 'resent';
  return null;
}

// May this customer get an automated text? The send pipeline's own suppression and consent
// validators, read with no send and no write (the pattern customer-text-status.js uses).
async function consentBlock(ctx) {
  const { conn, customer, call } = ctx;
  const { loadContactState, checkConsentForPurpose } = require('./messaging/validators/consent');
  const { loadSuppressionState, checkSuppression } = require('./messaging/validators/suppression');
  const { resolvePolicy } = require('./messaging/policy');
  const input = { audience: 'customer', channel: 'sms', purpose: CONSENT_PURPOSE, customerId: call.customer_id, to: customer.phone };
  const policy = resolvePolicy('customer', CONSENT_PURPOSE);
  let state = await loadContactState(input, conn);
  state = await loadSuppressionState(input, state, conn);
  const unreadable = (verdict) => Object.assign(new Error('consent_unreadable'), { code: verdict.code });
  const suppressed = await checkSuppression(input, policy, state);
  if (!suppressed.ok) {
    if (TRANSIENT_CONSENT_CODES.has(suppressed.code)) throw unreadable(suppressed);
    return suppressed.code;
  }
  // checkSuppression fails open for a text when the do-not-text list could not be read; that is not an answer.
  if (state.suppressionLoaded !== true) throw unreadable({ code: 'SUPPRESSION_LOOKUP_FAILED' });
  const consent = await checkConsentForPurpose(input, policy, state);
  if (consent.ok) return null;
  if (TRANSIENT_CONSENT_CODES.has(consent.code)) throw unreadable(consent);
  return consent.code;
}

const textablePhone = (phone) => !!phone && !nanpPhoneProblem(phone) && !!callLogPhoneFor({ customer_phone: phone });

async function linkNotViewable(ctx) {
  const { isEstimateCustomerViewable } = require('../routes/estimate-public');
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  if (!isEstimateCustomerViewable(ctx.estimate)) return true;
  const data = parseObject(ctx.estimate.estimate_data);
  return !!(await callSideBlockForEstimateData(ctx.conn, data, { estimateStatus: ctx.estimate.status }));
}

/**
 * Every stop, in the order the first one that applies is recorded. A check answers null (clear) or
 * `{ reason, ...extra }`; a check that throws leaves the row pending (see decideOne).
 */
const DECIDE_CHECKS = [
  async ({ estimate }) => (estimate?.status === 'accepted' ? { reason: 'estimate_accepted' } : null),
  async ({ estimate }) => (!estimate || estimate.archived_at || !OPEN_STATUSES.includes(estimate.status)
    ? { reason: 'estimate_closed' } : null),
  async ({ estimate, now }) => (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()
    ? { reason: 'estimate_expired' } : null),
  async ({ conn, estimate, call, now }) => ((await countOpenEstimates(conn, call.customer_id || estimate.customer_id, now)) >= 2
    ? { reason: 'several_open_estimates' } : null),
  async ({ conn, call, customer, callStart }) => ((await bookedSinceCall(conn, call.customer_id, callStart, customer?.phone))
    || (await visitStampedWithCall(conn, call.id)) ? { reason: 'booked' } : null),
  async (ctx) => {
    const contact = await contactAfterCall(ctx);
    return contact ? { reason: 'contact_since_call', contact } : null;
  },
  async ({ estimate, call, customer, callEnd }) => {
    // The engagement engine's reply reader, with since = the call's end (it also reads an authenticated email reply).
    const { hasRepliedSince } = require('./estimate-follow-up');
    const replied = await hasRepliedSince({ ...estimate, customer_id: call.customer_id || estimate.customer_id,
      customer_phone: estimate.customer_phone || customer?.phone }, callEnd, { throwOnError: true });
    return replied ? { reason: 'customer_replied_since_call' } : null;
  },
  // The customer's SAVED phone only, never the caller ID.
  async ({ customer }) => (customer && !customer.deleted_at && textablePhone(customer.phone) ? null : { reason: 'no_textable_phone' }),
  async (ctx) => ((await consentBlock(ctx)) ? { reason: 'sms_opted_out' } : null),
  async (ctx) => ((await linkNotViewable(ctx)) ? { reason: 'link_not_viewable' } : null),
  async ({ conn, estimate }) => {
    const { estimateDeliverableUnderGate } = require('./pricing-authority-gate');
    return (await estimateDeliverableUnderGate(conn, estimate)) ? null : { reason: 'pricing_not_verified' };
  },
];

async function firstStop(ctx) {
  for (const check of DECIDE_CHECKS) {
    const stop = await check(ctx);
    if (stop) return stop;
  }
  return null;
}

// Everything the checks read, read FRESH.
async function loadContext(conn, callId, entry, now) {
  const call = await conn('call_log').where({ id: callId }).first(...CALL_COLUMNS);
  if (!call) throw Object.assign(new Error('call_missing'), { code: 'call_missing' });
  const estimate = await conn('estimates').where({ id: entry.estimate_id }).first();
  const customer = call.customer_id
    ? await conn('customers').where({ id: call.customer_id }).first('id', 'phone', 'deleted_at') : null;
  const callStart = callStartedAt(call) || new Date(call.created_at);
  // No readable end: fall back to the start, which counts more contact (the safe side).
  const callEnd = callEndFor(call) || callStart;
  return { conn, call, entry, estimate, customer, callStart, callEnd, now };
}

// The decision lands only if the row is still pending with the same send_at: two replicas cannot both decide.
async function recordDecision(conn, callId, entry, value) {
  const changed = await conn('call_log').where({ id: callId })
    .whereRaw("metadata->:key->>'status' = 'pending' AND metadata->:key->>'send_at' = :sendAt", { key: METADATA_KEY, sendAt: entry.send_at })
    .update({ metadata: metadataPatch(conn, value) });
  return changed > 0;
}

async function decideOne(conn, callId, entry, now) {
  const base = { estimate_id: entry.estimate_id, answer: entry.answer, send_at: entry.send_at, staged_at: entry.staged_at };
  let verdict;
  try {
    const stop = await firstStop(await loadContext(conn, callId, entry, now));
    verdict = stop ? { status: 'skipped', ...stop } : { status: 'would_send' };
  } catch (err) {
    logger.warn(`[call-estimate-link-shadow] decide failed for call ${callId} (${errCode(err)})`);
    // A read that threw stays pending and is retried next tick, until 24 h past its send time.
    if (now.getTime() - new Date(entry.send_at).getTime() <= UNDECIDED_GIVE_UP_MS) return null;
    verdict = { status: 'skipped', reason: 'undecided_after_24h' };
  }
  const value = { ...verdict, ...base, decided_at: now.toISOString() };
  return (await recordDecision(conn, callId, entry, value)) ? value : null;
}

// Pending rows whose time has come, oldest first. Bounded by the call's age (the booking-link lane's own queue
// window: staging lookback + the 24 h give-up + a day), so a tick never reads the whole call table. A row is staged
// within 3 days of its call and decided or given up within about 38 h of staging, so no live row falls outside it.
function duePending(conn, now) {
  return conn('call_log')
    .where('created_at', '>=', new Date(now.getTime() - QUEUE_SCAN_LOOKBACK_MS))
    .whereRaw("metadata->:key->>'status' = 'pending' AND (metadata->:key->>'send_at')::timestamptz <= :now::timestamptz",
      { key: METADATA_KEY, now: now.toISOString() })
    .orderByRaw("(metadata->:key->>'send_at')::timestamptz ASC", { key: METADATA_KEY })
    .limit(DECIDE_BATCH)
    .select('id', 'metadata');
}

async function decide(conn = db, { now = new Date() } = {}) {
  const rows = await duePending(conn, now);
  let decided = 0;
  let wouldSend = 0;
  for (const row of rows) {
    const entry = parseMetadata(row)[METADATA_KEY];
    if (entry?.status !== 'pending') continue;
    try {
      const value = await decideOne(conn, row.id, entry, now);
      if (!value) continue;
      decided += 1;
      if (value.status === 'would_send') wouldSend += 1;
    } catch (err) {
      logger.warn(`[call-estimate-link-shadow] record failed for call ${row.id} (${errCode(err)})`);
    }
  }
  return { decided, wouldSend };
}

/** One tick: stage new calls, then decide the ones that are due. Counts only. */
async function sweep(conn = db, { now = new Date() } = {}) {
  const { staged, ineligible } = await stage(conn, { now });
  const { decided, wouldSend } = await decide(conn, { now });
  if (staged || ineligible || decided) {
    logger.info(`[call-estimate-link-shadow] staged=${staged} ineligible=${ineligible} decided=${decided} wouldSend=${wouldSend}`);
  }
  return { staged, ineligible, decided, wouldSend };
}

module.exports = {
  METADATA_KEY,
  YES_FAMILY,
  UNDECIDED_GIVE_UP_MS,
  DECIDE_CHECKS,
  sweep,
  stage,
  decide,
  stageOne,
  decideOne,
  stagingScan,
  firstStop,
};
