/**
 * The invoice version an Intelligence Bar invoice card (edit_invoice, archive_invoice,
 * unarchive_invoice, unvoid_invoice; services/intelligence-bar/invoice-edit-tools.js) showed, enforced by the
 * Invoices page's own handlers. `expected` is set only by the in-process bar shims in routes/admin-invoices.js
 * (never an HTTP field); every other caller passes nothing, so the page's path is unchanged.
 *
 * expected keys (each compared only when present):
 *   status, updatedAt (ms or null), total, creditApplied (dollars), paymentIntentId (null = none),
 *   archived (boolean), customerId (a customer merge repoints invoices.customer_id without moving updated_at, so the
 *   customer the card named is pinned too).
 * updated_at moves on every write to the invoice, so it is the version; the other keys name what the card relied on.
 */
const ms = (value) => (value ? new Date(value).getTime() : null);
const cents = (value) => Math.round((Number(value) || 0) * 100);
const has = (expected, key) => Object.prototype.hasOwnProperty.call(expected, key) && expected[key] !== undefined;

// Each pinned key: how the row reads it and how the card's value is normalized, so the two compare as equal strings.
const VERSION_FIELDS = {
  status: [(row) => String(row.status || ''), (v) => String(v || '')],
  updatedAt: [(row) => ms(row.updated_at), (v) => v ?? null],
  total: [(row) => cents(row.total), (v) => cents(v)],
  creditApplied: [(row) => cents(row.credit_applied), (v) => cents(v)],
  paymentIntentId: [(row) => row.stripe_payment_intent_id || null, (v) => v || null],
  archived: [(row) => Boolean(row.archived_at), (v) => Boolean(v)],
  customerId: [(row) => String(row.customer_id || ''), (v) => String(v || '')],
};

// True when the invoice row no longer reads as the card showed it (only the keys the card named are compared).
function invoiceVersionChanged(row, expected) {
  if (!expected) return false;
  return Object.entries(VERSION_FIELDS).some(([key, [live, pinned]]) => has(expected, key) && live(row) !== pinned(expected[key]));
}

function previewChangedError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  err.status = 409;
  err.isOperational = true;
  err.code = 'PREVIEW_CHANGED';
  return err;
}

function assertInvoiceVersion(row, expected, doing) {
  if (invoiceVersionChanged(row, expected)) throw previewChangedError(`Invoice changed while ${doing} — re-check and retry`);
}

// The same version as extra predicates on the handler's own UPDATE: a change after the read loses atomically.
function applyInvoiceVersion(query, expected) {
  if (!expected) return query;
  if (has(expected, 'status')) query.where('status', expected.status);
  if (has(expected, 'updatedAt')) {
    if (expected.updatedAt) query.whereRaw("date_trunc('milliseconds', updated_at) = ?::timestamptz", [new Date(expected.updatedAt).toISOString()]);
    else query.whereNull('updated_at');
  }
  if (has(expected, 'total')) query.whereRaw('ROUND(COALESCE(total, 0) * 100) = ?', [cents(expected.total)]);
  if (has(expected, 'creditApplied')) query.whereRaw('ROUND(COALESCE(credit_applied, 0) * 100) = ?', [cents(expected.creditApplied)]);
  if (has(expected, 'paymentIntentId')) {
    if (expected.paymentIntentId) query.where('stripe_payment_intent_id', expected.paymentIntentId);
    else query.whereNull('stripe_payment_intent_id');
  }
  if (has(expected, 'archived')) {
    if (expected.archived) query.whereNotNull('archived_at');
    else query.whereNull('archived_at');
  }
  if (has(expected, 'customerId')) {
    if (expected.customerId) query.where('customer_id', expected.customerId);
    else query.whereNull('customer_id');
  }
  return query;
}

module.exports = { invoiceVersionChanged, assertInvoiceVersion, applyInvoiceVersion };
