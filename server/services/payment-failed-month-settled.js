// A payment_failed bell with NO invoice: a monthly-dues autopay charge (the
// daily cron, a retry rung, or the office's "Charge now") that was declined.
// Such a bell names no invoice, so the invoice-paid closer
// (payment-failed-alert-close.js) never saw it settle. It is obsolete once the
// SAME month's dues are collected through another door.
//
// The rule is by BILLED MONTH, never by customer + amount (a later month's
// payment, or an unrelated invoice's payment, must not close an earlier
// month's bell). Every step must hold, and any doubt leaves the bell open
// (a false-open costs a click; a false-close hides unpaid dues):
//   1. The bell is invoice-less: payload.invoiceId is null, no declared
//      allocation (a non-empty, malformed or unreadable one is not ours), a
//      PaymentIntent id and a UUID customer id.
//   2. The failed attempt's ledger row is found by that PaymentIntent AND the
//      bell's customer: exactly one row, status failed, naming no invoice.
//   3. Its billed month: metadata.billed_month when present (it must be a
//      valid YYYY-MM; this covers "Charge now", whose description is not the
//      monthly marker), else, for an unstamped legacy row only, the monthly
//      description marker plus the payment_date month.
//   4. That month is collected: the shared findCollectedMonthlyPayment finds a
//      PAID payment for that customer and month (the failed row excluded), or
//      the completion-minted dues invoice for that month is paid/prepaid (an
//      open or processing one keeps the bell open).
const logger = require('./logger');
const { isUuid, parseJson, SETTLED_INVOICE_STATUSES } = require('./payment-failed-allocation');
const { dateOnlyString } = require('../utils/date-only');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHLY_MARKER = 'WaveGuard Monthly';

// Step 1: the bell payload's own shape.
function isInvoicelessPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.allocationUnreadable) return false;
  if (payload.invoiceId != null) return false;
  const allocation = payload.allocationInvoiceIds;
  if (allocation != null && !(Array.isArray(allocation) && allocation.length === 0)) return false;
  return typeof payload.paymentIntentId === 'string' && payload.paymentIntentId !== '' && isUuid(payload.customerId);
}

// Step 3: the billed month of the failed row, or null.
function obligationMonthOf(row) {
  const stamped = parseJson(row.metadata).billed_month;
  if (stamped != null) return typeof stamped === 'string' && MONTH_RE.test(stamped) ? stamped : null;
  if (!String(row.description || '').includes(MONTHLY_MARKER)) return null;
  const month = (dateOnlyString(row.payment_date) || '').slice(0, 7);
  return MONTH_RE.test(month) ? month : null;
}

function monthWindow(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0');
  return { monthKey, monthStart: `${monthKey}-01`, monthEnd: `${monthKey}-${lastDay}` };
}

// Steps 1 to 3: the failed attempt behind an invoice-less bell, or null on any doubt.
async function invoicelessAttempt(conn, payload) {
  if (!isInvoicelessPayload(payload)) return null;
  const rows = await conn('payments')
    .where({ stripe_payment_intent_id: payload.paymentIntentId })
    .select('id', 'customer_id', 'status', 'description', 'payment_date', 'metadata');
  if (rows.length !== 1) return null;
  const [row] = rows;
  if (String(row.customer_id) !== String(payload.customerId) || row.status !== 'failed') return null;
  // Any invoice link, even a malformed one, means this is not a dues attempt.
  if (parseJson(row.metadata).invoice_id != null) return null;
  const monthKey = obligationMonthOf(row);
  return monthKey ? { paymentId: row.id, customerId: String(row.customer_id), monthKey } : null;
}

// Step 4.
async function isMonthCollected(conn, { paymentId, customerId, monthKey }) {
  const { findCollectedMonthlyPayment } = require('./retry-collectibility');
  const paid = await findCollectedMonthlyPayment(customerId, monthWindow(monthKey), {
    conn, statuses: ['paid'], withDuesInvoice: false, excludePaymentId: paymentId,
  });
  if (paid) return true;
  const { findLiveStampedDuesInvoice } = require('./billing-lane');
  const dues = await findLiveStampedDuesInvoice(conn, customerId, monthKey, { openInvoiceCovers: false });
  return Boolean(dues) && SETTLED_INVOICE_STATUSES.includes(dues.status);
}

// True only when the bell is an invoice-less dues failure whose month is
// collected. Never throws: a read that fails leaves the bell open. The reads
// run in their own savepoint, so a failed statement cannot abort the caller's
// transaction (the paid hook runs inside the payment's).
async function isInvoicelessMonthSettled(conn, payload) {
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

// The reverse question, for a bell closed by the rule above: true only when the
// bell is a genuine invoice-less dues failure and its month is NOT collected
// any more (a collecting payment was undone). Any doubt, or a failed read, is
// false: the bell is not reopened. Own savepoint, like the check above.
async function isInvoicelessMonthUncollected(conn, payload) {
  try {
    return await conn.transaction(async (trx) => {
      const attempt = await invoicelessAttempt(trx, payload);
      return attempt ? !(await isMonthCollected(trx, attempt)) : false;
    });
  } catch (err) {
    logger.warn(`[payment-failed-month-settled] ${err.message}`);
    return false;
  }
}

module.exports = { isInvoicelessMonthSettled, isInvoicelessMonthUncollected, invoicelessAttempt, isMonthCollected, isInvoicelessPayload, obligationMonthOf, monthWindow };
