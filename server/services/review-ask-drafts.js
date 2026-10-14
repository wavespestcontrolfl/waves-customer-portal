'use strict';

/**
 * What the technician's-voice review writer did, kept for the Reviews page
 * (GATE_REVIEW_ASK_TECH_VOICE; build plan PR 3, review_ask_drafts):
 *
 *   recordDraft        one row per drafted touch: the text and the record
 *                      lines the fact check cited per sentence, a draft held
 *                      as a repeat of an earlier touch, or why it fell back
 *                      to the fixed text.
 *                      Also the sender's own fallback: a draft that would
 *                      not fit with the full review link (reason 'long_link',
 *                      evidence.requestId = the request that carried the
 *                      fixed text instead).
 *   recordPaymentDrop  one row when a payment-held step is dropped (outcome
 *                      'held', reason 'payment_hold_dropped'): the sequence's
 *                      decision is only its latest one, and the next step
 *                      overwrites it. Throws: the step runner writes it in
 *                      the transaction that advances the step.
 *   listRecent         the page's read: those rows for the last N days, each
 *                      with whether its touch went out, plus the cadences a
 *                      payment hold is holding right now
 *                      (review_sequences.decision).
 *
 * Both are best effort for the send: a failed write is logged (recordDraft
 * here, the payment drop by its caller) and never blocks a touch.
 */

const db = require('../models/db');
const logger = require('./logger');

const MAX_DAYS = 60;
const MAX_ROWS = 200;
const PAYMENT_DROP_REASON = 'payment_hold_dropped';
const LONG_LINK_REASON = 'long_link';

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Never the error message: a query error can carry the insert's values (the
// draft, the customer's quoted words).
function warnWrite(what, customerId, sequenceId, err) {
  logger.warn(`[review-ask-drafts] ${what} failed (customerId=${customerId} sequenceId=${sequenceId} code=${err?.code || 'none'} errType=${err?.name || 'Error'})`);
}

async function recordDraft({ customer, sequenceId = null, sequenceStep = null, channel = null, techName = null, serviceType = null, serviceDate = null }, result, database = db) {
  try {
    await database('review_ask_drafts').insert({
      customer_id: customer.id,
      sequence_id: sequenceId,
      sequence_step: sequenceStep,
      channel,
      outcome: result.outcome,
      reason: result.reason ? String(result.reason).slice(0, 80) : (result.outcome === 'held' ? 'repeat' : null),
      body: result.body || null,
      evidence: result.outcome === 'fallback'
        ? (result.requestId ? JSON.stringify({ requestId: result.requestId }) : null)
        : JSON.stringify({ sentences: result.sentences || [], ...(result.repeat ? { repeat: result.repeat } : {}) }),
      technician_name: techName ? String(techName).slice(0, 80) : null,
      service_type: serviceType ? String(serviceType).slice(0, 120) : null,
      service_date: dateOnly(serviceDate),
    });
  } catch (err) {
    warnWrite('record', customer?.id, sequenceId, err);
  }
}

// `seq` is the review_sequences row whose current step is being dropped;
// `detail` is the hold's own ({ step, hold, heldSince, invoiceId? }).
// `database` is the caller's transaction; a failed write throws to it.
async function recordPaymentDrop(seq, detail, database = db) {
  const step = Number.isInteger(detail?.step) ? detail.step : seq.current_step;
  await database('review_ask_drafts').insert({
    customer_id: seq.customer_id,
    sequence_id: seq.id,
    sequence_step: step,
    channel: (parseJson(seq.plan) || [])[step]?.channel === 'email' ? 'email' : 'sms',
    outcome: 'held',
    reason: PAYMENT_DROP_REASON,
    body: null,
    evidence: JSON.stringify({ hold: detail || null }),
    service_type: seq.service_type ? String(seq.service_type).slice(0, 120) : null,
  });
}

function customerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
}

// The request the sender switched to the fixed text because the draft would
// not fit with the full review link (recordDraft's long_link row), or null.
function longLinkRequestId(row) {
  return row.reason === LONG_LINK_REASON ? (parseJson(row.evidence)?.requestId || null) : null;
}

const sameTouch = (a, b) => a.sequence_id === b.sequence_id && a.sequence_step === b.sequence_step && a.channel === b.channel;

// The requests of this outcome's touch made inside its own window, oldest
// first: from when it was recorded until the next outcome of the same step
// and channel, so neither an earlier send nor a later retry's send is
// credited to it.
function requestsInWindow(row, requests, rows) {
  const from = new Date(row.created_at);
  const until = rows
    .filter((o) => o !== row && sameTouch(o, row) && new Date(o.created_at) > from)
    .map((o) => new Date(o.created_at))
    .sort((a, b) => a - b)[0] || null;
  return requests
    .filter((r) => sameTouch(r, row) && new Date(r.created_at) >= from && (!until || new Date(r.created_at) < until))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

// The requests that could have carried THIS outcome to the customer (a
// same-day retry reuses the persisted draft, so one outcome can have a failed
// attempt followed by a successful one). A drafted text is the request with
// exactly its body (a retry on a later day drafts afresh, so the step alone
// would credit every draft). A fallback is the first fixed-text request (no
// drafted body) of its step; a long-link fallback is recorded at send time,
// after its request was made, so it names that request. A held step sends
// nothing.
function requestsFor(row, requests, rows) {
  if (row.outcome === 'held') return [];
  const named = longLinkRequestId(row);
  if (named) return requests.filter((r) => r.id === named && !r.custom_body);
  return requestsInWindow(row, requests, rows)
    .filter((r) => (row.outcome === 'drafted' ? r.custom_body === row.body : !r.custom_body));
}

// When one of those requests reached the customer: its own send stamp, else
// the sender's durable delivery evidence (review-request.js
// reviewAskDeliveryEvidenceFor: the provider accepted the text but the stamp
// write failed), read once for the whole page. The first one that did, or null.
function sentAtOf(candidates, evidence) {
  for (const request of candidates) {
    const stamped = request.sms_sent_at || request.sent_at;
    if (stamped) return stamped;
    const proof = evidence.get(String(request.id));
    if (proof) return proof.created_at;
  }
  return null;
}

/**
 * { days, truncated, holdsTruncated, drafts: [...], paymentHolds: [...] } for
 * the last `days` days (1–60). `truncated` / `holdsTruncated`: the window
 * holds more outcomes / payment holds than are returned (the newest MAX_ROWS
 * of each are). paymentHolds are the cadences waiting on a
 * payment hold now; a dropped one is a draft row (reason payment_hold_dropped).
 */
async function listRecent({ days = 14, database = db } = {}) {
  const span = Math.min(Math.max(Number(days) || 14, 1), MAX_DAYS);
  const since = new Date(Date.now() - span * 24 * 60 * 60 * 1000);
  const found = await database('review_ask_drafts as d')
    .leftJoin('customers as c', 'c.id', 'd.customer_id')
    .where('d.created_at', '>', since)
    .orderBy('d.created_at', 'desc')
    .limit(MAX_ROWS + 1)
    .select('d.*', 'c.first_name', 'c.last_name');
  const rows = found.slice(0, MAX_ROWS);
  const sequenceIds = [...new Set(rows.map((r) => r.sequence_id).filter(Boolean))];
  const namedIds = rows.map(longLinkRequestId).filter(Boolean);
  const requests = sequenceIds.length || namedIds.length
    ? await database('review_requests')
      .where((q) => q.whereIn('sequence_id', sequenceIds).orWhereIn('id', namedIds))
      .select('id', 'customer_id', 'sequence_id', 'sequence_step', 'channel', 'custom_body', 'created_at', 'sms_sent_at', 'sent_at')
    : [];
  const holds = await database('review_sequences as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .where('s.status', 'active')
    .where('s.updated_at', '>', since)
    .whereRaw("s.decision->>'reason' = ?", ['payment_hold'])
    .orderBy('s.updated_at', 'desc')
    .limit(MAX_ROWS + 1)
    .select('s.id', 's.customer_id', 's.current_step', 's.plan', 's.decision', 's.updated_at', 'c.first_name', 'c.last_name');
  // One evidence read for every unstamped text on the page, not one per row.
  const candidates = new Map(rows.map((r) => [r, requestsFor(r, requests, rows)]));
  const unstamped = [...new Set([...candidates.values()].flat())]
    .filter((q) => q.channel === 'sms' && !(q.sms_sent_at || q.sent_at));
  const evidenceBy = unstamped.length
    ? await require('./review-request').reviewAskDeliveryEvidenceFor(unstamped)
    : new Map();
  const drafts = [];
  for (const r of rows) {
    const evidence = parseJson(r.evidence) || {};
    // A draft whose request was switched to the fixed text (the long-link row
    // names it): the draft will never send, so the page must not say "not
    // yet". Whether the fixed text went out is the long-link row's own sentAt.
    const replaced = r.outcome === 'drafted' && requestsInWindow(r, requests, rows).some((q) => namedIds.includes(q.id));
    drafts.push({
      id: r.id,
      customerId: r.customer_id,
      customerName: customerName(r),
      sequenceId: r.sequence_id,
      step: r.sequence_step,
      channel: r.channel,
      outcome: r.outcome,
      reason: r.reason,
      body: r.body,
      sentences: Array.isArray(evidence.sentences) ? evidence.sentences : [],
      repeat: evidence.repeat || null,
      hold: evidence.hold || null,
      technicianName: r.technician_name,
      serviceType: r.service_type,
      serviceDate: r.service_date ? dateOnly(r.service_date) : null,
      createdAt: r.created_at,
      sentAt: sentAtOf(candidates.get(r), evidenceBy),
      replacedByFixedText: replaced,
    });
  }
  return {
    days: span,
    truncated: found.length > MAX_ROWS,
    holdsTruncated: holds.length > MAX_ROWS,
    drafts,
    paymentHolds: holds.slice(0, MAX_ROWS).map((h) => {
      const decision = parseJson(h.decision) || {};
      // The step the hold recorded; its channel is the plan's (an email step
      // is held like a text).
      const step = Number.isInteger(decision.detail?.step) ? decision.detail.step : h.current_step;
      return {
        sequenceId: h.id,
        customerId: h.customer_id,
        customerName: customerName(h),
        step,
        channel: (parseJson(h.plan) || [])[step]?.channel === 'email' ? 'email' : 'sms',
        detail: decision.detail || null,
        nextEvalAt: decision.nextEvalAt || null,
        at: decision.at || h.updated_at,
      };
    }),
  };
}

module.exports = { recordDraft, recordPaymentDrop, listRecent, warnWrite, MAX_DAYS, MAX_ROWS, PAYMENT_DROP_REASON, LONG_LINK_REASON };
