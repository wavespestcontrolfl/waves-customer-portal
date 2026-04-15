/**
 * Autopay Log — audit trail writer for all autopay-related events.
 *
 * Every autopay state change (toggle, pause, resume, card swap, billing-day change)
 * and every charge outcome (success, failure, skip reason) gets a row here.
 * This is the source of truth for billing disputes and admin visibility.
 */

const db = require('../models/db');
const logger = require('./logger');

/**
 * Log an autopay event.
 * @param {string} customerId  — UUID of the customer
 * @param {string} eventType   — see migration for enum of event types
 * @param {Object} [opts]
 * @param {number} [opts.amountCents]
 * @param {string} [opts.paymentMethodId]
 * @param {string} [opts.paymentId]
 * @param {Object} [opts.details] — arbitrary JSONB context
 */
async function logAutopay(customerId, eventType, opts = {}) {
  try {
    const row = {
      customer_id: customerId,
      event_type: eventType,
      amount_cents: opts.amountCents ?? null,
      payment_method_id: opts.paymentMethodId ?? null,
      payment_id: opts.paymentId ?? null,
      details: opts.details ? JSON.stringify(opts.details) : null,
    };
    await db('autopay_log').insert(row);
  } catch (err) {
    // Never let logging failures break billing flow
    logger.error(`[autopay-log] Failed to log ${eventType} for ${customerId}: ${err.message}`);
  }
}

/**
 * Fetch recent autopay log entries for a customer (newest first).
 */
async function getRecent(customerId, limit = 50) {
  return db('autopay_log')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .limit(limit);
}

/**
 * Check if an event of a given type exists for a customer in the last N days.
 * Used to prevent duplicate notifications (e.g. card-expiring-soon reminders).
 */
async function eventExistsRecently(customerId, eventType, withinDays = 30, paymentMethodId = null) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - withinDays);

  let q = db('autopay_log')
    .where({ customer_id: customerId, event_type: eventType })
    .where('created_at', '>=', cutoff);
  if (paymentMethodId) q = q.where({ payment_method_id: paymentMethodId });

  const row = await q.first();
  return !!row;
}

module.exports = { logAutopay, getRecent, eventExistsRecently };
