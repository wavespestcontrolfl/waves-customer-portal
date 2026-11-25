// A payment_failed bell with NO invoice: a monthly-dues autopay charge (the
// daily cron, a retry rung, or the office's "Charge now" for dues) that was
// declined. Such a bell names no invoice, so the invoice-paid closer
// (payment-failed-alert-close.js) never saw it settle. It is obsolete once the
// SAME month's dues are collected through another door.
//
// The rule is by BILLED MONTH, stamped on BOTH sides, never by customer +
// amount or a description match (a later month's payment, an unrelated
// invoice's payment, or an explicit one-time charge must not close an earlier
// month's bell). Every step must hold, and any doubt leaves the bell open (a
// false-open costs a click; a false-close hides unpaid dues):
//   1. The bell is invoice-less: payload.invoiceId is null, no declared
//      allocation (a non-empty, malformed or unreadable one is not ours), a
//      PaymentIntent id and a UUID customer id.
//   2. The failed attempt's ledger row is found by that PaymentIntent AND the
//      bell's customer: exactly one row, status failed, naming no invoice.
//   3. That row carries a valid metadata.billed_month (YYYY-MM). A legacy
//      unstamped row has no month here and its bell stays open.
//   4. That month is collected: a PAID payment of the same customer carries the
//      SAME metadata.billed_month (the failed row excluded), or some completion-
//      minted dues invoice stamped for that month is paid/prepaid (an open or
//      processing one keeps the bell open; any settled one counts).
//
// The sweep closes under the locks manual payment Undo takes (see
// closeIfMonthCollected), so an Undo cannot commit between the check and the close.
// A bell closed this way carries metadata.closedBy = CLOSED_BY and closedMonth, so
// Undo can reopen it WITHOUT judging anything (invoice-manual-payment-undo.js).
const logger = require('./logger');
const { isUuid, parseJson, SETTLED_INVOICE_STATUSES } = require('./payment-failed-allocation');

const CLOSED_BY = 'month-settled';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Step 1: the bell payload's own shape.
function isInvoicelessPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.allocationUnreadable) return false;
  if (payload.invoiceId != null) return false;
  const allocation = payload.allocationInvoiceIds;
  if (allocation != null && !(Array.isArray(allocation) && allocation.length === 0)) return false;
  return typeof payload.paymentIntentId === 'string' && payload.paymentIntentId !== '' && isUuid(payload.customerId);
}

// Step 3: the billed month stamped on the failed row, or null.
function obligationMonthOf(row) {
  const stamped = parseJson(row.metadata).billed_month;
  return typeof stamped === 'string' && MONTH_RE.test(stamped) ? stamped : null;
}

// Steps 1 to 3: the failed attempt behind an invoice-less bell, or null on any doubt.
async function invoicelessAttempt(conn, payload) {
  if (!isInvoicelessPayload(payload)) return null;
  const rows = await conn('payments')
    .where({ stripe_payment_intent_id: payload.paymentIntentId })
    .select('id', 'customer_id', 'status', 'metadata');
  if (rows.length !== 1) return null;
  const [row] = rows;
  if (String(row.customer_id) !== String(payload.customerId) || row.status !== 'failed') return null;
  // Any invoice link, even a malformed one, means this is not a dues attempt.
  if (parseJson(row.metadata).invoice_id != null) return null;
  const monthKey = obligationMonthOf(row);
  return monthKey ? { paymentId: row.id, customerId: String(row.customer_id), monthKey } : null;
}

// Step 4, payment side: a paid row of this customer stamped with the same billed month.
async function paidPaymentForMonth(conn, { paymentId, customerId, monthKey }) {
  const row = await conn('payments')
    .where({ customer_id: customerId, status: 'paid' })
    .whereNot({ id: paymentId })
    .whereRaw("metadata->>'billed_month' = ?", [monthKey])
    .first('id');
  return Boolean(row);
}

// Step 4, invoice side: ids of every paid/prepaid completion-minted dues invoice
// of this customer for the month (the stamp billing-lane reads; the customer's
// own, not a payer's), in id order. `onlyInvoiceId` narrows to one invoice.
async function settledDuesInvoiceIds(conn, { customerId, monthKey }, { onlyInvoiceId = null } = {}) {
  const { MEMBERSHIP_DUES_LINE_KEY } = require('./billing-lane');
  const query = conn('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', SETTLED_INVOICE_STATUSES)
    .whereRaw('payer_id IS NULL')
    .whereRaw('line_items::jsonb @> ?::jsonb', [JSON.stringify([{ [MEMBERSHIP_DUES_LINE_KEY]: monthKey }])]);
  if (onlyInvoiceId) query.where({ id: onlyInvoiceId });
  return (await query.orderBy('id', 'asc').select('id')).map((row) => String(row.id));
}

async function isMonthCollected(conn, attempt, { onlyInvoiceId = null } = {}) {
  if (await paidPaymentForMonth(conn, attempt)) return true;
  return (await settledDuesInvoiceIds(conn, attempt, { onlyInvoiceId })).length > 0;
}

// The locks manual payment Undo takes on a dues invoice, in ITS order
// (invoice-manual-payment-undo.js undoManualPayment: the per-customer combined-
// session lock, the receipt-claim lock, then the invoice row), then the settled
// set read again under them. While they are held no Undo of these invoices can
// commit, and one already waiting on them has committed before this read.
async function lockSettlingInvoices(trx, attempt) {
  const ids = await settledDuesInvoiceIds(trx, attempt);
  if (!ids.length) return [];
  await require('./pay-combined').lockCombinedCustomerStable(trx, ids[0], attempt.customerId);
  const { lockInvoiceReceiptClaim } = require('./receipt-delivery-queue');
  for (const id of ids) await lockInvoiceReceiptClaim(trx, id);
  await trx('invoices').whereIn('id', ids).orderBy('id', 'asc').forUpdate().select('id');
  return settledDuesInvoiceIds(trx, attempt);
}

// Close an invoice-less bell when its month is collected: the settlement check
// and `close(trx)` (the notification update) run in ONE transaction.
//   - Default (the repair sweep): a paid payment settles without a lock (Undo
//     never touches a stamped payment row); a dues invoice settles only under the
//     locks above, so an Undo that reverts it cannot commit between the check and
//     the close (and one that already did is seen).
//   - `onlyInvoiceId` (the paid-invoice hook, which runs inside the payment's own
//     transaction with that invoice already locked): no new locks, and only that
//     invoice counts as invoice-side evidence; any other settled invoice is left
//     to the sweep, which locks it.
// Returns how many bells `close` closed; 0 on any doubt or failed read.
async function closeIfMonthCollected(conn, payload, close, { onlyInvoiceId = null } = {}) {
  if (!isInvoicelessPayload(payload)) return 0;
  try {
    return await conn.transaction(async (trx) => {
      const attempt = await invoicelessAttempt(trx, payload);
      if (!attempt) return 0;
      if (await paidPaymentForMonth(trx, attempt)) return close(trx, attempt);
      if (onlyInvoiceId) return (await settledDuesInvoiceIds(trx, attempt, { onlyInvoiceId })).length ? close(trx, attempt) : 0;
      return (await lockSettlingInvoices(trx, attempt)).length ? close(trx, attempt) : 0;
    });
  } catch (err) {
    logger.warn(`[payment-failed-month-settled] ${err.message}`);
    return 0;
  }
}

// Read-only: is this invoice-less bell's month collected right now? For the
// dispatch of a failure alert (payment-failure-notifications.js), which must not
// ring for a month already collected. Fails OPEN: any doubt or failed read is
// false, so the alert goes out as it always did. Own savepoint, so a failed read
// cannot abort the caller's transaction.
async function isInvoicelessMonthSettled(conn, payload) {
  if (!isInvoicelessPayload(payload)) return false;
  try {
    return await conn.transaction(async (trx) => {
      const attempt = await invoicelessAttempt(trx, payload);
      return attempt ? await isMonthCollected(trx, attempt) : false;
    });
  } catch (err) {
    logger.warn(`[payment-failed-month-settled] ${err.message}`);
    return false;
  }
}

module.exports = {
  closeIfMonthCollected, isInvoicelessMonthSettled, invoicelessAttempt, isMonthCollected, isInvoicelessPayload, obligationMonthOf, CLOSED_BY,
};
