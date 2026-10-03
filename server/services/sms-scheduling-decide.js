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
const { phoneMatchDigits, phoneIdentityKey } = require('../utils/phone');
const { phoneIdentitySql } = require('./sms-response-policy');
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

// The canonical identity of a US number. An international sender is not
// decided: offers are only recorded for US numbers (sms-offers.js), and a
// last-ten-digits match could otherwise merge two people's conversations.
function phoneLast10(value) {
  const key = phoneIdentityKey(String(value || ''));
  return key && !key.startsWith('+') ? key : null;
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

/** Pure: another standing offer carries the picked slot's date and start. */
function slotIsAmbiguous(offers, pick) {
  if (!pick?.slot?.date || !pick.slot.start) return false;
  return numberSlots(offers).some((o) => o !== pick && o.offer.id !== pick.offer.id
    && o.slot?.date === pick.slot.date && o.slot?.start === pick.slot.start);
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

// A slot whose start has passed on the Eastern wall clock is as gone as
// yesterday's.
function slotStarted(slot, now) {
  if (!slot?.date) return false;
  if (slot.date < etDateString(now)) return true;
  return Boolean(slot.start) && parseETDateTime(`${slot.date}T${slot.start}`).getTime() <= new Date(now).getTime();
}

// The visit must be exactly as it stood when the offer went out: any move
// (including the admin Edit appointment form, which logs none) or status
// change since means the offer no longer describes it. Only a snapshot the
// send step read BEFORE the provider handoff counts (sms-offers.js
// captureOfferVisitSnapshot); a backfilled offer's post-send read could
// already hold an edit, so it proves nothing.
function snapshotRefusal(offer, visit) {
  const snapshot = parseJson(offer.visit_snapshot, null);
  if (snapshot?.pre_send !== true) return 'no_pre_send_snapshot';
  return sameVisitShape(visitShape(snapshot), visitShape(visit)) ? null : 'visit_changed_since_offer';
}

// Each check: [refusal, does it apply]. Table-driven so every safety check
// reads as one line.
const SLOT_CHECKS = [
  ['slot_out_of_range', (c) => !c.slot],
  ['slot_unresolved', (c) => Boolean(c.slot) && (!c.slot.date || !c.slot.start)],
  // Hourly windows only (owner 2026-09-30): a start off the hour is refused,
  // never rounded to one the customer did not pick.
  ['slot_off_hour', (c) => Boolean(c.slot?.start) && !/^\d{2}:00$/.test(c.slot.start)],
  ['slot_in_past', (c) => slotStarted(c.slot, c.now)],
  ['slot_no_longer_open', (c) => c.slotStillOpen?.ok === false],
  // The same time on two standing offers: "Tuesday at 10 works" does not say
  // which job, whatever number the model picked.
  ['ambiguous_slot', (c) => Boolean(c.ambiguousSlot)],
];
const VISIT_CHECKS = [
  ['visit_customer_mismatch', (c) => String(c.visit.customer_id) !== String(c.offer.customer_id)],
  ['visit_not_movable', (c) => !MOVABLE_STATUSES.includes(c.visit.status)],
  ['grouped_visit', (c) => Boolean(c.visit.visit_id)],
  ['office_review_unconfirmed', (c) => OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(c.visit.source_action) && c.visit.customer_confirmed !== true],
  ['dispatch_owned_pending', (c) => DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(c.visit.source_action) && c.visit.status === 'pending'],
  ['moved_since_offer', (c) => Boolean(c.movedSinceOffer)],
  // A staff-owned schedule-change request for this visit may name a newer
  // preferred date (the call-reschedule mover's same fence).
  ['portal_request_open', (c) => Boolean(c.portalRequestOpen)],
  // An unanswered reminder reply-1/2 offer stays actionable for 7 days: a
  // later "1" would move the visit again (the call-reschedule mover's fence).
  ['reminder_offer_pending', (c) => Boolean(c.reminderOfferPending)],
  ['visit_changed_during_decide', (c) => c.visitAfter !== undefined && !sameVisitShape(visitShape(c.visit), visitShape(c.visitAfter))],
];
const failing = (checks, c) => checks.filter(([, applies]) => applies(c)).map(([reason]) => reason);

// What the executor would do, and whether the calendar already shows it.
function plannedAction(c, target) {
  const { offer, visit } = c;
  if (offer.kind === 'move_visit') {
    if (!visit) return { refusals: ['visit_missing'], would: null, confirmOnly: false };
    const snapshot = snapshotRefusal(offer, visit);
    const from = visitShape(visit);
    return {
      refusals: [...failing(VISIT_CHECKS, c), ...(snapshot ? [snapshot] : [])],
      would: { kind: 'move_visit', scheduled_service_id: offer.scheduled_service_id, ...target, from: { date: from.date, start: from.start, end: from.end } },
      // The calendar already shows the accepted time: nothing to write
      // (the bake-off's wrong moves were all of this kind).
      confirmOnly: Boolean(target?.date && from.date === target.date && from.start === target.start),
    };
  }
  if (offer.kind === 'book_estimate' || offer.kind === 'book_new') {
    return { refusals: [], would: { kind: offer.kind, estimate_id: offer.estimate_id || null, service_key: offer.service_key || null, ...target }, confirmOnly: false };
  }
  return { refusals: ['offer_kind_not_actionable'], would: null, confirmOnly: false };
}

/**
 * Pure: the checks on one decision, and what the executor would do.
 *   offer, slot        the picked offer and its slot (accept), or the newest offer
 *   decision           readDecision output
 *   inboundBody        the customer's latest text
 *   customer           the customer row (phone columns)
 *   fromPhone          the number the text came from
 *   visit              the offer's visit read before the model answered (move_visit)
 *   visitAfter         the same visit read again after it answered
 *   movedSinceOffer    a reschedule_log row for the visit after the offer went out
 *   portalRequestOpen  an open staff schedule-change request for the visit
 *   reminderOfferPending an unanswered reminder reply-1/2 offer for the visit
 *   ambiguousSlot      another standing offer carries the same date and start
 *   slotStillOpen      { ok, reason } from the picker recheck, or null when not run
 *   now                Date
 * → { outcome, refusals[], would_have|null }
 */
function evaluateDecision(c) {
  const { decision } = c;
  if (!decision) return { outcome: 'error', refusals: [], would_have: null };
  if (decision.action === 'unclear') return { outcome: 'staff', refusals: ['unclear'], would_have: null };
  const grounding = groundingRefusals(c);
  if (decision.action !== 'accept_slot') {
    return { outcome: grounding.length ? 'staff' : 'no_action', refusals: grounding, would_have: null };
  }
  // The slot's end is the customer-facing arrival window, never the job's
  // end: the executor derives that from the visit's own duration.
  const target = c.slot ? { date: c.slot.date || null, start: c.slot.start || null, arrival_end: c.slot.end || null } : null;
  const plan = plannedAction(c, target);
  const refusals = [...grounding, ...failing(SLOT_CHECKS, c), ...plan.refusals];
  if (refusals.length) return { outcome: 'staff', refusals, would_have: plan.would };
  if (plan.confirmOnly) return { outcome: 'confirm_only', refusals, would_have: plan.would };
  return { outcome: c.offer.kind === 'move_visit' ? 'would_move' : 'would_book', refusals, would_have: plan.would };
}

/**
 * The offers that stood when the text ARRIVED (`at` = the inbound row's
 * created_at), newest first: sent before it, not yet expired, and either still
 * open or superseded only after it (closed_at is the superseding text's send
 * time). A replacement offer sent while this text waited for its decision is
 * not the one the customer answered.
 */
async function findOffersAsOf(dbh, phone, line, at) {
  return dbh('sms_offers')
    // The same customer can hold offers from two Waves lines; a reply reaches
    // one of them, and only that line's offers are its to answer.
    .where({ phone_last10: phone, waves_line: line })
    .where('sent_at', '<=', at)
    .where('expires_at', '>', at)
    .where((q) => q.where('status', 'open')
      .orWhere((sup) => sup.where('status', 'superseded').where('closed_at', '>', at)))
    .orderBy('sent_at', 'desc');
}

// The thread up to (never after) the text being decided: a later message the
// customer sent must not colour the decision on this one.
async function loadThread(dbh, phone, line, inbound) {
  const rows = await dbh('sms_log')
    .whereRaw(`${phoneIdentitySql("CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END")} = ?`, [phone])
    // This Waves line's conversation only.
    .whereRaw(`${phoneIdentitySql("CASE WHEN direction = 'inbound' THEN to_phone ELSE from_phone END")} = ?`, [line])
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

// Phase 1: what stood when the text arrived. null when there is nothing to decide.
async function loadDecideContext(dbh, phone, inboundSmsLogId) {
  const inbound = await dbh('sms_log').where({ id: inboundSmsLogId }).first('id', 'created_at', 'to_phone');
  if (!inbound) return { skip: 'inbound_missing' };
  const line = inbound.to_phone ? phoneIdentityKey(String(inbound.to_phone)) : null;
  if (!line) return { skip: 'no_waves_line' };
  const rows = await findOffersAsOf(dbh, phone, line, inbound.created_at);
  if (!rows?.length) return { skip: 'no_open_offer' };
  const already = await dbh('sms_offer_decisions').where({ inbound_sms_log_id: inboundSmsLogId }).first('id');
  if (already) return { skip: 'already_decided', id: already.id };
  const offers = rows.map((o) => ({ ...o, slots: parseJson(o.slots, []) }));
  const thread = await loadThread(dbh, phone, line, inbound);
  // The visits the offers would move, read before the model answers.
  const visitsBefore = new Map();
  for (const o of offers) {
    if (o.kind === 'move_visit' && o.scheduled_service_id && !visitsBefore.has(o.scheduled_service_id)) {
      visitsBefore.set(o.scheduled_service_id, await dbh('scheduled_services').where({ id: o.scheduled_service_id }).first(VISIT_COLUMNS));
    }
  }
  return { offers, thread, visitsBefore };
}

// Phase 2: the model's reading of the reply, against every standing offer.
async function classifyReply(llm, { offers, thread, inboundBody }) {
  const { ROUTES } = require('../config/models');
  const route = ROUTES.smsSchedulingDecide;
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
  return { result, route, decision: result?.ok ? readDecision(result.json) : null };
}

// Phase 3: the facts the code checks the answer against, read after it.
async function assessFacts(dbh, { offer, decision, customer, visitsBefore, now }) {
  // Who the decision is about: the customer of the offer the reply was
  // judged against (a household phone can hold offers for two records).
  // The webhook's primary-phone match is reused only when it is that
  // customer; either way the sender must be on that customer's file. No
  // customer on the offer: still recorded, and refused as a mismatch.
  const sameCustomer = customer && offer.customer_id && String(customer.id) === String(offer.customer_id);
  const who = sameCustomer ? customer
    : ((offer.customer_id ? await dbh('customers').where({ id: offer.customer_id }).first('id', ...KNOWN_CALLER_PHONE_COLS) : null)
      || customer || { id: null });
  const facts = { who, visit: null, visitAfter: undefined, movedSinceOffer: false, portalRequestOpen: false, reminderOfferPending: false };
  if (decision?.action !== 'accept_slot' || offer.kind !== 'move_visit' || !offer.scheduled_service_id) return facts;
  facts.visit = visitsBefore.get(offer.scheduled_service_id) || null;
  // Read again now: a move that landed while the model was answering.
  facts.visitAfter = await dbh('scheduled_services').where({ id: offer.scheduled_service_id }).first(VISIT_COLUMNS) || null;
  facts.movedSinceOffer = Boolean(await dbh('reschedule_log')
    .where({ scheduled_service_id: offer.scheduled_service_id })
    .where('created_at', '>', offer.sent_at)
    .first('id'));
  const fences = require('./call-reschedule-apply');
  facts.portalRequestOpen = Boolean(offer.customer_id
    && await fences.openPortalRequest(dbh, offer.customer_id, offer.scheduled_service_id));
  facts.reminderOfferPending = Boolean(offer.customer_id
    && await fences.pendingSmsOffer(dbh, offer.customer_id, offer.scheduled_service_id, now));
  return facts;
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
    const ctx = await loadDecideContext(dbh, phone, inboundSmsLogId);
    if (ctx.skip) return { recorded: false, reason: ctx.skip, ...(ctx.id ? { id: ctx.id } : {}) };
    const { result, route, decision } = await classifyReply(llm, { offers: ctx.offers, thread: ctx.thread, inboundBody });
    const pick = resolvePick(ctx.offers, decision);
    const offer = pick?.offer || ctx.offers[0];
    const slot = pick?.slot || null;
    const facts = await assessFacts(dbh, { offer, decision, customer, visitsBefore: ctx.visitsBefore, now });
    const base = {
      offer, slot, decision, inboundBody, customer: facts.who, fromPhone, now,
      visit: facts.visit, visitAfter: facts.visitAfter, movedSinceOffer: facts.movedSinceOffer,
      portalRequestOpen: facts.portalRequestOpen, reminderOfferPending: facts.reminderOfferPending,
      ambiguousSlot: slotIsAmbiguous(ctx.offers, pick),
    };
    let verdict = evaluateDecision(base);
    // The picker recheck costs a scheduler call: run it only for an accept
    // every other check already passed (a confirm-only accept writes nothing).
    if (verdict.outcome === 'would_move' || verdict.outcome === 'would_book') {
      const slotStillOpen = await slotRecheck(dbh, offer, slot).catch(() => ({ ok: false, reason: 'recheck_failed' }));
      // Every fence again, read after the last wait: the visit (against its
      // pre-model read), the portal request, the reminder offer, a logged move.
      const fresh = await assessFacts(dbh, { offer, decision, customer, visitsBefore: ctx.visitsBefore, now });
      verdict = evaluateDecision({
        ...base, slotStillOpen, customer: fresh.who, visitAfter: fresh.visitAfter, movedSinceOffer: fresh.movedSinceOffer,
        portalRequestOpen: fresh.portalRequestOpen, reminderOfferPending: fresh.reminderOfferPending,
      });
    }
    return await recordDecision(dbh, { offer, inboundSmsLogId, who: facts.who, result, route, decision, verdict });
  } catch (err) {
    // Code only, never the message: a Knex error embeds bound values.
    logger.warn(`[sms-scheduling-decide] not recorded: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return { recorded: false, reason: 'error' };
  }
}

// Phase 4: one shadow row per (offer, text); a race to the same row records once.
async function recordDecision(dbh, { offer, inboundSmsLogId, who, result, route, decision, verdict }) {
  const row = {
    sms_offer_id: offer.id,
    inbound_sms_log_id: inboundSmsLogId,
    customer_id: who.id || null,
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
    // One row per text (sms_offer_decisions_one_per_inbound) and per
    // (offer, text): a race on either records once.
    .onConflict().ignore()
    .returning('id');
  if (!inserted) return { recorded: false, reason: 'already_decided' };
  logger.info(`[sms-scheduling-decide] offer ${offer.id} → ${verdict.outcome}${verdict.refusals.length ? ` (${verdict.refusals.join(',')})` : ''}`);
  return { recorded: true, id: inserted.id || inserted, outcome: verdict.outcome };
}

// The AI assistant line answers its own texts; the webhook skips it too.
const AI_NUMBER_DIGITS = ['18559260203', '8559260203'];
const SWEEP_MIN_AGE_MS = 2 * 60000;
const SWEEP_LOOKBACK_MS = 48 * 3600000;
const SWEEP_BATCH = 20;
const SWEEP_MAX_PAGES = 10;

/**
 * Replies the webhook could not decide because their offer was not recorded
 * yet (the customer answered before the post-send ledger write committed, or
 * while it waited for the ledger backfill): every customer text from the last
 * 48h, at least two minutes old, sent to a Waves location line, with no
 * decision row, from a phone that held an offer when it arrived. Each goes
 * through runShadowDecision, which is idempotent per text. Runs right after
 * the offer backfill on its cron. Never throws.
 */
async function sweepUndecidedReplies({ now = new Date(), dbh = db, run = runShadowDecision, batchSize = SWEEP_BATCH, maxPages = SWEEP_MAX_PAGES } = {}) {
  if (!decideLive()) return { scanned: 0, recorded: 0, reason: 'gate_off' };
  const { isSmsReaction } = require('./sms-intent');
  const nowMs = new Date(now).getTime();
  let scanned = 0;
  let recorded = 0;
  let errors = 0;
  let decided = 0;
  // Keyset pages over (created_at, id): a reply skipped here for good (a
  // tapback the type column did not mark) stays undecided, so each run walks
  // past it instead of re-reading the same oldest batch.
  let cursor = null;
  for (let page = 0; page < maxPages && decided < batchSize; page += 1) {
    let rows;
    try {
      const query = dbh('sms_log as sl')
        .where('sl.direction', 'inbound')
        .where('sl.status', 'received')
        // The webhook decides only texts no other handler consumed: a
        // consumer retypes the row (reschedule_reply, lead_intake,
        // sms_reaction, opt_out, ...), so only plain inbound texts qualify.
        .where('sl.message_type', 'inbound')
        .whereRaw("NULLIF(TRIM(sl.message_body), '') IS NOT NULL")
        .where('sl.created_at', '>=', new Date(nowMs - SWEEP_LOOKBACK_MS))
        .where('sl.created_at', '<=', new Date(nowMs - SWEEP_MIN_AGE_MS))
        .whereRaw("sl.metadata->>'source' = 'location'")
        .whereRaw(`REGEXP_REPLACE(COALESCE(sl.to_phone, ''), '[^0-9]', '', 'g') NOT IN (${AI_NUMBER_DIGITS.map(() => '?').join(', ')})`, AI_NUMBER_DIGITS)
        .whereNotExists(function decidedAlready() {
          this.select(dbh.raw('1')).from('sms_offer_decisions as d').whereRaw('d.inbound_sms_log_id = sl.id');
        })
        // Any ordinary reply with no decision yet: one that arrived before
        // its offer was recorded, or one whose webhook decision was lost (a
        // deploy or exit after the acknowledgement). Replies another handler
        // took are excluded below by that handler's own durable record.
        .whereExists(function offered() {
          this.select(dbh.raw('1')).from('sms_offers as o')
            .whereRaw(`o.phone_last10 = ${phoneIdentitySql('sl.from_phone')}`)
            .whereRaw(`o.waves_line = ${phoneIdentitySql('sl.to_phone')}`)
            .whereRaw('o.sent_at <= sl.created_at AND o.expires_at > sl.created_at')
            .whereRaw("(o.status = 'open' OR (o.status = 'superseded' AND o.closed_at > sl.created_at))");
        })
        // A reply the reminder reply-1/2 handler answered (its own durable
        // record: the reply text and when it came), even when the webhook's
        // best-effort retype of the row failed.
        .whereNotExists(function rescheduleReply() {
          this.select(dbh.raw('1')).from('reschedule_log as rl')
            .whereRaw('rl.customer_id = sl.customer_id')
            .whereRaw('rl.customer_response_text = sl.message_body')
            .whereRaw("rl.sms_responded_at BETWEEN sl.created_at - interval '1 minute' AND sl.created_at + interval '10 minutes'");
        })
        // A customer in the lead-intake machine: its replies are intake's.
        .whereNotExists(function inIntake() {
          this.select(dbh.raw('1')).from('customers as c')
            .whereRaw('c.id = sl.customer_id')
            .whereNotNull('c.lead_intake_status')
            .whereNot('c.lead_intake_status', 'estimate_drafted');
        });
      if (cursor) query.whereRaw('(sl.created_at, sl.id) > (?, ?)', [cursor.created_at, cursor.id]);
      rows = await query
        .orderBy([{ column: 'sl.created_at', order: 'asc' }, { column: 'sl.id', order: 'asc' }])
        .limit(batchSize)
        .select('sl.id', 'sl.from_phone', 'sl.message_body', 'sl.created_at');
    } catch (err) {
      logger.warn(`[sms-scheduling-decide] reply sweep scan failed: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
      return { scanned, recorded, errors: errors + 1, reason: 'error' };
    }
    scanned += rows.length;
    for (const r of rows) {
      if (decided >= batchSize) break;
      if (isSmsReaction(r.message_body)) continue;
      decided += 1;
      const result = await run({ customer: null, inboundBody: r.message_body, inboundSmsLogId: r.id, fromPhone: r.from_phone, now, dbh });
      if (result?.recorded) recorded += 1;
      else if (result?.reason === 'error') errors += 1;
    }
    if (rows.length < batchSize) break;
    cursor = rows[rows.length - 1];
  }
  return { scanned, recorded, errors };
}

module.exports = {
  decideLive,
  sweepUndecidedReplies,
  runShadowDecision,
  evaluateDecision,
  readDecision,
  resolvePick,
  slotIsAmbiguous,
  buildDecideText,
  normalizeForQuote,
  visitShape,
  DECISION_SCHEMA,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  ACTIONS,
};
