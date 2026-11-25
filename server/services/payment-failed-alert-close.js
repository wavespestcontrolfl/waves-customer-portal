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
// Two bells are closed here (TRIGGER_KEYS): payment_failed (a charge that was
// declined) and bill_payment_error (a customer's checkout on the pay page
// failed, e.g. "Bank payment error"). Both are about an invoice that was not
// collected, and both are obsolete once it is paid. A bill_payment_error bell
// is judged on payload.invoiceId alone; a payment_failed bell on its whole
// allocation, as before.
//
// A payment_failed bell with NO invoice (a monthly-dues autopay charge, nothing
// in its payload or its attempt's ledger row names one) cannot close on an
// invoice. It closes once the SAME billed month's dues are collected: see
// payment-failed-month-settled.js for the exact rule and why it never goes by
// customer + amount. Both this hook (for a paid dues invoice) and the repair
// sweep judge it.
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
const { parseJson, isUuid, isFailedAllocationSettled } = require('./payment-failed-allocation');
const { closeIfMonthCollected } = require('./payment-failed-month-settled');

const RESOLUTION = 'The invoice was paid';
const TRIGGER_KEYS = ['payment_failed', 'bill_payment_error'];
const TRIGGER_KEYS_SQL = "metadata->>'triggerKey' IN (?, ?)";

// Close these bells as the payments closer (a row a person marked Done is taken
// over; see openToCloser). Returns how many rows were updated.
async function closeBells(conn, ids) {
  const { doneColumns, openToCloser } = require('./notification-service')._private;
  return openToCloser(conn('notifications').whereIn('id', ids), 'payments')
    .update(doneColumns({ by: 'payments', resolution: RESOLUTION, keepExisting: true, conn }));
}

// Is this bell obsolete by its invoice allocation? A bill_payment_error bell is
// about payload.invoiceId alone (its PaymentIntent may be a combined one); a
// payment_failed bell judges its whole allocation.
function isAllocationSettled(conn, meta) {
  const payload = meta.payload || {};
  if (meta.triggerKey === 'bill_payment_error') return isFailedAllocationSettled(conn, { invoiceId: payload.invoiceId });
  return isFailedAllocationSettled(conn, { paymentIntentId: payload.paymentIntentId, invoiceId: payload.invoiceId, allocationInvoiceIds: payload.allocationInvoiceIds, allocationUnreadable: payload.allocationUnreadable });
}

// Close the obsolete bells among `rows`; returns the number closed. Allocation-
// settled bells close in one update. A payment_failed bell with no invoice at
// all (a monthly-dues autopay charge) is judged by its billed month instead and
// closed in the same transaction as its check (payment-failed-month-settled.js).
// `hookInvoiceId`: the paid-invoice hook, whose own transaction already holds
// that invoice (the sweep passes none and takes the locks itself).
async function closeSettledBells(conn, rows, { hookInvoiceId = null } = {}) {
  const closable = [];
  let closed = 0;
  for (const row of rows || []) {
    const meta = parseJson(row.metadata);
    if (await isAllocationSettled(conn, meta)) closable.push(row.id);
    else if (meta.triggerKey === 'payment_failed') {
      closed += await closeIfMonthCollected(conn, meta.payload, (trx) => closeBells(trx, [row.id]), { onlyInvoiceId: hookInvoiceId });
    }
  }
  return closable.length ? closed + await closeBells(conn, closable) : closed;
}

async function closeRows(invoiceId, conn) {
  const { openToCloser } = require('./notification-service')._private;
  const id = String(invoiceId);
  // Candidates: open bells that name this invoice by either key. Text
  // comparisons only (no uuid cast), so a malformed stored id cannot throw.
  const candidates = await openToCloser(conn('notifications')
    .where({ recipient_type: 'admin', category: 'payment' })
    .whereRaw(TRIGGER_KEYS_SQL, TRIGGER_KEYS), 'payments')
    .where(function aboutThisInvoice() {
      this.whereRaw("metadata->'payload'->>'invoiceId' = ?", [id])
        .orWhereRaw(
          `metadata->'payload'->>'paymentIntentId' IN (
            SELECT p.stripe_payment_intent_id FROM payments p
            WHERE p.metadata->>'invoice_id' = ? AND p.stripe_payment_intent_id IS NOT NULL)`,
          [id],
        );
      // A paid dues invoice may be what collected an invoice-less dues failure's
      // month: that customer's invoice-less payment_failed bells are candidates
      // too (judged by their own billed month, never by this invoice alone).
      if (isUuid(id)) {
        this.orWhere(function duesFailureOfThisCustomer() {
          this.whereRaw("metadata->>'triggerKey' = 'payment_failed'")
            .whereRaw("metadata->'payload'->>'invoiceId' IS NULL")
            .whereRaw("metadata->'payload'->>'customerId' = (SELECT i.customer_id::text FROM invoices i WHERE i.id = ?)", [id]);
        });
      }
    })
    .select('id', 'metadata');
  // A combined attempt's one bell covers several invoices: close it only when
  // its whole allocation is settled, not when just this invoice is.
  return closeSettledBells(conn, candidates, { hookInvoiceId: id });
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
    const { openToCloser } = require('./notification-service')._private;
    const cursorRow = await conn('system_settings').where({ key: SWEEP_CURSOR_KEY }).first('value');
    const afterId = /^[0-9a-f-]{36}$/i.test(cursorRow?.value || '') ? cursorRow.value : null;
    const candidates = await openToCloser(conn('notifications')
      .where({ recipient_type: 'admin', category: 'payment' })
      .whereRaw(TRIGGER_KEYS_SQL, TRIGGER_KEYS), 'payments')
      .modify((q) => { if (afterId) q.where('id', '>', afterId); })
      .orderBy('id', 'asc')
      .limit(page)
      .select('id', 'metadata');
    const nextCursor = (candidates || []).length === page ? candidates[candidates.length - 1].id : null;
    await conn('system_settings').insert({ key: SWEEP_CURSOR_KEY, value: nextCursor, category: 'notifications' })
      .onConflict('key').merge({ value: nextCursor, updated_at: conn.fn.now() });
    return await closeSettledBells(conn, candidates);
  } catch (err) {
    logger.warn(`[payment-failed-alert-close] repair sweep failed: ${err.message}`);
    return 0;
  }
}

module.exports = { closePaymentFailedAlertsForPaidInvoice, sweepSettledPaymentFailedAlerts, RESOLUTION, TRIGGER_KEYS };
