'use strict';

/**
 * What the technician's-voice review writer did, kept for the Reviews page
 * (GATE_REVIEW_ASK_TECH_VOICE; build plan PR 3, review_ask_drafts):
 *
 *   recordDraft    one row per drafted touch: the text and the record lines
 *                  the fact check cited per sentence, a draft held as a repeat
 *                  of an earlier touch, or why it fell back to the fixed text.
 *                  Best effort: a failed write is logged, never thrown.
 *   listRecent     the page's read: those rows for the last N days, each with
 *                  whether its touch went out, plus the cadences the payment
 *                  hold is holding or dropped (review_sequences.decision).
 */

const db = require('../models/db');
const logger = require('./logger');

const MAX_DAYS = 60;
const MAX_ROWS = 200;
const PAYMENT_HOLD_REASONS = ['payment_hold', 'ask_dropped_payment_hold'];

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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
      evidence: result.outcome === 'fallback' ? null : JSON.stringify({ sentences: result.sentences || [], ...(result.repeat ? { repeat: result.repeat } : {}) }),
      technician_name: techName ? String(techName).slice(0, 80) : null,
      service_type: serviceType ? String(serviceType).slice(0, 120) : null,
      service_date: dateOnly(serviceDate),
    });
  } catch (err) {
    // Never the error message: a query error can carry the insert's values
    // (the draft, the customer's quoted words).
    logger.warn(`[review-ask-drafts] record failed (customerId=${customer?.id} sequenceId=${sequenceId} code=${err?.code || 'none'} errType=${err?.name || 'Error'})`);
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// When THIS outcome reached the customer, or null. A drafted text is the
// sent request carrying exactly its body (a retry on a later day drafts
// afresh, so the step alone would credit every draft). A fallback is the
// first fixed-text request of its step sent after it. A held repeat sends
// nothing.
function sentAtFor(row, sent) {
  if (row.outcome === 'held') return null;
  const sameStep = sent.filter((r) => r.sequence_id === row.sequence_id && r.sequence_step === row.sequence_step && r.channel === row.channel);
  const match = row.outcome === 'drafted'
    ? sameStep.find((r) => r.custom_body === row.body)
    : sameStep
      .filter((r) => !/_tech_voice$/.test(String(r.template_key || '')) && new Date(r.created_at) >= new Date(row.created_at))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
  return match ? (match.sms_sent_at || match.sent_at) : null;
}

function customerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
}

/**
 * { drafts: [...], paymentHolds: [...] } for the last `days` days (1–60).
 * A drafted row reports whether its touch was sent (the cadence's request for
 * that step and channel, its SMS or email send time).
 */
async function listRecent({ days = 14, database = db } = {}) {
  const span = Math.min(Math.max(Number(days) || 14, 1), MAX_DAYS);
  const since = new Date(Date.now() - span * 24 * 60 * 60 * 1000);
  const rows = await database('review_ask_drafts as d')
    .leftJoin('customers as c', 'c.id', 'd.customer_id')
    .where('d.created_at', '>', since)
    .orderBy('d.created_at', 'desc')
    .limit(MAX_ROWS)
    .select('d.*', 'c.first_name', 'c.last_name');
  const sequenceIds = [...new Set(rows.map((r) => r.sequence_id).filter(Boolean))];
  const sent = sequenceIds.length
    ? await database('review_requests')
      .whereIn('sequence_id', sequenceIds)
      .where((q) => q.whereNotNull('sms_sent_at').orWhereNotNull('sent_at'))
      .select('sequence_id', 'sequence_step', 'channel', 'custom_body', 'template_key', 'created_at', 'sms_sent_at', 'sent_at')
    : [];
  const holds = await database('review_sequences as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .where('s.updated_at', '>', since)
    .whereRaw("s.decision->>'reason' = ANY(?)", [PAYMENT_HOLD_REASONS])
    .orderBy('s.updated_at', 'desc')
    .limit(MAX_ROWS)
    .select('s.id', 's.customer_id', 's.status', 's.current_step', 's.decision', 's.updated_at', 'c.first_name', 'c.last_name');
  return {
    days: span,
    drafts: rows.map((r) => {
      const evidence = parseJson(r.evidence) || {};
      return {
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
        technicianName: r.technician_name,
        serviceType: r.service_type,
        serviceDate: r.service_date ? dateOnly(r.service_date) : null,
        createdAt: r.created_at,
        sentAt: sentAtFor(r, sent),
      };
    }),
    paymentHolds: holds.map((h) => {
      const decision = parseJson(h.decision) || {};
      return {
        sequenceId: h.id,
        customerId: h.customer_id,
        customerName: customerName(h),
        status: h.status,
        // The step the hold recorded: a dropped step has already advanced
        // current_step past it.
        step: Number.isInteger(decision.detail?.step) ? decision.detail.step : h.current_step,
        reason: decision.reason,
        detail: decision.detail || null,
        nextEvalAt: decision.nextEvalAt || null,
        at: decision.at || h.updated_at,
      };
    }),
  };
}

module.exports = { recordDraft, listRecent, MAX_DAYS };
