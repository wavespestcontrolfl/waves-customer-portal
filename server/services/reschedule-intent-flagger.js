'use strict';

// Inbound-SMS reschedule/away flag — the real-time half of the reschedule
// guard (the daily rollup lives in reschedule-intent-watcher.js).
//
// Incident class (2026-08-05 weekly comms sweep, 4 cases in one week): a
// customer texts "leaving for vacation tomorrow, can we reschedule?" and the
// automation is blind to it — reminders keep firing, the en-route flow runs,
// and in the worst case the visit is performed and invoiced on the day the
// customer asked to move. Nothing in the reminder or dispatch paths reads
// inbound intent at all.
//
// This module DETECTS and SURFACES only — it never mutates the appointment
// and never suppresses automation (repo rule 12: the owner owns
// customer-facing scheduling changes). It writes an agent_decisions row
// (the house record for detected-intent-on-inbound, same table the estimate
// conversion agent uses) linked to the customer's next upcoming visit, and
// rings the owner bell via the appointment_reschedule_intent trigger.
//
// Fail-soft throughout: this runs post-ack in the webhook's setImmediate
// block, so an error here must never affect inbound SMS handling.

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// Only flag when a visit is close enough for the request to be actionable
// noise-free; a "reschedule" text with nothing on the books inside the
// horizon still bells (the customer expects an answer) but carries no visit.
const horizonDays = () => {
  const n = Number(process.env.RESCHEDULE_INTENT_HORIZON_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 14;
};
// One flag per customer per window — a 3-message thread must not ring 3x.
const DEDUPE_HOURS = 48;

const DETECTED_INTENT = 'reschedule_or_away_needs_review';
const WORKFLOW = 'comms_guards';

async function nextUpcomingVisit(customerId) {
  const { UPCOMING_SERVICE_STATUSES } = require('./context-aggregator');
  const horizon = horizonDays();
  const rows = await db('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', etDateString())
    .where('scheduled_date', '<=', db.raw(`(now() at time zone 'America/New_York')::date + ?::int`, [horizon]))
    .whereIn('status', UPCOMING_SERVICE_STATUSES)
    .orderBy([{ column: 'scheduled_date', order: 'asc' }, { column: 'window_start', order: 'asc' }])
    .limit(2)
    .select('id', 'scheduled_date', 'window_start', 'service_type', 'status');
  // Multiple upcoming visits: guessing links the flag (and its
  // resolved-when-moved logic) to the wrong appointment — "move next
  // week's termite inspection" is not about tomorrow's pest visit
  // (codex #3232 r4). Flag without an entity; the bell says so.
  return { visit: rows[0] || null, ambiguous: rows.length > 1 };
}


/**
 * Flag an inbound SMS that reads as a reschedule/away request.
 * Called fire-and-forget from the Twilio webhook AFTER the TwiML ack.
 * Returns a small result object for tests; never throws.
 */
async function flagInboundRescheduleIntent({ customer, body, smsLogId, messageSid }) {
  try {
    if (!customer?.id || !body) return { flagged: false, reason: 'no_customer_or_body' };

    const { visit: nearestVisit, ambiguous } = await nextUpcomingVisit(customer.id);
    const visit = ambiguous ? null : nearestVisit;
    // Atomic dedupe (codex r2): the check and insert share a transaction
    // serialized by a per-customer advisory lock — two texts processed
    // concurrently cannot both pass the check and double-bell.
    let inserted = false;
    await db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext('reschedule-flag:' || ?::text))", [customer.id]);
      const dupe = trx('agent_decisions')
        .where({
          customer_id: customer.id,
          workflow: WORKFLOW,
          detected_intent: DETECTED_INTENT,
          status: 'pending_review',
        })
        .where('created_at', '>=', trx.raw(`now() - interval '${DEDUPE_HOURS} hours'`));
      if (visit?.id) dupe.where('entity_id', visit.id);
      else dupe.whereNull('entity_id');
      if (await dupe.first('id')) return;
      inserted = true;

      await trx('agent_decisions').insert({
        workflow: WORKFLOW,
      agent_name: 'reschedule-intent-flagger',
      decision_version: 'v1',
      mode: 'shadow',
      status: 'pending_review',
      entity_type: visit ? 'scheduled_service' : null,
      entity_id: visit?.id || null,
      customer_id: customer.id,
      source_channel: 'sms',
      sms_log_id: smsLogId || null,
      source_message_id: messageSid || null,
      detected_intent: DETECTED_INTENT,
      confidence: 0.7,
      confidence_label: 'medium',
      input_snapshot: JSON.stringify({
        body_excerpt: String(body).slice(0, 240),
        visit: visit ? {
          id: visit.id,
          scheduled_date: visit.scheduled_date,
          window_start: visit.window_start,
          service_type: visit.service_type,
          status: visit.status,
        } : null,
      }),
      reasoning_summary: visit
        ? `Inbound SMS reads as a reschedule/away request with a visit on ${String(visit.scheduled_date).slice(0, 10)} still armed.`
        : (ambiguous
          ? 'Inbound SMS reads as a reschedule/away request; multiple upcoming visits — not auto-linked.'
          : 'Inbound SMS reads as a reschedule/away request; no upcoming visit inside the horizon.'),
      });
    });
    if (!inserted) return { flagged: false, reason: 'recent_flag' };

    let alerted = false;
    try {
      const { triggerNotification } = require('./notification-triggers');
      const stats = await triggerNotification('appointment_reschedule_intent', {
        name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer',
        customerId: customer.id,
        message: body,
        visitDate: visit ? String(visit.scheduled_date).slice(0, 10) : null,
        visitService: visit?.service_type || null,
      });
      alerted = Boolean(stats && !stats.error
        && (stats.suppressed || stats.bellWritten || Number(stats.push?.sent || 0) > 0));
    } catch (e) {
      logger.warn(`[reschedule-intent] bell failed: ${e.message}`);
    }

    return { flagged: true, alerted, visitId: visit?.id || null };
  } catch (err) {
    logger.warn(`[reschedule-intent] flag failed: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

module.exports = { flagInboundRescheduleIntent, _private: { nextUpcomingVisit } };
