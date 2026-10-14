const db = require('../models/db');
const logger = require('./logger');
const { triggerNotification } = require('./notification-triggers');
const { isUuid, ledgerInvoiceId, isFailedAllocationSettled } = require('./payment-failed-allocation');

const TABLE = 'stripe_payment_notification_log';
const SETTLED_STATUSES = ['paid', 'refunded', 'disputed'];

// The combined allocation the PaymentIntent was minted with, as payload
// fields: allocationInvoiceIds (UUID-checked), or allocationUnreadable when the
// metadata is present but malformed (the alert then never auto-retires; a
// person closes it). {} for a single-invoice PaymentIntent.
function queuedAllocation(metadata) {
  if (!metadata?.combined_allocation) return {};
  try {
    const entries = require('./pay-combined').parseCombinedAllocation(metadata) || [];
    const ids = entries.map((e) => String(e.invoiceId));
    if (!ids.length || !ids.every((id) => isUuid(id))) return { allocationUnreadable: true };
    return { allocationInvoiceIds: ids };
  } catch {
    return { allocationUnreadable: true };
  }
}

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
      // The invoice this PaymentIntent was created for. A pay-page attempt can
      // fail before any payments row exists, and a retry rebinds the invoice
      // to a NEW PaymentIntent before this job runs: then neither the invoice
      // binding nor a ledger row names it, and only this metadata still does.
      invoiceId: isUuid(String(paymentIntent.metadata?.waves_invoice_id || '')) ? String(paymentIntent.metadata.waves_invoice_id) : null,
      // A combined attempt covered several invoices, and a synchronous failure
      // may leave no ledger row per invoice: keep the attempt's own allocation
      // so the alert only retires when every invoice in it is paid.
      ...queuedAllocation(paymentIntent.metadata),
      reason: friendlyFailure,
    },
  }).onConflict(['payment_intent_id', 'outcome', 'attempt_id']).ignore();
}

// The invoice the alert is about: the one bound to the failed PaymentIntent, else
// the one the failed attempt's ledger row names (a retry on a new card rebinds
// the invoice), so the alert carries invoiceId and a later payment can close
// it. A ledger id that is not a UUID is ignored (comparing it to invoices.id
// would throw and the job would rotate forever).
async function resolveAlertInvoiceId(trx, invoice, ledgerRow, queuedInvoiceId = null) {
  if (invoice.id) return invoice.id; // read from invoices, so already a valid id
  // Then the PaymentIntent's own metadata (queued at failure time), then the
  // failed attempt's ledger row; each must name an invoice that exists.
  for (const id of [isUuid(String(queuedInvoiceId || '')) ? String(queuedInvoiceId) : null, ledgerInvoiceId(ledgerRow)]) {
    if (!id) continue;
    const row = await trx('invoices').where({ id }).first('id');
    if (row?.id) return row.id;
  }
  return null;
}

// The queued allocation fields, carried onto the alert's payload so the paid
// hook and the repair sweep judge the same allocation the dispatch did.
function allocationOf(payload) {
  if (payload?.allocationUnreadable) return { allocationUnreadable: true };
  return Array.isArray(payload?.allocationInvoiceIds) ? { allocationInvoiceIds: payload.allocationInvoiceIds } : {};
}

async function dispatchPendingNotification(trx, key) {
  const job = await trx(TABLE).where(key).whereNotNull('pending_payload')
    .forUpdate().skipLocked().first();
  if (!job) return 'skipped';

  const piId = job.payment_intent_id;
  const ledgerRow = await trx('payments').where({ stripe_payment_intent_id: piId }).first() || {};
  let settled = SETTLED_STATUSES.includes(ledgerRow.status);
  let invoice = {};
  let alertInvoiceId = null;
  if (!settled) {
    invoice = await trx('invoices').where({ stripe_payment_intent_id: piId }).first() || {};
    alertInvoiceId = await resolveAlertInvoiceId(trx, invoice, ledgerRow, job.pending_payload?.invoiceId);
    // The customer may have paid the whole allocation through a NEW
    // PaymentIntent before this job ran (the closer found no bell then): the
    // alert would be stale on arrival, so it is suppressed like a settled PI.
    settled = await isFailedAllocationSettled(trx, { paymentIntentId: piId, invoiceId: alertInvoiceId, ...allocationOf(job.pending_payload) });
  }
  if (!settled) {
    const payload = job.pending_payload;
    const deliveredSubscriptionIds = payload.deliveredSubscriptionIds || [];
    const customerId = [invoice.customer_id, ledgerRow.customer_id, payload.customerId].find(Boolean) || null;
    const customer = (customerId ? await trx('customers').where({ id: customerId }).first() : null) || {};
    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
      || customer.phone || 'customer';
    let recheckError = null;
    const shouldContinue = async () => {
      try {
        // READ COMMITTED sees success/refund/dispute committed during fan-out.
        const settledRow = await trx('payments').where({ stripe_payment_intent_id: piId })
          .whereIn('status', SETTLED_STATUSES).first('id');
        settled = settled || Boolean(settledRow)
          || await isFailedAllocationSettled(trx, { paymentIntentId: piId, invoiceId: alertInvoiceId, ...allocationOf(payload) });
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
      invoiceId: alertInvoiceId,
      ...allocationOf(payload),
      paymentIntentId: piId,
      attemptId: job.attempt_id,
    }, {
      dedupeKey: `payment-failed:${piId}:${job.attempt_id}`,
      shouldContinue,
      beforePush: shouldContinue,
      deliveredSubscriptionIds,
    });
    if (recheckError) throw recheckError;
    const { bellWritten, push, suppressed, policySilenced, retryable, error, prefsUnavailable } = result || {};
    const { sent, deliveredSubscriptionIds: acceptedIds = [] } = push || {};
    const terminalSuppression = [settled, suppressed, policySilenced].some(Boolean);
    if ([retryable, error, prefsUnavailable].some(Boolean) && !terminalSuppression) {
      // A durable bell or accepted push is progress, but another channel still
      // needs a retry. Commit accepted subscription IDs with the pending job.
      await trx(TABLE).where(key).update({
        pending_payload: { ...payload, deliveredSubscriptionIds: [...new Set([...deliveredSubscriptionIds, ...acceptedIds])] },
        notified_at: trx.fn.now(),
      });
      return 'failed';
    }
    if (![terminalSuppression, bellWritten, sent > 0].some(Boolean)) {
      throw new Error('Payment failure notification was not delivered');
    }
  }
  await trx(TABLE).where(key).update({ pending_payload: null, notified_at: trx.fn.now() });
  return 'processed';
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
      const outcome = await db.transaction((trx) => dispatchPendingNotification(trx, key));
      stats[outcome] += 1;
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
