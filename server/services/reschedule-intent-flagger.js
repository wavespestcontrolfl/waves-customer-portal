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
const { etDateString } = require('../utils/dates');

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
  return db('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', etDateString())
    .where('scheduled_date', '<=', db.raw(`(now() at time zone 'America/New_York')::date + ?::int`, [horizon]))
    .whereIn('status', UPCOMING_SERVICE_STATUSES)
    .orderBy([{ column: 'scheduled_date', order: 'asc' }, { column: 'window_start', order: 'asc' }])
    .first('id', 'scheduled_date', 'window_start', 'service_type', 'status');
}

async function alreadyFlaggedRecently(customerId) {
  const row = await db('agent_decisions')
    .where({ customer_id: customerId, workflow: WORKFLOW, detected_intent: DETECTED_INTENT })
    .where('created_at', '>=', db.raw(`now() - interval '${DEDUPE_HOURS} hours'`))
    .first('id');
  return Boolean(row);
}

/**
 * Flag an inbound SMS that reads as a reschedule/away request.
 * Called fire-and-forget from the Twilio webhook AFTER the TwiML ack.
 * Returns a small result object for tests; never throws.
 */
async function flagInboundRescheduleIntent({ customer, body, smsLogId, messageSid }) {
  try {
    if (!customer?.id || !body) return { flagged: false, reason: 'no_customer_or_body' };
    if (await alreadyFlaggedRecently(customer.id)) return { flagged: false, reason: 'recent_flag' };

    const visit = await nextUpcomingVisit(customer.id);

    await db('agent_decisions').insert({
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
        : 'Inbound SMS reads as a reschedule/away request; no upcoming visit inside the horizon.',
    });

    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('appointment_reschedule_intent', {
        name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer',
        customerId: customer.id,
        message: body,
        visitDate: visit ? String(visit.scheduled_date).slice(0, 10) : null,
        visitService: visit?.service_type || null,
      });
    } catch (e) {
      logger.warn(`[reschedule-intent] bell failed: ${e.message}`);
    }

    return { flagged: true, visitId: visit?.id || null };
  } catch (err) {
    logger.warn(`[reschedule-intent] flag failed: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

module.exports = { flagInboundRescheduleIntent, _private: { nextUpcomingVisit } };
