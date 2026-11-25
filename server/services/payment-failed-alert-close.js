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
// collected, and both are obsolete once it is paid. A payment_failed bell for
// an autopay charge with NO invoice (payload.invoiceId null, no ledger invoice)
// has no invoice to watch: it closes when the monthly dues month it failed for
// was collected by another paid row (settledByCollectedMonth).
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
const { dateOnlyString } = require('../utils/date-only');
const { parseJson, isUuid, failedAllocationInvoiceIds, isFailedAllocationSettled } = require('./payment-failed-allocation');

const RESOLUTION = 'The invoice was paid';
const TRIGGER_KEYS = ['payment_failed', 'bill_payment_error'];
const TRIGGER_KEYS_SQL = "metadata->>'triggerKey' IN (?, ?)";

// An autopay failure with no invoice (a monthly dues charge): obsolete when that
// same MONTH's dues were collected by another paid row. The failed attempt is
// resolved through its own PaymentIntent's ledger row; its billed month
// (metadata.billed_month, else its payment date) and the shared
// findCollectedMonthlyPayment predicate decide, so another month's payment of the
// same amount, or an unrelated invoice payment, never closes it. Anything that
// cannot be identified (no PaymentIntent, no ledger row, not a monthly dues row,
// no month) leaves the bell open. Never for a bell that names or declares an
// invoice allocation, even a malformed one.
async function settledByCollectedMonth(conn, payload) {
  const declaresAllocation = Array.isArray(payload.allocationInvoiceIds) ? payload.allocationInvoiceIds.length > 0 : payload.allocationInvoiceIds != null;
  if (payload.invoiceId != null || declaresAllocation || payload.allocationUnreadable) return false;
  if (!isUuid(String(payload.customerId || '')) || !payload.paymentIntentId) return false;
  if ((await failedAllocationInvoiceIds(conn, payload)).length) return false;
  const retry = require('./retry-collectibility');
  const failed = await conn('payments')
    .where({ stripe_payment_intent_id: String(payload.paymentIntentId), customer_id: String(payload.customerId) })
    .first('id', 'description', 'metadata', 'payment_date');
  if (!failed || !retry.isMonthlyObligationRow(failed)) return false;
  const month = parseJson(failed.metadata).billed_month || retry.monthKeyOf(dateOnlyString(failed.payment_date));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return false;
  const [year, mon] = month.split('-').map(Number);
  const lastDay = String(new Date(Date.UTC(year, mon, 0)).getUTCDate()).padStart(2, '0');
  const window = { monthKey: month, monthStart: `${month}-01`, monthEnd: `${month}-${lastDay}` };
  return Boolean(await retry.findCollectedMonthlyPayment(String(payload.customerId), window, {
    conn, statuses: ['paid'], withDuesInvoice: false, excludePaymentId: failed.id,
  }));
}

// Which of these open bells are obsolete. A bill_payment_error bell is about
// payload.invoiceId alone (its PaymentIntent may be a combined one); a
// payment_failed bell judges its whole allocation, else the collected-month rule.
async function settledBellIds(conn, rows) {
  const closable = [];
  for (const row of rows || []) {
    const meta = parseJson(row.metadata);
    const payload = meta.payload || {};
    const attempt = meta.triggerKey === 'bill_payment_error'
      ? { invoiceId: payload.invoiceId }
      : { paymentIntentId: payload.paymentIntentId, invoiceId: payload.invoiceId, allocationInvoiceIds: payload.allocationInvoiceIds, allocationUnreadable: payload.allocationUnreadable };
    if (await isFailedAllocationSettled(conn, attempt)
      || (meta.triggerKey !== 'bill_payment_error' && await settledByCollectedMonth(conn, payload))) {
      closable.push(row.id);
    }
  }
  return closable;
}

async function closeRows(invoiceId, conn) {
  const { doneColumns, openToCloser } = require('./notification-service')._private;
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
    })
    .select('id', 'metadata');
  // A combined attempt's one bell covers several invoices: close it only when
  // its whole allocation is settled, not when just this invoice is.
  const closable = await settledBellIds(conn, candidates);
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
      .whereRaw(TRIGGER_KEYS_SQL, TRIGGER_KEYS), 'payments')
      .modify((q) => { if (afterId) q.where('id', '>', afterId); })
      .orderBy('id', 'asc')
      .limit(page)
      .select('id', 'metadata');
    const nextCursor = (candidates || []).length === page ? candidates[candidates.length - 1].id : null;
    await conn('system_settings').insert({ key: SWEEP_CURSOR_KEY, value: nextCursor, category: 'notifications' })
      .onConflict('key').merge({ value: nextCursor, updated_at: conn.fn.now() });
    const closable = await settledBellIds(conn, candidates);
    if (!closable.length) return 0;
    return await openToCloser(conn('notifications').whereIn('id', closable), 'payments')
      .update(doneColumns({ by: 'payments', resolution: RESOLUTION, keepExisting: true, conn }));
  } catch (err) {
    logger.warn(`[payment-failed-alert-close] repair sweep failed: ${err.message}`);
    return 0;
  }
}

module.exports = { closePaymentFailedAlertsForPaidInvoice, sweepSettledPaymentFailedAlerts, RESOLUTION, TRIGGER_KEYS };
