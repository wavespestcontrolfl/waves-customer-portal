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

// A dispute the webhook closed in Waves's favour (stripe-webhook.js handleDisputeClosed writes metadata.dispute_final) restored the money.
// A pre-settlement statement dispute leaves the payment status 'disputed' with that marker.
const disputeClosedSql = (alias) => `COALESCE(${alias}.metadata ->> 'dispute_final', '') IN ('won', 'warning_closed')`;

// The SQL twin for a payments alias: a row that shows any refund (an amount, or the whole payment by status). A 'disputed' row whose dispute
// closed won or warning_closed no longer shows the whole payment as taken (any recorded refund amount still counts). The commission ledger keeps
// its own JS rule (showsFullRefund) unchanged.
const paymentRefundShownSql = (alias) => `(COALESCE(${alias}.refund_amount, 0) > 0 OR ${alias}.status = 'refunded'
  OR (${alias}.status = 'disputed' AND NOT ${disputeClosedSql(alias)}))`;

// The durable keys a payment row carries to name its invoice (metadata), in the order the Stripe webhook reads them (stripe-webhook.js
// findInvoiceForPayment): a dispute reopen writes dispute_invoice_id and clears the Stripe ids on the invoice, so these keys, not the
// invoice's own ids, still tie the payment to it. findInvoiceForPayment reads this same list.
const PAYMENT_INVOICE_METADATA_KEYS = ['dispute_invoice_id', 'invoice_id', 'waves_invoice_id'];

// The invoice id a payment's metadata (an object) names, by that order; null when none.
const metadataInvoiceId = (meta) => {
  const found = PAYMENT_INVOICE_METADATA_KEYS.map((key) => (meta || {})[key]).find(Boolean);
  return found || null;
};

// The pre-settlement marker rows the combined-charge webhook writes (a refund or dispute that arrived before the charge settled) name the
// invoice the combined charge was anchored to here. findInvoiceForPayment does not read this key, so it is not in the list above.
const COMBINED_ANCHOR_INVOICE_KEY = 'combined_anchor_invoice_id';

// SQL: the payment `p` names the invoice `invoiceRef` (an id expression) in any of those metadata keys, or as the anchor of a combined marker.
const paymentNamesInvoiceSql = (alias, invoiceRef) => `(${[...PAYMENT_INVOICE_METADATA_KEYS, COMBINED_ANCHOR_INVOICE_KEY].map((key) => `${alias}.metadata ->> '${key}' = ${invoiceRef}::text`).join(' OR ')})`;

module.exports = {
  PAYMENT_INVOICE_METADATA_KEYS, COMBINED_ANCHOR_INVOICE_KEY, disputeClosedSql, metadataInvoiceId, paymentNamesInvoiceSql,
  AUTO_MINT_RE, namedIn, COLLECTED_DEPOSITS, UUID_RE, VOIDED_INVOICE, invoiceLines, depositApplications, depositReversal, showsFullRefund, paymentRefundShownSql,
};
