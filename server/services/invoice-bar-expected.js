/**
 * The invoice version an Intelligence Bar invoice card (edit_invoice, apply_invoice_credit, archive_invoice,
 * unarchive_invoice, unvoid_invoice; services/intelligence-bar/invoice-edit-tools.js) showed, enforced by the
 * Invoices page's own handlers. `expected` is set only by the in-process bar shims in routes/admin-invoices.js
 * (never an HTTP field); every other caller passes nothing, so the page's path is unchanged.
 *
 * expected keys (each compared only when present):
 *   status, updatedAt (ms or null), total, creditApplied (dollars), paymentIntentId (null = none),
 *   archived (boolean).
 * updated_at moves on every write to the invoice, so it is the version; the other keys name what the card relied on.
 */
const ms = (value) => (value ? new Date(value).getTime() : null);
const cents = (value) => Math.round((Number(value) || 0) * 100);
const has = (expected, key) => Object.prototype.hasOwnProperty.call(expected, key) && expected[key] !== undefined;

// True when the invoice row no longer reads as the card showed it.
function invoiceVersionChanged(row, expected) {
  if (!expected) return false;
  if (has(expected, 'status') && String(row.status || '') !== String(expected.status || '')) return true;
  if (has(expected, 'updatedAt') && ms(row.updated_at) !== (expected.updatedAt ?? null)) return true;
  if (has(expected, 'total') && cents(row.total) !== cents(expected.total)) return true;
  if (has(expected, 'creditApplied') && cents(row.credit_applied) !== cents(expected.creditApplied)) return true;
  if (has(expected, 'paymentIntentId') && (row.stripe_payment_intent_id || null) !== (expected.paymentIntentId || null)) return true;
  if (has(expected, 'archived') && Boolean(row.archived_at) !== Boolean(expected.archived)) return true;
  return false;
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

// The edit card also showed the new total: a retotal that now computes to another figure (a discount rule or a customer type
// changed since) is refused rather than saved under an approval for a different number. `total` is the edit's computed total
// (undefined when the edit does not retotal).
function assertExpectedNewTotal(expected, total) {
  if (!expected || expected.newTotal === undefined || total === undefined) return;
  if (cents(total) !== cents(expected.newTotal)) {
    throw previewChangedError('Invoice changed while editing — the new total is no longer what the card showed; re-check and retry');
  }
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
  return query;
}

module.exports = { invoiceVersionChanged, assertInvoiceVersion, assertExpectedNewTotal, applyInvoiceVersion };
