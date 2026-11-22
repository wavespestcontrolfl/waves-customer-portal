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
 *   { status: 'skipped', reason, estimate_id, answer, send_at, staged_at, decided_at[, contact][, answer_now] }
 * `would_send` and every `skipped` are terminal. A sweep is `stage` then `decide`.
 * Reasons at staging: no_customer, no_open_estimate, several_open_estimates, stale_at_staging, no_call_end_time.
 * Stops at decide, first one that applies wins, in this order: answer_changed (the call was read again: no longer
 * valid or no longer a yes; `answer_now` holds the new answer), customer_changed, estimate_accepted, estimate_closed,
 * estimate_expired, follow_ups_off (the estimate's zero-comms stamp, or a self-serve quote staff never delivered),
 * several_open_estimates, booked, contact_since_call (`contact` = text | call | follow_up | resent),
 * customer_replied_since_call, no_textable_phone, number_on_hold (the disclaimed-number hold the send pipeline reads),
 * texts_declined_on_call (this call's own extraction: sms_declined or do_not_contact_request), sms_opted_out,
 * link_not_viewable, pricing_not_verified; undecided_after_24h when a read keeps failing.
 * Decide runs only inside the 8 AM to 8 PM ET send window: a tick outside it decides nothing, so a booking or reply
 * that lands overnight is counted before the verdict. The terminal write is guarded: it lands only if the call row
 * still has the `updated_at` the reads saw and no reprocess token, else the row stays pending for the next tick.
 *
 * Known limits (each on purpose, each the safe side for a recorder):
 *  - "The estimate" is matched by `call_log.customer_id` only, never by phone. A caller the call
 *    reader did not link to a customer row is `no_customer`, and is never guessed at.
 *  - The estimate is pinned at staging and never re-picked. "Open at the call" is historical: an estimate counts
 *    when its FIRST real handoff (call-phone-yes-accept's handoffSql: deliveryState.firstDeliveredAt, else the first
 *    view, else sent_at for a row with no delivery stamp) came before the call began and it was not accepted, declined,
 *    archived or expired by then. A resend never moves that anchor, and an estimate never delivered is no candidate.
 *    When another estimate of the customer was open at the call (even one closed since), the call is
 *    `several_open_estimates`: the caller may have meant the other one.
 *  - A call that was read again while it waited (the answer is no longer a yes, the customer changed, or the call is
 *    mid-reprocess) is never decided on its old read: `answer_changed` / `customer_changed`, or it stays pending.
 *  - `sms_opted_out` reads the send pipeline's own validators (suppression list and consent
 *    settings) with no send and no write. A read that cannot be answered leaves the row pending.
 *  - The reply check (`customer_replied_since_call`) uses the engagement engine's reply reader on
 *    the shared connection, and it also counts an authenticated email reply, as that reader does.
 *  - `texts_declined_on_call` reads this call only (consent.sms_declined, consent.do_not_contact_request). The booking-link
 *    lane's read of an EARLIER call's refusal is not reused: it counts any older call with no recorded answer as a
 *    refusal (an owner ruling for that lane), which would hide most real customers here.
 *  - The give-up is 36 h after send_at, not 24: no tick decides outside the window, so a night (at most 12 h) is not
 *    counted against a read that keeps failing.
 *  - `pricing_not_verified`: pricing-authority-gate swallows a failed link-visible sibling read into `false`, and no
 *    variant surfaces the failure, so a read failure there is recorded as this reason, not retried.
 *  - A call whose stored extraction is a JSON string rather than an object is not seen by the
 *    staging scan (the jsonb path read returns nothing for it).
 *  - The write does not touch `call_log.updated_at`, so no other job sees this record as a change.
 */

'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { callStartedAt } = require('../utils/call-timeline');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('./messaging/send-window');
const { estimateOptedOutOfEngagement } = require('./estimate-comms-eligibility');
const { isUndeliveredSelfServe } = require('./self-serve-estimates');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { nanpPhoneProblem } = require('../utils/phone');
const { CUSTOMER_ANSWERED_SQL, callLogPhoneFor } = require('./estimate-call-list');
const { openEstimatesOf, otherEstimateOpenAt } = require('./call-phone-yes-accept');
const {
  STAGING_LOOKBACK_DAYS, STAGING_GRACE_MINUTES, STAGING_STALE_MS, QUEUE_SCAN_LOOKBACK_MS, computeSendAt, callEndFor,
  bookedSinceCall, visitStampedWithCall,
} = require('./call-booking-link-text');

const METADATA_KEY = 'call_estimate_link_shadow';
const YES_FAMILY = ['accepted', 'accepted_with_condition'];
const OPEN_STATUSES = ['sent', 'viewed'];
const STAGING_BATCH = 200;
const DECIDE_BATCH = 100;
// A decide that keeps failing to read is given up on this long after its send time, plus a night: no tick decides
// outside the send window, so up to 12 hours of the 24 are not tries.
const UNDECIDED_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const NIGHT_MS = 12 * 60 * 60 * 1000;
// An outbound text that never reached the customer is not contact.
const UNDELIVERED_SMS_STATUSES = ['failed', 'undelivered', 'blocked'];
// The send pipeline purpose the later text would ride; only used to read consent and suppression.
const CONSENT_PURPOSE = 'estimate_followup';
const TRANSIENT_CONSENT_CODES = new Set(['CONSENT_LOOKUP_FAILED', 'SUPPRESSION_LOOKUP_FAILED']);

const CALL_COLUMNS = ['id', 'customer_id', 'direction', 'source', 'bridged_at', 'duration_seconds',
  'recording_duration_seconds', 'created_at', 'metadata'];
const ANSWER_PATH_SQL = "ai_extraction_enriched->'service_request'->>'estimate_response'";

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
    // updated_at is carried as TEXT: a JS Date drops its microseconds, so a Date would never match the stored value
    // in claim(), and the call would never be staged. The text form is stable within one session.
    .select(...CALL_COLUMNS, conn.raw('updated_at::text AS updated_at_key'), conn.raw(`${ANSWER_PATH_SQL} AS estimate_answer`));
}

// Only the first writer may set the key, and only while the call is still the row the scan read.
async function claim(conn, call, value) {
  const changed = await conn('call_log').where({ id: call.id })
    .whereNull('processing_token')
    .where('v2_extraction_status', 'valid')
    .whereRaw('updated_at::text = ?', [call.updated_at_key])
    .whereRaw('metadata->:key IS NULL', { key: METADATA_KEY })
    .update({ metadata: metadataPatch(conn, value) });
  return changed > 0;
}

// The estimates the customer can still be sent that were first handed over before the call began. Read through the
// phone-yes card's own helpers: openEstimatesOf (sent or viewed, not archived, not expired, with `handoff_at` = the
// first real handoff, else the first view, else sent_at for a row with no delivery stamp). An estimate with no
// handoff (every send held back or failed, never opened) is not a candidate.
const handoffMs = (estimate) => {
  const ms = estimate.handoff_at ? new Date(estimate.handoff_at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// The reason a staged call is skipped at once, or the pinned estimate id.
async function pinEstimate(conn, call, callStart, now) {
  if (!call.customer_id) return { reason: 'no_customer' };
  const open = await openEstimatesOf(conn, call.customer_id, now);
  const candidates = open.filter((estimate) => handoffMs(estimate) !== null && handoffMs(estimate) <= callStart.getTime());
  if (candidates.length === 0) return { reason: 'no_open_estimate' };
  if (candidates.length > 1) return { reason: 'several_open_estimates' };
  // Open AT the call, not today: another estimate that was open then (accepted or archived since) may be the one
  // the caller meant.
  if (await otherEstimateOpenAt(conn, { customerId: call.customer_id, cardIds: [candidates[0].id], callLogId: call.id })) {
    return { reason: 'several_open_estimates' };
  }
  return { estimateId: candidates[0].id };
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
  const pinned = await pinEstimate(conn, call, callStart, now);
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

// The customer's estimates open today (sent or viewed, not archived, not expired) that were really handed over, at
// any time: one sent after the call counts here.
async function countOpenEstimates(conn, customerId, now) {
  const open = await openEstimatesOf(conn, customerId, now);
  return open.filter((estimate) => handoffMs(estimate) !== null).length;
}

// Was the estimate delivered again after the call ended? A row the send path stamped (deliveryState): its last real
// handoff, never sent_at (a held or failed send stamps sent_at without reaching the customer). A row with no stamp
// (an older send): sent_at is all there is.
function resentAfter(estimate, callEnd) {
  const delivery = parseObject(estimate.estimate_data)?.deliveryState;
  if (delivery && typeof delivery === 'object') return isAfter(delivery.lastDeliveredAt || delivery.firstDeliveredAt, callEnd);
  return isAfter(estimate.sent_at, callEnd);
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
  if (resentAfter(estimate, callEnd)) return 'resent';
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

const coded = (code) => Object.assign(new Error(code), { code });

async function linkNotViewable(ctx) {
  const { isEstimateCustomerViewable, ESTIMATE_TOKEN_RE } = require('../routes/estimate-public');
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  // The public route refuses a token of any other shape, so the link would not open.
  if (!ESTIMATE_TOKEN_RE.test(String(ctx.estimate.token ?? ''))) return true;
  if (!isEstimateCustomerViewable(ctx.estimate)) return true;
  const data = parseObject(ctx.estimate.estimate_data);
  const block = await callSideBlockForEstimateData(ctx.conn, data, { estimateStatus: ctx.estimate.status });
  // Its read failed: not an answer about the link. The row stays pending and is retried.
  if (block === 'call_verdict_unavailable') throw coded('call_verdict_unavailable');
  return !!block;
}

/**
 * Every stop, in the order the first one that applies is recorded. A check answers null (clear) or
 * `{ reason, ...extra }`; a check that throws leaves the row pending (see decideOne).
 */
const DECIDE_CHECKS = [
  // The call was read again while it waited: judge nothing on the old read.
  async ({ call }) => (call.v2_extraction_status !== 'valid' || !YES_FAMILY.includes(call.estimate_answer)
    ? { reason: 'answer_changed', answer_now: call.estimate_answer ?? null } : null),
  async ({ call, estimate }) => (!call.customer_id || (estimate && String(call.customer_id) !== String(estimate.customer_id))
    ? { reason: 'customer_changed' } : null),
  async ({ estimate }) => (estimate?.status === 'accepted' ? { reason: 'estimate_accepted' } : null),
  async ({ estimate }) => (!estimate || estimate.archived_at || !OPEN_STATUSES.includes(estimate.status)
    ? { reason: 'estimate_closed' } : null),
  async ({ estimate, now }) => (estimate.expires_at && new Date(estimate.expires_at).getTime() <= now.getTime()
    ? { reason: 'estimate_expired' } : null),
  // Zero follow-up: the durable opt-out stamp, or a self-serve quote staff never delivered (it promises no text at all).
  async ({ estimate }) => (estimateOptedOutOfEngagement(estimate) || isUndeliveredSelfServe(estimate.source, parseObject(estimate.estimate_data))
    ? { reason: 'follow_ups_off' } : null),
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
  // The send pipeline's own destination-number hold (the caller disclaimed this number). Read-only; the helper throws
  // on a failed read, so the row stays pending.
  async ({ conn, customer }) => ((await require('./disclaimed-number-holds').disclaimedNumberHeld(customer.phone, conn))
    ? { reason: 'number_on_hold' } : null),
  // The caller can say yes to the estimate and decline texts on the same call.
  async ({ call }) => (call.sms_declined === 'true' || call.do_not_contact_request === 'true' ? { reason: 'texts_declined_on_call' } : null),
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
  const call = await conn('call_log').where({ id: callId })
    .first(...CALL_COLUMNS, 'v2_extraction_status', 'processing_token', conn.raw('updated_at::text AS updated_at_key'),
      conn.raw(`${ANSWER_PATH_SQL} AS estimate_answer`),
      conn.raw("ai_extraction_enriched->'consent'->>'sms_declined' AS sms_declined"),
      conn.raw("ai_extraction_enriched->'consent'->>'do_not_contact_request' AS do_not_contact_request"));
  if (!call) throw coded('call_missing');
  // Mid-reprocess: the row is being rewritten, so its answer and customer are not settled. Retry next tick.
  if (call.processing_token) throw coded('call_reprocessing');
  const estimate = await conn('estimates').where({ id: entry.estimate_id }).first();
  const customer = call.customer_id
    ? await conn('customers').where({ id: call.customer_id }).first('id', 'phone', 'deleted_at') : null;
  const callStart = callStartedAt(call) || new Date(call.created_at);
  // No readable end: fall back to the start, which counts more contact (the safe side).
  const callEnd = callEndFor(call) || callStart;
  return { conn, call, entry, estimate, customer, callStart, callEnd, now };
}

// The decision lands only if the row is still pending with the same send_at: two replicas cannot both decide. A verdict
// from a successful read also lands only if the call row is still the one that read saw (`guard` = its updated_at as
// text, no reprocess token): a reprocess keeps the pending marker and send_at, so those alone cannot tell. A lost write
// leaves the row pending for the next tick. The give-up write has no read to protect and passes no guard.
async function recordDecision(conn, callId, entry, value, guard = null) {
  const changed = await conn('call_log').where({ id: callId })
    .whereRaw("metadata->:key->>'status' = 'pending' AND metadata->:key->>'send_at' = :sendAt", { key: METADATA_KEY, sendAt: entry.send_at })
    .modify((q) => { if (guard) q.whereNull('processing_token').whereRaw('updated_at::text = ?', [guard]); })
    .update({ metadata: metadataPatch(conn, value) });
  return changed > 0;
}

async function decideOne(conn, callId, entry, now) {
  const base = { estimate_id: entry.estimate_id, answer: entry.answer, send_at: entry.send_at, staged_at: entry.staged_at };
  let verdict;
  let guard = null;
  try {
    const ctx = await loadContext(conn, callId, entry, now);
    guard = ctx.call.updated_at_key;
    const stop = await firstStop(ctx);
    verdict = stop ? { status: 'skipped', ...stop } : { status: 'would_send' };
  } catch (err) {
    logger.warn(`[call-estimate-link-shadow] decide failed for call ${callId} (${errCode(err)})`);
    // A read that threw stays pending and is retried next tick, until 24 h (and a night) past its send time.
    if (now.getTime() - new Date(entry.send_at).getTime() <= UNDECIDED_GIVE_UP_MS + NIGHT_MS) return null;
    verdict = { status: 'skipped', reason: 'undecided_after_24h' };
    guard = null;
  }
  const value = { ...verdict, ...base, decided_at: now.toISOString() };
  return (await recordDecision(conn, callId, entry, value, guard)) ? value : null;
}

// Pending rows whose time has come, oldest first. Bounded by the call's age (the booking-link lane's own queue
// window: staging lookback + the 24 h give-up + a day), so a tick never reads the whole call table. A row is staged
// within 3 days of its call and decided or given up within about 38 h of staging, so no live row falls outside it.
function duePending(conn, now) {
  // A sandbox test call is never staged, so it never carries the key; the exclusion still rides this read, as on
  // every call_log scan that is not keyed by id.
  return whereNotSandboxCall(conn('call_log'))
    .where('created_at', '>=', new Date(now.getTime() - QUEUE_SCAN_LOOKBACK_MS))
    .whereRaw("metadata->:key->>'status' = 'pending' AND (metadata->:key->>'send_at')::timestamptz <= :now::timestamptz",
      { key: METADATA_KEY, now: now.toISOString() })
    .orderByRaw("(metadata->:key->>'send_at')::timestamptz ASC", { key: METADATA_KEY })
    .limit(DECIDE_BATCH)
    .select('id', 'metadata');
}

async function decide(conn = db, { now = new Date() } = {}) {
  // Outside the send window no text could go: decide nothing, so an overnight booking or reply counts at the opening.
  // The wait is not an error and not a failed try (see NIGHT_MS).
  if (!isWithinSendWindowET(now)) return { decided: 0, wouldSend: 0 };
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
  NIGHT_MS,
  DECIDE_CHECKS,
  sweep,
  stage,
  decide,
  stageOne,
  decideOne,
  loadContext,
  recordDecision,
  stagingScan,
  firstStop,
};
