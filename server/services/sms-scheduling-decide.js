'use strict';
/**
 * SMS scheduling decide step, SHADOW (GATE_SMS_SCHEDULING_DECIDE, dark).
 *
 * When a customer texts from a phone that holds open, unexpired offers
 * (sms_offers, written when a Waves text quoting picker times went out), one
 * model (ROUTES.smsSchedulingDecide, owner ruling 2026-10-02: Sonnet 5.5
 * alone) reads the reply against every time those offers carried and answers
 * a fixed question: did they accept one of the offered times, decline, ask for
 * other times, or is it unclear — quoting the words of theirs that say so.
 * Code then checks that answer and records what the executor WOULD have done
 * in sms_offer_decisions:
 *   - every answer: the quote is really in this text, confidence is high, the
 *     offer is this customer's and the sender's number is on file;
 *   - an accept: the time exists and has not started, the picker still offers
 *     it (the same recheck the send path runs), and for a visit move the
 *     call-reschedule fence plus "the visit is exactly as it stood when the
 *     offer went out" (sms_offers.visit_snapshot), read again after the model
 *     answered.
 *
 * The model reads; the code decides. Nothing here moves a visit, books, or
 * sends a text — in this slice every row is shadow, so the decide step can be
 * scored against what staff actually did (scripts/sms-scheduling-funnel.js)
 * before any action is switched on. Never throws.
 *
 * PII: never logs message bodies or phone numbers.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString, dateOnlyString, parseETDateTime } = require('../utils/datetime-et');
const { phoneMatchDigits } = require('../utils/phone');
const { KNOWN_CALLER_PHONE_COLS } = require('../utils/known-caller-phone');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const PROMPT_VERSION = 'sms_sched_decide_v2';
const ACTIONS = Object.freeze(['accept_slot', 'decline', 'asks_other_time', 'unclear']);
const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
// The visit statuses a move may start from (same set the call-reschedule
// automatic path moves: call-reschedule-apply.js MOVABLE_STATUSES).
const MOVABLE_STATUSES = Object.freeze(['pending', 'confirmed']);
const THREAD_ROWS = 10;
const DECIDE_TIMEOUT_MS = 30000;
// A visit snapshot taken this long after the send (a backfilled offer) may
// already miss a change: it proves nothing about the visit at send time.
const SNAPSHOT_MAX_LAG_MS = 10 * 60000;
const KIND_LABEL = Object.freeze({ move_visit: 'to move their upcoming visit', book_estimate: 'to book their quoted service', book_new: 'to book a new visit' });

// Structured output: the model can only answer in this shape. slot_number is
// 1-based across every offered time listed (0 = none); the code range-checks
// it, since the API's schema grammar takes no numeric bounds.
const DECISION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'slot_number', 'customer_quote', 'confidence'],
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    slot_number: { type: 'integer' },
    customer_quote: { type: 'string' },
    confidence: { type: 'string', enum: [...CONFIDENCE] },
  },
});

const SYSTEM_PROMPT = [
  'You read one text message a pest-control customer sent in reply to appointment times the company offered.',
  'Decide what the customer\'s LATEST message says about those offered times. Answer only from what the customer wrote.',
  '',
  'action:',
  '- accept_slot: the customer clearly picks exactly one of the offered times (by day, time, number, or an unambiguous "yes" when only one time was offered).',
  '- decline: the customer says none of the times work, or no longer wants to move/book, and does not ask for anything else.',
  '- asks_other_time: the customer asks for a different day or time than the ones offered, or names a time that was not offered.',
  '- unclear: anything else, including a reply about something unrelated, a question, a "yes" when several times were offered, or a pick that could match more than one offered time.',
  '',
  'slot_number: the number of the offered time the customer picked, as numbered in the list, or 0 when action is not accept_slot.',
  'customer_quote: copy, character for character, the shortest part of the customer\'s LATEST message that shows the answer. Do not paraphrase. Empty only when nothing in the message supports the answer.',
  'confidence: high only when a careful office worker would act on it without asking; otherwise medium or low.',
  'Earlier thread messages are context only: the answer must be in the latest message.',
].join('\n');

/** GATE_SMS_SCHEDULING_DECIDE, read at call time: a flip needs no redeploy. */
function decideLive() {
  return gateEnvValue('GATE_SMS_SCHEDULING_DECIDE');
}

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function hhmm(value) {
  if (value == null) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
}

// The parts of a visit an offer describes: where and when it is, and whether
// it is still live. Compared field by field, never by updated_at (a reminder
// confirmation or a notes edit is not a change to what was offered).
function visitShape(v) {
  if (!v) return null;
  return { date: dateOnlyString(v.scheduled_date ?? v.date) || null, start: hhmm(v.window_start ?? v.start), end: hhmm(v.window_end ?? v.end), status: v.status || null };
}

function sameVisitShape(a, b) {
  return Boolean(a && b) && a.date === b.date && a.start === b.start && a.end === b.end && a.status === b.status;
}

// Case, curly quotes and runs of whitespace are not "different words": the
// quote check compares normalised text, never meaning.
function normalizeForQuote(text) {
  return String(text || '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Every offered time across the phone's open offers, numbered from 1. */
function numberSlots(offers) {
  const out = [];
  for (const offer of offers) {
    (offer.slots || []).forEach((slot, index) => out.push({ offer, slot, index }));
  }
  return out;
}

/** The user message the model reads: the offers as sent, the thread, the reply. */
function buildDecideText({ offers, thread, inboundBody }) {
  const lines = ['OFFERED TIMES (as sent):'];
  numberSlots(offers).forEach(({ offer, slot }, i) => {
    lines.push(`${i + 1}. ${slot.date_label || '?'}, ${slot.window_label || '?'} (${KIND_LABEL[offer.kind] || 'appointment'}; offered ${new Date(offer.sent_at).toISOString()})`);
  });
  lines.push('', 'RECENT THREAD (oldest first):');
  for (const row of thread) {
    lines.push(`[${row.direction === 'inbound' ? 'customer' : 'Waves'}] ${String(row.message_body || '').slice(0, 600)}`);
  }
  lines.push('', 'LATEST CUSTOMER MESSAGE:', String(inboundBody || '').slice(0, 1500));
  return lines.join('\n');
}

/** Pure: the model's JSON as a clean decision, or null when malformed. */
function readDecision(json) {
  if (!json || typeof json !== 'object') return null;
  if (!ACTIONS.includes(json.action) || !CONFIDENCE.includes(json.confidence)) return null;
  if (!Number.isInteger(json.slot_number) || typeof json.customer_quote !== 'string') return null;
  return {
    action: json.action,
    slot_number: json.slot_number,
    customer_quote: json.customer_quote.slice(0, 500),
    confidence: json.confidence,
  };
}

/** Pure: which offer and slot a decision names, against the numbered list. */
function resolvePick(offers, decision) {
  const numbered = numberSlots(offers);
  if (decision?.action !== 'accept_slot') return null;
  return decision.slot_number >= 1 && decision.slot_number <= numbered.length ? numbered[decision.slot_number - 1] : null;
}

/** Pure: the checks every answer must pass, whatever its action. */
function groundingRefusals({ offer, decision, inboundBody, customer, fromPhone }) {
  const refusals = [];
  const quote = normalizeForQuote(decision.customer_quote);
  if (!quote || !normalizeForQuote(inboundBody).includes(quote)) refusals.push('quote_not_in_text');
  if (decision.confidence !== 'high') refusals.push('not_high_confidence');
  if (!offer?.customer_id || String(offer.customer_id) !== String(customer?.id || '')) refusals.push('customer_mismatch');
  const sender = phoneMatchDigits(String(fromPhone || ''));
  const onFile = new Set(KNOWN_CALLER_PHONE_COLS.flatMap((col) => phoneMatchDigits(customer?.[col])));
  if (!sender.some((key) => onFile.has(key))) refusals.push('phone_not_on_file');
  return refusals;
}

/**
 * Pure: the checks on one decision, and what the executor would do.
 *   offer, slot      the picked offer and its slot (accept), or the newest offer
 *   decision         readDecision output
 *   inboundBody      the customer's latest text
 *   customer         the customer row (phone columns)
 *   fromPhone        the number the text came from
 *   visit            the offer's visit read before the model answered (move_visit)
 *   visitAfter       the same visit read again after it answered
 *   movedSinceOffer  a reschedule_log row for the visit after the offer went out
 *   slotStillOpen    { ok, reason } from the picker recheck, or null when not run
 *   now              Date
 * → { outcome, refusals[], would_have|null }
 */
function evaluateDecision({ offer, slot = null, decision, inboundBody, customer, fromPhone, visit = null, visitAfter = null, movedSinceOffer = false, slotStillOpen = null, now = new Date() }) {
  if (!decision) return { outcome: 'error', refusals: [], would_have: null };
  if (decision.action === 'unclear') return { outcome: 'staff', refusals: ['unclear'], would_have: null };
  const refusals = groundingRefusals({ offer, decision, inboundBody, customer, fromPhone });
  if (decision.action === 'decline' || decision.action === 'asks_other_time') {
    return refusals.length ? { outcome: 'staff', refusals, would_have: null } : { outcome: 'no_action', refusals, would_have: null };
  }

  if (!slot) refusals.push('slot_out_of_range');
  if (slot && (!slot.date || !slot.start)) refusals.push('slot_unresolved');
  // Already started (Eastern wall clock): a same-day slot whose start has
  // passed is as gone as yesterday's.
  if (slot?.date && (slot.date < etDateString(now)
    || (slot.start && parseETDateTime(`${slot.date}T${slot.start}`).getTime() <= new Date(now).getTime()))) refusals.push('slot_in_past');
  if (slotStillOpen && slotStillOpen.ok === false) refusals.push('slot_no_longer_open');

  // The slot's end is the customer-facing arrival window, never the job's
  // end: the executor derives that from the visit's own duration.
  const target = slot ? { date: slot.date || null, start: slot.start || null, arrival_end: slot.end || null } : null;
  let would = null;
  let confirmOnly = false;
  if (offer.kind === 'move_visit') {
    const snapshot = parseJson(offer.visit_snapshot, null);
    if (!visit) refusals.push('visit_missing');
    else {
      if (String(visit.customer_id) !== String(offer.customer_id)) refusals.push('visit_customer_mismatch');
      if (!MOVABLE_STATUSES.includes(visit.status)) refusals.push('visit_not_movable');
      if (visit.visit_id) refusals.push('grouped_visit');
      if (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.customer_confirmed !== true) refusals.push('office_review_unconfirmed');
      if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.status === 'pending') refusals.push('dispatch_owned_pending');
      if (movedSinceOffer) refusals.push('moved_since_offer');
      // The visit must be exactly as it stood when the offer went out: any
      // move (including the admin Edit appointment form, which logs none)
      // or status change since means the offer no longer describes it.
      if (!snapshot?.taken_at) refusals.push('no_visit_snapshot');
      else if (new Date(snapshot.taken_at).getTime() - new Date(offer.sent_at).getTime() > SNAPSHOT_MAX_LAG_MS) refusals.push('visit_snapshot_late');
      else if (!sameVisitShape(visitShape(snapshot), visitShape(visit))) refusals.push('visit_changed_since_offer');
      if (visitAfter !== undefined && !sameVisitShape(visitShape(visit), visitShape(visitAfter))) refusals.push('visit_changed_during_decide');
      const from = visitShape(visit);
      // The calendar already shows the accepted time: nothing to write
      // (the bake-off's wrong moves were all of this kind).
      confirmOnly = Boolean(target?.date && from.date === target.date && from.start === target.start);
      would = { kind: 'move_visit', scheduled_service_id: offer.scheduled_service_id, ...target, from: { date: from.date, start: from.start, end: from.end } };
    }
  } else if (offer.kind === 'book_estimate' || offer.kind === 'book_new') {
    would = { kind: offer.kind, estimate_id: offer.estimate_id || null, service_key: offer.service_key || null, ...target };
  } else {
    refusals.push('offer_kind_not_actionable');
  }

  if (refusals.length) return { outcome: 'staff', refusals, would_have: would };
  if (confirmOnly) return { outcome: 'confirm_only', refusals, would_have: would };
  return { outcome: offer.kind === 'move_visit' ? 'would_move' : 'would_book', refusals, would_have: would };
}

/** Every open, unexpired offer a phone holds at `now`, newest first. */
async function findOpenOffers(dbh, phone, now) {
  return dbh('sms_offers')
    .where({ phone_last10: phone, status: 'open' })
    .where('expires_at', '>', now)
    .where('sent_at', '<=', now)
    .orderBy('sent_at', 'desc');
}

// The thread up to (never after) the text being decided: a later message the
// customer sent must not colour the decision on this one.
async function loadThread(dbh, phone, inbound) {
  const rows = await dbh('sms_log')
    .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END, ''), '[^0-9]', '', 'g'), 10) = ?", [phone])
    .whereIn('status', ['received', 'queued', 'sent', 'delivered'])
    .whereNot('id', inbound.id)
    .where('created_at', '<=', inbound.created_at)
    .orderBy('created_at', 'desc')
    .limit(THREAD_ROWS)
    .select('direction', 'message_body', 'created_at');
  return rows.reverse();
}

const VISIT_COLUMNS = ['id', 'customer_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'visit_id', 'source_action', 'customer_confirmed'];

// The picker recheck the send path runs (sms-shadow-drafter
// openTimesStillOffered), for the one accepted time, against the lookup the
// offer's decision persisted. Bounded by the drafter's own timeout.
async function recheckSlot(dbh, offer, slot) {
  const decision = await dbh('agent_decisions').where({ id: offer.agent_decision_id }).first('input_snapshot');
  const lookup = parseJson(decision?.input_snapshot, {})?.open_times_snapshot?.lookup;
  if (!lookup) return { ok: false, reason: 'no_offer_lookup' };
  return require('./sms-shadow-drafter').openTimesStillOffered({
    ...lookup,
    quotedWindows: [{ date: slot.date_label, window: slot.window_label }],
  });
}

/**
 * Run the shadow decide step for one inbound text. `customer` is the
 * webhook's match on the primary phone, or null: a reply from another number
 * on file resolves through the offer's own customer, and the on-file check
 * still applies. Returns { recorded: true, id, outcome } or
 * { recorded: false, reason }. Never throws.
 */
async function runShadowDecision({ customer = null, inboundBody, inboundSmsLogId, fromPhone, now = new Date(), dbh = db, llm = require('./llm/call'), slotRecheck = recheckSlot } = {}) {
  if (!decideLive()) return { recorded: false, reason: 'gate_off' };
  const phone = phoneLast10(fromPhone);
  if (!phone || !inboundSmsLogId || !String(inboundBody || '').trim()) return { recorded: false, reason: 'missing_input' };
  try {
    const rows = await findOpenOffers(dbh, phone, now);
    if (!rows?.length) return { recorded: false, reason: 'no_open_offer' };
    const offers = rows.map((o) => ({ ...o, slots: parseJson(o.slots, []) }));
    const already = await dbh('sms_offer_decisions').where({ inbound_sms_log_id: inboundSmsLogId })
      .whereIn('sms_offer_id', offers.map((o) => o.id)).first('id');
    if (already) return { recorded: false, reason: 'already_decided', id: already.id };
    const inbound = await dbh('sms_log').where({ id: inboundSmsLogId }).first('id', 'created_at');
    if (!inbound) return { recorded: false, reason: 'inbound_missing' };
    const who = customer || (offers[0].customer_id
      ? await dbh('customers').where({ id: offers[0].customer_id }).first('id', ...KNOWN_CALLER_PHONE_COLS)
      : null);
    if (!who) return { recorded: false, reason: 'no_customer' };

    const thread = await loadThread(dbh, phone, inbound);
    const { ROUTES } = require('../config/models');
    const route = ROUTES.smsSchedulingDecide;
    // The visits the offers would move, read before the model answers.
    const visitsBefore = new Map();
    for (const o of offers) {
      if (o.kind === 'move_visit' && o.scheduled_service_id && !visitsBefore.has(o.scheduled_service_id)) {
        visitsBefore.set(o.scheduled_service_id, await dbh('scheduled_services').where({ id: o.scheduled_service_id }).first(VISIT_COLUMNS));
      }
    }
    const result = await llm.dispatch(route, {
      system: SYSTEM_PROMPT,
      text: buildDecideText({ offers, thread, inboundBody }),
      jsonMode: true,
      jsonSchema: DECISION_SCHEMA,
      maxTokens: 400,
      timeoutMs: DECIDE_TIMEOUT_MS,
      laneId: 'sms_scheduling_decide',
      promptVersion: PROMPT_VERSION,
    });
    const decision = result?.ok ? readDecision(result.json) : null;
    const pick = resolvePick(offers, decision);
    const offer = pick?.offer || offers[0];
    const slot = pick?.slot || null;

    let visit = null;
    let visitAfter;
    let movedSinceOffer = false;
    let slotStillOpen = null;
    if (decision?.action === 'accept_slot' && offer.kind === 'move_visit' && offer.scheduled_service_id) {
      visit = visitsBefore.get(offer.scheduled_service_id) || null;
      // Read again now: a move that landed while the model was answering.
      visitAfter = await dbh('scheduled_services').where({ id: offer.scheduled_service_id }).first(VISIT_COLUMNS) || null;
      movedSinceOffer = Boolean(await dbh('reschedule_log')
        .where({ scheduled_service_id: offer.scheduled_service_id })
        .where('created_at', '>', offer.sent_at)
        .first('id'));
    }
    let verdict = evaluateDecision({ offer, slot, decision, inboundBody, customer: who, fromPhone, visit, visitAfter, movedSinceOffer, now });
    // The picker recheck costs a scheduler call: run it only for an accept
    // every other check already passed.
    // (A confirm-only accept writes nothing, so it needs no recheck.)
    if (verdict.outcome === 'would_move' || verdict.outcome === 'would_book') {
      try {
        slotStillOpen = await slotRecheck(dbh, offer, slot);
      } catch {
        slotStillOpen = { ok: false, reason: 'recheck_failed' };
      }
      verdict = evaluateDecision({ offer, slot, decision, inboundBody, customer: who, fromPhone, visit, visitAfter, movedSinceOffer, slotStillOpen, now });
    }

    const row = {
      sms_offer_id: offer.id,
      inbound_sms_log_id: inboundSmsLogId,
      customer_id: who.id,
      mode: 'shadow',
      model: result?.servedModel || route?.model || null,
      prompt_version: PROMPT_VERSION,
      action: decision?.action || null,
      slot_number: decision ? decision.slot_number : null,
      customer_quote: decision?.customer_quote || null,
      confidence: decision?.confidence || null,
      outcome: verdict.outcome,
      refusals: JSON.stringify(verdict.refusals),
      would_have: verdict.would_have ? JSON.stringify(verdict.would_have) : null,
      error: verdict.outcome === 'error' ? String(result?.ok ? 'malformed_answer' : (result?.reason || 'no_result')).slice(0, 60) : null,
    };
    const [inserted] = await dbh('sms_offer_decisions').insert(row)
      .onConflict(['sms_offer_id', 'inbound_sms_log_id']).ignore()
      .returning('id');
    if (!inserted) return { recorded: false, reason: 'already_decided' };
    logger.info(`[sms-scheduling-decide] offer ${offer.id} → ${verdict.outcome}${verdict.refusals.length ? ` (${verdict.refusals.join(',')})` : ''}`);
    return { recorded: true, id: inserted.id || inserted, outcome: verdict.outcome };
  } catch (err) {
    // Code only, never the message: a Knex error embeds bound values.
    logger.warn(`[sms-scheduling-decide] not recorded: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return { recorded: false, reason: 'error' };
  }
}

module.exports = {
  decideLive,
  runShadowDecision,
  evaluateDecision,
  readDecision,
  resolvePick,
  buildDecideText,
  normalizeForQuote,
  visitShape,
  DECISION_SCHEMA,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  ACTIONS,
};
