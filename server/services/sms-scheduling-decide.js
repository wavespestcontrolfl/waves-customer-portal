'use strict';
/**
 * SMS scheduling decide step, SHADOW (GATE_SMS_SCHEDULING_DECIDE, dark).
 *
 * When a customer texts from a phone that holds an open, unexpired offer
 * (sms_offers, written when a Waves text quoting picker times went out), one
 * model (ROUTES.smsSchedulingDecide, owner ruling 2026-10-02: Sonnet 5.5
 * alone) reads the reply and answers a fixed question: did they accept one of
 * the offered slots, decline, ask for other times, or is it unclear — quoting
 * the words of theirs that say so. Code then checks that answer (the quote
 * is really in their text, the slot exists and is still ahead, the phone is on
 * file, the visit is still the movable one the offer was for) and records what
 * the executor WOULD have done in sms_offer_decisions.
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

const PROMPT_VERSION = 'sms_sched_decide_v1';
const ACTIONS = Object.freeze(['accept_slot', 'decline', 'asks_other_time', 'unclear']);
const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
// The visit statuses a move may start from (same set the call-reschedule
// automatic path moves: call-reschedule-apply.js MOVABLE_STATUSES).
const MOVABLE_STATUSES = Object.freeze(['pending', 'confirmed']);
const THREAD_ROWS = 10;
const DECIDE_TIMEOUT_MS = 30000;

// Structured output: the model can only answer in this shape. slot_number is
// 1-based (0 = no slot named); the code range-checks it, since the API's
// schema grammar takes no numeric bounds.
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
  'slot_number: the number of the offered time the customer picked (1 for the first listed), or 0 when action is not accept_slot.',
  'customer_quote: copy, character for character, the shortest part of the customer\'s LATEST message that shows the answer. Do not paraphrase. Empty only when nothing in the message supports the answer.',
  'confidence: high only when a careful office worker would book it without asking; otherwise medium or low.',
  'Earlier thread messages are context only: an acceptance must be in the latest message.',
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

/** The user message the model reads: the offer as sent, the thread, the reply. */
function buildDecideText({ offer, slots, thread, inboundBody }) {
  const lines = ['OFFERED TIMES (as sent):'];
  slots.forEach((s, i) => lines.push(`${i + 1}. ${s.date_label || '?'}, ${s.window_label || '?'}`));
  lines.push('', `OFFER SENT AT: ${new Date(offer.sent_at).toISOString()}`, '', 'RECENT THREAD (oldest first):');
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

/**
 * Pure: the checks on one decision, and what the executor would do.
 *   offer           sms_offers row (slots parsed)
 *   decision        readDecision output
 *   inboundBody     the customer's latest text
 *   customer        the webhook's matched customer row (phone columns)
 *   fromPhone       the number the text came from
 *   visit           the offer's scheduled_services row now (move_visit only), or null
 *   movedSinceOffer a reschedule_log row for the visit after the offer went out
 *   now             Date
 * → { outcome, refusals[], would_have|null }
 */
function evaluateDecision({ offer, decision, inboundBody, customer, fromPhone, visit = null, movedSinceOffer = false, now = new Date() }) {
  if (!decision) return { outcome: 'error', refusals: [], would_have: null };
  if (decision.action === 'decline' || decision.action === 'asks_other_time') return { outcome: 'no_action', refusals: [], would_have: null };
  if (decision.action === 'unclear') return { outcome: 'staff', refusals: ['unclear'], would_have: null };

  const refusals = [];
  const slots = Array.isArray(offer.slots) ? offer.slots : [];
  const slot = decision.slot_number >= 1 && decision.slot_number <= slots.length ? slots[decision.slot_number - 1] : null;
  if (!slot) refusals.push('slot_out_of_range');
  const quote = normalizeForQuote(decision.customer_quote);
  if (!quote || !normalizeForQuote(inboundBody).includes(quote)) refusals.push('quote_not_in_text');
  if (decision.confidence !== 'high') refusals.push('not_high_confidence');
  if (!offer.customer_id || String(offer.customer_id) !== String(customer?.id || '')) refusals.push('customer_mismatch');
  const sender = phoneMatchDigits(String(fromPhone || ''));
  const onFile = new Set(KNOWN_CALLER_PHONE_COLS.flatMap((col) => phoneMatchDigits(customer?.[col])));
  if (!sender.some((key) => onFile.has(key))) refusals.push('phone_not_on_file');
  if (slot && (!slot.date || !slot.start || !slot.end)) refusals.push('slot_unresolved');
  // Already started (Eastern wall clock): a same-day slot whose start has
  // passed is as gone as yesterday's.
  if (slot?.date && (slot.date < etDateString(now)
    || (slot.start && parseETDateTime(`${slot.date}T${slot.start}`).getTime() <= new Date(now).getTime()))) refusals.push('slot_in_past');

  const target = slot ? { date: slot.date || null, start: slot.start || null, end: slot.end || null } : null;
  let would = null;
  let confirmOnly = false;
  if (offer.kind === 'move_visit') {
    if (!visit) refusals.push('visit_missing');
    else {
      if (String(visit.customer_id) !== String(offer.customer_id)) refusals.push('visit_customer_mismatch');
      if (!MOVABLE_STATUSES.includes(visit.status)) refusals.push('visit_not_movable');
      if (visit.visit_id) refusals.push('grouped_visit');
      if (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.customer_confirmed !== true) refusals.push('office_review_unconfirmed');
      if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.status === 'pending') refusals.push('dispatch_owned_pending');
      if (movedSinceOffer) refusals.push('moved_since_offer');
      const from = { date: dateOnlyString(visit.scheduled_date) || null, start: hhmm(visit.window_start), end: hhmm(visit.window_end) };
      // The calendar already shows the accepted slot: nothing to write
      // (the bake-off's wrong moves were all of this kind).
      confirmOnly = Boolean(target?.date && from.date === target.date && from.start === target.start);
      would = { kind: 'move_visit', scheduled_service_id: offer.scheduled_service_id, ...target, from };
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

/** The newest open, unexpired, actionable offer a phone holds at `now`. */
async function findOpenOffer(dbh, phone, now) {
  return dbh('sms_offers')
    .where({ phone_last10: phone, status: 'open' })
    .where('expires_at', '>', now)
    .where('sent_at', '<=', now)
    .orderBy('sent_at', 'desc')
    .first();
}

async function loadThread(dbh, phone, inboundSmsLogId) {
  const rows = await dbh('sms_log')
    .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END, ''), '[^0-9]', '', 'g'), 10) = ?", [phone])
    .whereIn('status', ['received', 'queued', 'sent', 'delivered'])
    .whereNot('id', inboundSmsLogId)
    .orderBy('created_at', 'desc')
    .limit(THREAD_ROWS)
    .select('direction', 'message_body', 'created_at');
  return rows.reverse();
}

/**
 * Run the shadow decide step for one inbound text. Returns
 * { recorded: true, id, outcome } or { recorded: false, reason }. Never throws.
 */
async function runShadowDecision({ customer, inboundBody, inboundSmsLogId, fromPhone, now = new Date(), dbh = db, llm = require('./llm/call') } = {}) {
  if (!decideLive()) return { recorded: false, reason: 'gate_off' };
  const phone = phoneLast10(fromPhone);
  if (!phone || !inboundSmsLogId || !customer?.id || !String(inboundBody || '').trim()) return { recorded: false, reason: 'missing_input' };
  try {
    const offerRow = await findOpenOffer(dbh, phone, now);
    if (!offerRow) return { recorded: false, reason: 'no_open_offer' };
    const offer = { ...offerRow, slots: parseJson(offerRow.slots, []) };
    const already = await dbh('sms_offer_decisions').where({ sms_offer_id: offer.id, inbound_sms_log_id: inboundSmsLogId }).first('id');
    if (already) return { recorded: false, reason: 'already_decided', id: already.id };

    const thread = await loadThread(dbh, phone, inboundSmsLogId);
    let visit = null;
    let movedSinceOffer = false;
    if (offer.kind === 'move_visit' && offer.scheduled_service_id) {
      visit = await dbh('scheduled_services').where({ id: offer.scheduled_service_id })
        .first('id', 'customer_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'visit_id', 'source_action', 'customer_confirmed');
      movedSinceOffer = Boolean(await dbh('reschedule_log')
        .where({ scheduled_service_id: offer.scheduled_service_id })
        .where('created_at', '>', offer.sent_at)
        .first('id'));
    }

    const { ROUTES } = require('../config/models');
    const route = ROUTES.smsSchedulingDecide;
    const result = await llm.dispatch(route, {
      system: SYSTEM_PROMPT,
      text: buildDecideText({ offer, slots: offer.slots, thread, inboundBody }),
      jsonMode: true,
      jsonSchema: DECISION_SCHEMA,
      maxTokens: 400,
      timeoutMs: DECIDE_TIMEOUT_MS,
      laneId: 'sms_scheduling_decide',
      promptVersion: PROMPT_VERSION,
    });
    const decision = result?.ok ? readDecision(result.json) : null;
    const verdict = evaluateDecision({ offer, decision, inboundBody, customer, fromPhone, visit, movedSinceOffer, now });
    const row = {
      sms_offer_id: offer.id,
      inbound_sms_log_id: inboundSmsLogId,
      customer_id: customer.id,
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
  buildDecideText,
  normalizeForQuote,
  DECISION_SCHEMA,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  ACTIONS,
};
