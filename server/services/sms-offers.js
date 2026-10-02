'use strict';
/**
 * SMS offer ledger (GATE_SMS_OFFER_LEDGER, dark): a durable record of the
 * appointment times a Waves text actually offered.
 *
 * The drafter already persists what a DRAFT quoted (agent_decisions.
 * input_snapshot.open_times_snapshot) and every send seam rechecks it. What was
 * missing is the record of what was SENT: which (date, window) pairs survived
 * into the text the customer received, for which job, and until when the offer
 * stands. A later slice matches the customer's reply against this row; this
 * slice only writes it and counts it (scripts/sms-scheduling-funnel.js).
 *
 * recordOfferForSend runs after the provider accepted the text. It never
 * throws and never sends: the message is already out, and a ledger miss must
 * not turn an accepted send into a failure.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');

const OFFER_TTL_HOURS = 48;
// How far ahead a day label is searched for its calendar date. The pickers
// offer weeks, not months; the label carries no year, so the search must stay
// well under a year to remain unambiguous.
const LABEL_SEARCH_DAYS = 180;

// snapshot.lookup.source (sms-shadow-drafter *_OFFER_SOURCE) → what accepting
// the offer would do. A snapshot with no source predates the scheduler-backed
// offers: it is counted, and never actionable.
const KIND_BY_SOURCE = Object.freeze({ scheduler: 'move_visit', estimate: 'book_estimate', book: 'book_new' });

/** GATE_SMS_OFFER_LEDGER, read at call time: a flip needs no redeploy. */
function offerLedgerLive() {
  return gateEnvValue('GATE_SMS_OFFER_LEDGER');
}

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function etDateOf(instant) {
  // en-CA renders YYYY-MM-DD.
  return new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The calendar date a day label ("Tuesday, September 29") names: the first day
 * on or after the send date (Eastern) that the drafter's own label function
 * renders to exactly that text. Rendering forward and comparing keeps this an
 * exact inverse of the label, with no date parsing. null when nothing matches.
 */
function isoDateForLabel(label, sentAt, dayLabel) {
  const want = String(label || '').trim();
  if (!want) return null;
  const [y, m, d] = etDateOf(sentAt).split('-').map(Number);
  for (let i = 0; i <= LABEL_SEARCH_DAYS; i += 1) {
    const iso = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0)).toISOString().slice(0, 10);
    if (dayLabel({ date: iso }) === want) return iso;
  }
  return null;
}

/**
 * The arrival window a window label ("9:00 AM - 11:00 AM") names, as
 * { start, end } in HH:MM. Same forward-render rule: every quarter-hour start
 * is rendered through the helpers the offer itself was rendered with.
 */
function windowForLabel(label) {
  const want = String(label || '').trim();
  if (!want) return null;
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const range = arrivalWindowRange(start);
    if (range && formatSmsTimeRange(range) === want) return { start, end: range.split('-')[1] };
  }
  return null;
}

/**
 * Pure: the ledger row for one accepted send, or { skip: reason }.
 *   decision       { id, customer_id, suggested_message, input_snapshot }
 *   outgoingBody   the body the send checks approved (before link rewriting)
 * Which pairs count is decided by the SAME planOpenTimesRecheck verdict the
 * send-time check used on this body: an unedited reply keeps the pairs whose
 * window text is still present, an edited one keeps only pairs whose drafted
 * offer span survived verbatim.
 */
function buildOfferRow({ decision, outgoingBody, providerMessageId = null, to, sentAt = new Date(), drafter = require('./sms-shadow-drafter') }) {
  const snapshot = parseJson(decision?.input_snapshot)?.open_times_snapshot || null;
  if (!snapshot?.quotedWindows?.length) return { skip: 'no_offer_snapshot' };
  const phone = phoneLast10(to);
  if (!phone) return { skip: 'no_phone' };
  const plan = drafter.planOpenTimesRecheck({ snapshot, outgoingBody, originalBody: decision.suggested_message });
  if (plan.action === 'refuse') return { skip: 'offer_text_unverifiable' };
  if (plan.action !== 'recheck' || !plan.quotedWindows?.length) return { skip: 'no_offer_in_sent_text' };
  const sent = new Date(sentAt);
  return {
    row: {
      agent_decision_id: decision.id,
      provider_message_id: providerMessageId || null,
      phone_last10: phone,
      ...offerIdentity(snapshot.lookup || {}, decision),
      slots: JSON.stringify(plan.quotedWindows.map((w) => resolveSlot(w, sent, drafter.schedulerDayLabel))),
      sent_at: sent,
      expires_at: new Date(sent.getTime() + OFFER_TTL_HOURS * 3600000),
      status: 'open',
    },
  };
}

// Which job the offer is for. Only the id its own kind commits through is
// kept: a visit offer its visit, a new-visit offer its /book service key.
function offerIdentity(lookup, decision) {
  const source = lookup.source || (lookup.scheduledServiceId ? 'scheduler' : null);
  const kind = KIND_BY_SOURCE[source] || 'unknown';
  return {
    customer_id: lookup.customerId || decision.customer_id || null,
    kind,
    scheduled_service_id: kind === 'move_visit' ? (lookup.scheduledServiceId || null) : null,
    estimate_id: lookup.estimateId || null,
    service_key: kind === 'book_new' ? (lookup.serviceKey || null) : null,
  };
}

// One quoted (date, window) pair as a slot: the labels as sent, plus the
// calendar date and times they name (null when a label cannot be read back).
function resolveSlot(pair, sentAt, dayLabel) {
  const window = windowForLabel(pair.window);
  return {
    date_label: pair.date,
    window_label: pair.window,
    date: isoDateForLabel(pair.date, sentAt, dayLabel),
    start: window ? window.start : null,
    end: window ? window.end : null,
  };
}

/**
 * Record the offer an accepted send carried. Idempotent per decision; a newer
 * offer to the same phone for the same kind supersedes the open one. Returns
 * { recorded: true, id } or { recorded: false, reason } and never throws.
 */
async function recordOfferForSend({ agentDecisionId, outgoingBody, providerMessageId = null, to, sentAt = new Date(), dbh = db } = {}) {
  if (!offerLedgerLive()) return { recorded: false, reason: 'gate_off' };
  if (!agentDecisionId) return { recorded: false, reason: 'no_decision' };
  try {
    const decision = await dbh('agent_decisions').where({ id: agentDecisionId })
      .first('id', 'customer_id', 'suggested_message', 'input_snapshot');
    if (!decision) return { recorded: false, reason: 'decision_not_found' };
    const built = buildOfferRow({ decision, outgoingBody, providerMessageId, to, sentAt });
    if (built.skip) return { recorded: false, reason: built.skip };
    const { row } = built;
    return await dbh.transaction(async (trx) => {
      // Offers to one phone are serialised so "one open offer per phone and
      // kind" holds without a failed insert.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['sms_offers', row.phone_last10]);
      const existing = await trx('sms_offers').where({ agent_decision_id: row.agent_decision_id }).first('id');
      if (existing) return { recorded: false, reason: 'already_recorded', id: existing.id };
      // The lock orders the writes, not the sends: a record can land after a
      // newer text's. The open offer is always the latest SENT one, so a late
      // record of an older text is kept as already superseded.
      const newer = await trx('sms_offers')
        .where({ phone_last10: row.phone_last10, kind: row.kind, status: 'open' })
        .where('sent_at', '>', row.sent_at)
        .first('id');
      if (newer) {
        const [late] = await trx('sms_offers')
          .insert({ ...row, status: 'superseded', superseded_by: newer.id, closed_at: trx.fn.now() })
          .returning('id');
        return { recorded: true, id: late?.id || late, superseded: 0, late: true };
      }
      const prior = await trx('sms_offers')
        .where({ phone_last10: row.phone_last10, kind: row.kind, status: 'open' })
        .update({ status: 'superseded', closed_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning('id');
      const [inserted] = await trx('sms_offers').insert(row).returning('id');
      const id = inserted?.id || inserted;
      if (prior.length) {
        await trx('sms_offers').whereIn('id', prior.map((p) => p.id || p)).update({ superseded_by: id });
      }
      return { recorded: true, id, superseded: prior.length };
    });
  } catch (err) {
    // Code only, never the message: a Knex error embeds the bound phone.
    logger.warn(`[sms-offers] offer not recorded for decision ${agentDecisionId}: ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
    return { recorded: false, reason: 'error' };
  }
}

module.exports = {
  offerLedgerLive,
  recordOfferForSend,
  buildOfferRow,
  isoDateForLabel,
  windowForLabel,
  phoneLast10,
  OFFER_TTL_HOURS,
  KIND_BY_SOURCE,
};
