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

function assertInvoiceVoidable(currentStatus) {
  if (currentStatus === 'paid') {
    throw new Error('Cannot void a paid invoice — issue a refund instead');
  }
  if (currentStatus === 'processing') {
    throw new Error('Cannot void an invoice with a payment in flight — wait for it to settle, then refund if needed');
  }
}

module.exports = { INVOICE_UPDATE_ALLOWED_FIELDS, assertInvoiceVoidable };
