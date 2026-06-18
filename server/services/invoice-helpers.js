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
  'title', 'notes', 'due_date', 'line_items', 'tax_rate',
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
  if (currentStatus === 'prepaid') {
    throw new Error('Cannot void a prepaid invoice — the applied account credit would be stranded; reverse the credit instead');
  }
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
};
