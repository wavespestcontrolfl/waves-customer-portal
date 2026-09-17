const db = require('../models/db');
const logger = require('./logger');
const { triggerNotification } = require('./notification-triggers');

const TABLE = 'stripe_payment_notification_log';
const SETTLED_STATUSES = ['paid', 'refunded', 'disputed'];

async function enqueuePaymentFailureNotification(paymentIntent, friendlyFailure, eventId) {
  const charge = paymentIntent.latest_charge;
  const attemptId = (typeof charge === 'object' ? charge?.id : charge) || eventId || 'no_charge';
  // Only the durable insert belongs in the webhook: no recipient lookup or push.
  return db(TABLE).insert({
    payment_intent_id: paymentIntent.id,
    outcome: 'failed',
    attempt_id: attemptId,
    pending_payload: {
      amount: (paymentIntent.amount || 0) / 100,
      customerId: paymentIntent.metadata?.waves_customer_id || null,
      reason: friendlyFailure,
    },
  }).onConflict(['payment_intent_id', 'outcome', 'attempt_id']).ignore();
}

async function dispatchPendingNotification(trx, key) {
  const job = await trx(TABLE).where(key).whereNotNull('pending_payload')
    .forUpdate().skipLocked().first();
  if (!job) return false;

  const piId = job.payment_intent_id;
  const ledgerRow = await trx('payments').where({ stripe_payment_intent_id: piId }).first();
  let settled = SETTLED_STATUSES.includes(ledgerRow?.status);
  if (!settled) {
    const payload = job.pending_payload;
    const invoice = await trx('invoices').where({ stripe_payment_intent_id: piId }).first();
    const customerId = invoice?.customer_id || ledgerRow?.customer_id || payload.customerId || null;
    const customer = (customerId ? await trx('customers').where({ id: customerId }).first() : null) || {};
    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
      || customer.phone || 'customer';
    let recheckError = null;
    const shouldContinue = async () => {
      try {
        // READ COMMITTED sees success/refund/dispute committed during fan-out.
        const settledRow = await trx('payments').where({ stripe_payment_intent_id: piId })
          .whereIn('status', SETTLED_STATUSES).first('id');
        settled = settled || Boolean(settledRow);
        return !settled && !recheckError;
      } catch (error) {
        // The trigger's beforePush error fallback is fail-open; return false
        // explicitly and retain the queued job for a healthy retry instead.
        recheckError = error;
        return false;
      }
    };
    const result = await triggerNotification('payment_failed', {
      amount: payload.amount,
      customerName,
      customerId,
      reason: payload.reason,
      invoiceId: invoice?.id || null,
      paymentIntentId: piId,
      attemptId: job.attempt_id,
    }, {
      dedupeKey: `payment-failed:${piId}:${job.attempt_id}`,
      shouldContinue,
      beforePush: shouldContinue,
    });
    if (recheckError) throw recheckError;
    const { bellWritten, push, suppressed, policySilenced } = result || {};
    if (![settled, bellWritten, push?.sent > 0, suppressed, policySilenced].some(Boolean)) {
      throw new Error('Payment failure notification was not delivered');
    }
  }
  await trx(TABLE).where(key).update({ pending_payload: null, notified_at: trx.fn.now() });
  return true;
}

async function processPendingPaymentFailureNotifications({ limit = 10 } = {}) {
  // Select a bounded batch once, then lock each key separately. A failed job
  // stays pending without being immediately selected again ahead of its peers.
  const candidates = await db(TABLE).where({ outcome: 'failed' }).whereNotNull('pending_payload')
    .orderBy('notified_at', 'asc').limit(limit)
    .select('payment_intent_id', 'outcome', 'attempt_id');
  const stats = { processed: 0, failed: 0, skipped: 0 };
  for (const key of candidates) {
    try {
      const completed = await db.transaction((trx) => dispatchPendingNotification(trx, key));
      if (completed) stats.processed += 1;
      else stats.skipped += 1;
    } catch (error) {
      stats.failed += 1;
      logger.error('[payment-failure-notifications] dispatch failed', {
        paymentIntentId: key.payment_intent_id, attemptId: key.attempt_id, error: error.message,
      });
      try {
        // Move failed jobs behind untouched jobs; a full batch of poison jobs
        // must not starve newer notifications on every subsequent sweep.
        await db(TABLE).where(key).whereNotNull('pending_payload')
          .update({ notified_at: db.fn.now() });
      } catch (rotationError) {
        logger.error('[payment-failure-notifications] retry rotation failed', {
          paymentIntentId: key.payment_intent_id, error: rotationError.message,
        });
      }
    }
  }
  return stats;
}

module.exports = { enqueuePaymentFailureNotification, processPendingPaymentFailureNotifications };
