/**
 * What counts as a REFUND on money Waves collected, in one place. The commission ledger (payroll-commission.js) and the production share
 * (production-share-refunds.js) both read it, so the two never keep a second list of what a refund looks like:
 *  - a payment row shows a refund when refund_amount > 0; a 'refunded' row with no refund amount and a 'disputed' row show the whole
 *    payment refunded (showsFullRefund, and the SQL twin PAYMENT_REFUND_SHOWN_SQL);
 *  - an estimate deposit has no payments row: the invoice writer applies it as a deposit_credit line naming the estimate
 *    (depositApplications), and the deposit ledger (estimate_deposits) says what part of the applied money a refund or dispute reversed
 *    (depositReversal; a refund returns the part never applied first).
 * Moved here from payroll-commission.js unchanged: that module imports them back and its behaviour is the same.
 */
const { payrollUnits } = require('../utils/payroll-units');

const AUTO_MINT_RE = /Auto-generated from accepted estimate #([0-9a-f-]{8,})/gi;
const namedIn = (notes, pattern) => [...String(notes || '').matchAll(pattern)].map((match) => match[1].toLowerCase());

// Deposit rows that hold money Waves collected (estimate-deposits.js): pending and failed never collected anything.
const COLLECTED_DEPOSITS = ['received', 'credited', 'refunding', 'refunded'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOIDED_INVOICE = ['void', 'canceled', 'cancelled'];
const invoiceLines = (invoice) => (Array.isArray(invoice.line_items) ? invoice.line_items.filter(Boolean) : []);

/**
 * An estimate deposit has no payments row (estimate-deposits.js). The invoice writer applies it to an invoice as a
 * deposit_credit line naming the estimate, after tax, as a prior payment (invoice.js create), and one deposit can be
 * applied in parts to several invoices (consumeDepositCredit). Map estimate id -> cents applied on this invoice; a credit line
 * that names no estimate counts for the estimate whose acceptance mint the invoice is.
 */
function depositApplications(invoice) {
  const minted = namedIn(invoice.notes, AUTO_MINT_RE)[0] || '';
  const applied = new Map();
  for (const line of invoiceLines(invoice)) {
    if (line.category !== 'deposit_credit' || !(Number(line.amount) < 0)) continue;
    const estimateId = String(line.estimate_id || minted).toLowerCase();
    if (UUID_RE.test(estimateId)) applied.set(estimateId, (applied.get(estimateId) || 0n) - payrollUnits(line.amount));
  }
  return applied;
}

/**
 * What one estimate_deposits row says about applied money: applied (credited_amount) and the part a refund or dispute reversed
 * (refunded_amount, the face value returned; status 'refunded' with no amount means all of it). A refund returns the part never
 * applied (amount - credited_amount) first; only the rest reverses applied money. In cents (payrollUnits).
 */
function depositReversal(row) {
  const amount = payrollUnits(row.amount);
  const credited = payrollUnits(row.credited_amount);
  const refunded = row.status === 'refunded' && payrollUnits(row.refunded_amount) <= 0n ? amount : payrollUnits(row.refunded_amount);
  const intoApplied = refunded - (amount - credited);
  return { applied: credited, refunded, reversed: intoApplied <= 0n ? 0n : (intoApplied < credited ? intoApplied : credited) };
}

// A 'refunded' row with no refund amount and a 'disputed' row show the whole payment refunded (refundedTotal = payrollUnits(refund_amount)).
const showsFullRefund = (status, refundedTotal) => status === 'disputed' || (status === 'refunded' && refundedTotal <= 0n);

// The SQL twin for a payments alias: a row that shows any refund (an amount, or the whole payment by status).
const paymentRefundShownSql = (alias) => `(COALESCE(${alias}.refund_amount, 0) > 0 OR ${alias}.status IN ('refunded', 'disputed'))`;

module.exports = {
  AUTO_MINT_RE, namedIn, COLLECTED_DEPOSITS, UUID_RE, VOIDED_INVOICE, invoiceLines, depositApplications, depositReversal, showsFullRefund, paymentRefundShownSql,
};
