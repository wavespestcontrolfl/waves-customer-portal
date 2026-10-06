// A payment_failed admin bell is about an invoice that was not collected. When
// the invoice becomes paid, the bell is obsolete, whichever PaymentIntent paid
// it (a customer who retries with a new card pays through a NEW PaymentIntent;
// payment-failure-notifications.js only suppresses when the SAME one settles).
//
// Called from completeActivePlansForInvoice (payment-plans.js), the one helper
// every paid/prepaid transition already runs on its way out, after its own
// locked read proved the invoice is paid/prepaid. Best-effort by contract: the
// close runs in a SAVEPOINT on the caller's connection, so a failure here rolls
// back only the close and is logged; it never fails or rolls back the payment.
//
// A bell closes only when its whole allocation is settled (see
// payment-failed-allocation.js): a combined PaymentIntent's bell stays open
// until every invoice it covered is paid. A bell matches the invoice by EITHER key:
//   - metadata.payload.invoiceId = the invoice (alerts raised after the stamp
//     fix in payment-failure-notifications.js carry it), or
//   - metadata.payload.paymentIntentId = the stripe_payment_intent_id of a
//     payments row whose metadata.invoice_id is the invoice (the failed
//     attempt's own ledger row; covers alerts raised before the stamp fix).
const db = require('../models/db');
const logger = require('./logger');
const { parseJson, isFailedAllocationSettled } = require('./payment-failed-allocation');

const RESOLUTION = 'The invoice was paid';

async function closeRows(invoiceId, conn) {
  const { doneColumns, openToCloser } = require('./notification-service')._private;
  const id = String(invoiceId);
  // Candidates: open bells that name this invoice by either key. Text
  // comparisons only (no uuid cast), so a malformed stored id cannot throw.
  const candidates = await openToCloser(conn('notifications')
    .where({ recipient_type: 'admin', category: 'payment' })
    .whereRaw("metadata->>'triggerKey' = 'payment_failed'"), 'payments')
    .where(function aboutThisInvoice() {
      this.whereRaw("metadata->'payload'->>'invoiceId' = ?", [id])
        .orWhereRaw(
          `metadata->'payload'->>'paymentIntentId' IN (
            SELECT p.stripe_payment_intent_id FROM payments p
            WHERE p.metadata->>'invoice_id' = ? AND p.stripe_payment_intent_id IS NOT NULL)`,
          [id],
        );
    })
    .select('id', 'metadata');
  // A combined attempt's one bell covers several invoices: close it only when
  // its whole allocation is settled, not when just this invoice is.
  const closable = [];
  for (const row of candidates || []) {
    const payload = parseJson(row.metadata).payload || {};
    if (await isFailedAllocationSettled(conn, { paymentIntentId: payload.paymentIntentId, invoiceId: payload.invoiceId, allocationInvoiceIds: payload.allocationInvoiceIds, allocationUnreadable: payload.allocationUnreadable })) {
      closable.push(row.id);
    }
  }
  if (!closable.length) return 0;
  return openToCloser(conn('notifications').whereIn('id', closable), 'payments')
    .update(doneColumns({ by: 'payments', resolution: RESOLUTION, keepExisting: true, conn }));
}

// `conn` is a transaction (a savepoint is opened on it) or the pool. Returns
// the number of bells closed; 0 on any failure.
async function closePaymentFailedAlertsForPaidInvoice(invoiceId, conn = db) {
  if (!invoiceId) return 0;
  try {
    return await conn.transaction((trx) => closeRows(invoiceId, trx));
  } catch (err) {
    logger.warn(`[payment-failed-alert-close] invoice ${invoiceId}: ${err.message}`);
    return 0;
  }
}

// Repair sweep (scheduler, every 15 minutes). The hook above runs inside the
// payment transaction, so two races can leave an obsolete bell open with no
// later hook to close it: the failure bell is inserted after the paying
// transaction's closer ran (dispatch read the invoice before that payment
// committed), or two transactions settle the last invoices of one combined
// attempt at once and each sees the other's invoice as unpaid. The sweep
// re-judges bells from COMMITTED state outside any payment transaction, so
// both races settle within a few ticks. It also closes bells about invoices
// paid through a path that does not call the hook, and bells open from before
// this change. Candidates use openToCloser like the hook (a row a person
// marked Done is taken over, so their Reopen cannot bring it back). Each run
// reads one bounded page in id order from a durable cursor and wraps at the
// end, so every candidate is reached however many stay legitimately unpaid.
// Best-effort: returns the number closed, 0 on failure.
const SWEEP_PAGE = 200;
const SWEEP_CURSOR_KEY = 'payment_failed_alert_sweep_cursor';

async function sweepSettledPaymentFailedAlerts({ conn = db, page = SWEEP_PAGE } = {}) {
  try {
    const { doneColumns, openToCloser } = require('./notification-service')._private;
    const cursorRow = await conn('system_settings').where({ key: SWEEP_CURSOR_KEY }).first('value');
    const afterId = /^[0-9a-f-]{36}$/i.test(cursorRow?.value || '') ? cursorRow.value : null;
    const candidates = await openToCloser(conn('notifications')
      .where({ recipient_type: 'admin', category: 'payment' })
      .whereRaw("metadata->>'triggerKey' = 'payment_failed'"), 'payments')
      .modify((q) => { if (afterId) q.where('id', '>', afterId); })
      .orderBy('id', 'asc')
      .limit(page)
      .select('id', 'metadata');
    const nextCursor = (candidates || []).length === page ? candidates[candidates.length - 1].id : null;
    await conn('system_settings').insert({ key: SWEEP_CURSOR_KEY, value: nextCursor, category: 'notifications' })
      .onConflict('key').merge({ value: nextCursor, updated_at: conn.fn.now() });
    const closable = [];
    for (const row of candidates || []) {
      const payload = parseJson(row.metadata).payload || {};
      if (await isFailedAllocationSettled(conn, { paymentIntentId: payload.paymentIntentId, invoiceId: payload.invoiceId, allocationInvoiceIds: payload.allocationInvoiceIds, allocationUnreadable: payload.allocationUnreadable })) {
        closable.push(row.id);
      }
    }
    if (!closable.length) return 0;
    return await openToCloser(conn('notifications').whereIn('id', closable), 'payments')
      .update(doneColumns({ by: 'payments', resolution: RESOLUTION, keepExisting: true, conn }));
  } catch (err) {
    logger.warn(`[payment-failed-alert-close] repair sweep failed: ${err.message}`);
    return 0;
  }
}

module.exports = { closePaymentFailedAlertsForPaidInvoice, sweepSettledPaymentFailedAlerts, RESOLUTION };
