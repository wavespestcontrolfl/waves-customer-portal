/**
 * The invoice version an Intelligence Bar invoice card (edit_invoice, apply_invoice_credit, archive_invoice,
 * unarchive_invoice, unvoid_invoice; services/intelligence-bar/invoice-edit-tools.js) showed, enforced by the
 * Invoices page's own handlers. `expected` is set only by the in-process bar shims in routes/admin-invoices.js
 * (never an HTTP field); every other caller passes nothing, so the page's path is unchanged.
 *
 * expected keys (each compared only when present):
 *   status, updatedAt (ms or null), total, creditApplied (dollars), paymentIntentId (null = none),
 *   archived (boolean), payerId (null = self-pay; a payer stamped on the row without moving updated_at, e.g.
 *   reverseCreditAndStampPayer, would otherwise leave the card's figures computed for the wrong owner).
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
  payerId: [(row) => String(row.payer_id || ''), (v) => String(v || '')],
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
  if (has(expected, 'payerId')) {
    if (expected.payerId) query.where('payer_id', expected.payerId);
    else query.whereNull('payer_id');
  }
  return query;
}

// The bar's edit retotal was computed for a verified self-pay owner (expected.selfPayLive): on the locked row, the canonical live
// resolver must still say so (a payer assigned since through the customer default or the visit, or an unverifiable answer, refuses).
// Verifiably the homeowner's right now: the canonical resolver (stamped payer, customer default, scheduled service) says self-pay
// AND no payer owns the visit (also reached through a service record, which the resolver does not follow). Throws when unverifiable.
async function verifiedSelfPay(row, conn) {
  if (await require('./invoice-payer-ownership').invoicePayerOwnership(row, conn) !== null) return false;
  if (!(row.scheduled_service_id || row.service_record_id)) return true;
  return !await require('./visit-linked-invoice-withdrawal').liveVisitPayerOf(conn, row);
}

// A bar retotal also may not land on an annual-plan anchor linked only through its visit (a schedule refresh stamps the visit,
// never the invoice): the visit row is held FOR SHARE for the rest of the save, then the strict resolver runs. Unverifiable refuses.
// The visit lock for a bar retotal, taken BEFORE the invoice row lock (visit -> invoice, the schedule's Bill-To order). Returns
// the visit id it holds (null: no visit link, or not a bar retotal).
async function lockBarRetotalVisit(conn, existing, expected) {
  if (!expected?.selfPayLive || !existing?.scheduled_service_id) return null;
  await conn('scheduled_services').where({ id: existing.scheduled_service_id }).forShare().first('id');
  return existing.scheduled_service_id;
}

async function annualPlanLive(row, conn) {
  try {
    return Boolean(await require('./invoice-prepay').resolveInvoiceTermId(row, conn, { strict: true }));
  } catch {
    return true;
  }
}

async function assertSelfPayLive(row, expected, conn, heldVisitId = null) {
  if (!expected?.selfPayLive) return;
  // The visit held before the invoice lock must still be the invoice's visit.
  if (String(row.scheduled_service_id || '') !== String(heldVisitId || '')) {
    throw previewChangedError('Invoice changed while editing — its visit link moved; re-check and retry');
  }
  if (await annualPlanLive(row, conn)) {
    throw previewChangedError('Invoice changed while editing — it is now (or may be) part of an annual plan; re-check and retry');
  }
  let selfPay = false;
  try { selfPay = await verifiedSelfPay(row, conn); } catch { selfPay = false; }
  if (!selfPay) {
    throw previewChangedError('Invoice changed while editing — a payer now owns it (or who owes it could not be verified); re-check and retry');
  }
}

module.exports = { lockBarRetotalVisit, verifiedSelfPay, assertSelfPayLive, invoiceVersionChanged, assertInvoiceVersion, assertExpectedNewTotal, applyInvoiceVersion };
