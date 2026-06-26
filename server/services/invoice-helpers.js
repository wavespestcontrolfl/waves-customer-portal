/**
 * Pure invoice helpers — no DB, no Stripe SDK, no Twilio.
 *
 * Encodes the audit invariants the unit tests pin:
 *   - INVOICE_UPDATE_ALLOWED_FIELDS: status (and other money columns)
 *     must NEVER be writable through the generic PUT /admin/invoices/:id
 *     endpoint. State transitions go through the explicit /void,
 *     /charge-card, /record-payment, /archive, /unarchive routes.
 *   - assertInvoiceVoidable: paid / processing invoices stay non-
 *     voidable so an admin click can't erase revenue.
 *
 * Imported by services/invoice.js and the audit unit tests.
 */

const INVOICE_UPDATE_ALLOWED_FIELDS = Object.freeze([
  'title', 'notes', 'email_message', 'due_date', 'line_items', 'tax_rate',
]);

const INVOICE_UNCOLLECTIBLE_STATUSES = Object.freeze([
  'paid',
  'prepaid',
  'processing',
  'void',
  'refunded',
  'canceled',
  'cancelled',
]);

function invoiceStatusKey(status) {
  return String(status || '').trim().toLowerCase();
}

/**
 * The amount a customer must actually pay for an invoice: its total minus any
 * account credit already applied (credit_applied). Computed in integer cents to
 * avoid float drift, clamped at 0. This is the canonical "charge base" — every
 * Stripe/Terminal/autopay charge path and the webhook amount-verification must
 * price from THIS, not raw invoice.total, or a credit-applied invoice
 * over-collects (admin apply-credit forbids partials for exactly this reason).
 */
function invoiceAmountDue(invoice) {
  const totalCents = Math.round((Number(invoice && invoice.total) || 0) * 100);
  const creditCents = Math.round((Number(invoice && invoice.credit_applied) || 0) * 100);
  return Math.max(0, totalCents - creditCents) / 100;
}

function isInvoiceCollectibleStatus(status) {
  return !INVOICE_UNCOLLECTIBLE_STATUSES.includes(invoiceStatusKey(status));
}

function assertInvoiceCollectible(currentStatus) {
  const status = invoiceStatusKey(currentStatus);
  if (status === 'paid') {
    throw new Error('Invoice already paid');
  }
  if (status === 'prepaid') {
    throw new Error('Invoice is already prepaid');
  }
  if (status === 'processing') {
    throw new Error('Bank payment is already processing');
  }
  if (status === 'void') {
    throw new Error('Invoice is void and cannot be paid');
  }
  if (status === 'refunded') {
    throw new Error('Invoice has been refunded and cannot be paid');
  }
  if (status === 'canceled' || status === 'cancelled') {
    throw new Error('Invoice is canceled and cannot be paid');
  }
}

function assertInvoiceVoidable(currentStatus) {
  if (currentStatus === 'paid') {
    throw new Error('Cannot void a paid invoice — issue a refund instead');
  }
  // 'prepaid' IS voidable: the void path returns the applied account credit to
  // the customer's balance (restoreAccountCreditForVoidedInvoice), so it is no
  // longer stranded. (Cash-backed prepayments book a payment row at issuance and
  // are caught by the in-flight/paid guards above and the void path's own
  // payment_recorded_at check.)
  if (currentStatus === 'processing') {
    throw new Error('Cannot void an invoice with a payment in flight — wait for it to settle, then refund if needed');
  }
}

module.exports = {
  INVOICE_UPDATE_ALLOWED_FIELDS,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  assertInvoiceCollectible,
  assertInvoiceVoidable,
  isInvoiceCollectibleStatus,
  invoiceAmountDue,
};
