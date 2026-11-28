// The ALLOCATION of a failed payment attempt: either the invoices that attempt
// was collecting for, OR (for invoice-less monthly Auto Pay dues) the monthly
// dues obligation (billed_month) / superseding payment that satisfied it.
//
// A combined PaymentIntent covers several invoices and has one payments row per
// invoice (metadata.invoice_id), all sharing the PI id; the alert may also carry
// payload.invoiceId. That allocation is SETTLED when it is non-empty and every
// invoice in it is paid/prepaid.
//
// An invoice-less monthly Auto Pay dues attempt stays `status = 'failed'` when
// a retry rung or Charge Now recovers it (`superseded_by_payment_id` points at
// the new payment, or another paid dues payment / paid stamped dues invoice
// settles that customer + billed_month). It is SETTLED when:
//   - the attempt's own ledger row is now `paid`, OR
//   - its `superseded_by_payment_id` points to a DIFFERENT payment row whose
//     status is `paid` (never self-supersede, never a failed retry rung, never
//     in-flight ACH `processing`), OR
//   - a `paid` monthly-dues payment OR `paid`/`prepaid` stamped dues invoice
//     exists for the same `(customer_id, billed_month)`.
//
// Ledger metadata.invoice_id can be a legacy non-UUID value; comparing it to
// invoices.id (uuid) would throw, so every id is format-checked here first and
// a malformed one is ignored.
const { dateOnlyString } = require('../utils/date-only');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BILLED_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid'];
const MONTHLY_MARKER = 'WaveGuard Monthly';

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

function validBilledMonth(value) {
  const s = value == null ? '' : String(value).trim();
  return BILLED_MONTH_RE.test(s) ? s : null;
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) || {} : {}; } catch { return {}; }
}

// The invoice id a ledger row names, or null when absent or not a UUID.
function ledgerInvoiceId(row) {
  const id = parseJson(row?.metadata).invoice_id;
  return id != null && isUuid(String(id)) ? String(id) : null;
}

function rowBilledMonth(row) {
  if (!row) return null;
  const meta = parseJson(row.metadata);
  const stamped = validBilledMonth(meta.billed_month);
  if (stamped) return stamped;
  if (String(row.description || '').includes(MONTHLY_MARKER)) {
    const ymd = dateOnlyString(row.payment_date);
    return ymd ? validBilledMonth(ymd.slice(0, 7)) : null;
  }
  return null;
}

function monthlyDuesContextOf(attempt, ledgerRows = []) {
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  const billedMonth = validBilledMonth(attempt?.billedMonth)
    || rows.map(rowBilledMonth).find(Boolean)
    || null;
  const customerId = attempt?.customerId
    || rows.find((r) => r && r.customer_id)?.customer_id
    || null;
  return { customerId: customerId ? String(customerId) : null, billedMonth };
}

async function loadAttemptLedgerRows(conn, paymentIntentId) {
  if (!paymentIntentId) return [];
  const rows = await conn('payments')
    .where({ stripe_payment_intent_id: String(paymentIntentId) })
    .select('id', 'customer_id', 'status', 'superseded_by_payment_id', 'payment_date', 'description', 'metadata');
  return Array.isArray(rows) ? rows : [];
}

function extractAllocationInvoiceIds({ invoiceId = null, allocationInvoiceIds = null } = {}, ledgerRows = []) {
  const ids = new Set();
  if (invoiceId != null && isUuid(String(invoiceId))) ids.add(String(invoiceId));
  // The combined allocation queued from the PaymentIntent's own metadata: the
  // full set, even when a synchronous failure left no ledger row per invoice.
  for (const id of Array.isArray(allocationInvoiceIds) ? allocationInvoiceIds : []) {
    if (isUuid(String(id))) ids.add(String(id));
  }
  for (const row of ledgerRows) {
    const id = ledgerInvoiceId(row);
    if (id) ids.add(id);
  }
  return [...ids];
}

// Valid invoice ids of the failed attempt's allocation (deduplicated).
async function failedAllocationInvoiceIds(conn, { paymentIntentId = null, invoiceId = null, allocationInvoiceIds = null } = {}) {
  const ledgerRows = await loadAttemptLedgerRows(conn, paymentIntentId);
  return extractAllocationInvoiceIds({ invoiceId, allocationInvoiceIds }, ledgerRows);
}

// True when `ids` is non-empty and every invoice in it exists as paid/prepaid.
async function invoicesAllSettled(conn, ids) {
  if (!ids.length) return false;
  const rows = await conn('invoices').whereIn('id', ids).whereIn('status', SETTLED_INVOICE_STATUSES).select('id');
  return new Set((rows || []).map((r) => String(r.id))).size >= ids.length;
}

// Invoice-less monthly Auto Pay settlement check: settled once the attempt
// itself paid, was superseded by a DIFFERENT paid payment row, or the same
// customer + billed_month now has a paid dues payment or paid/prepaid stamped
// dues invoice. Self-supersedes (SCA park / ambiguous park) and `processing`
// ACH rows never count as settled.
async function isMonthlyAttemptSettled(conn, attempt, ledgerRows = []) {
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  if (rows.some((r) => r && r.status === 'paid')) return true;

  const supIds = [...new Set(
    rows
      .filter((r) => r && r.superseded_by_payment_id != null && String(r.superseded_by_payment_id) !== String(r.id))
      .map((r) => r.superseded_by_payment_id),
  )];
  if (supIds.length) {
    const paidSup = await conn('payments').whereIn('id', supIds).where({ status: 'paid' }).first('id');
    if (paidSup) return true;
  }

  const { customerId, billedMonth } = monthlyDuesContextOf(attempt, rows);
  if (!customerId || !billedMonth) return false;

  const { findCollectedDuesPayment, findLiveStampedDuesInvoice } = require('./billing-lane');
  if (await findCollectedDuesPayment(conn, customerId, billedMonth, { statuses: ['paid'] })) return true;
  if (await findLiveStampedDuesInvoice(conn, customerId, billedMonth, { openInvoiceCovers: false, settledOnly: true })) return true;
  return false;
}

async function classifySettledFailedAttempt(conn, attempt) {
  // A combined allocation that could not be read never auto-retires, and
  // neither does one with any element that is no longer a UUID (a stored list
  // that was altered must not shrink to "only the paid invoice").
  if (attempt?.allocationUnreadable) return null;
  if (Array.isArray(attempt?.allocationInvoiceIds) && !attempt.allocationInvoiceIds.every((id) => isUuid(String(id)))) return null;
  const ledgerRows = await loadAttemptLedgerRows(conn, attempt?.paymentIntentId || null);
  const ids = extractAllocationInvoiceIds(attempt || {}, ledgerRows);
  if (ids.length) return (await invoicesAllSettled(conn, ids)) ? 'invoice' : null;
  return (await isMonthlyAttemptSettled(conn, attempt, ledgerRows)) ? 'monthly' : null;
}

async function isFailedAllocationSettled(conn, attempt) {
  return (await classifySettledFailedAttempt(conn, attempt)) !== null;
}

module.exports = {
  isUuid,
  validBilledMonth,
  parseJson,
  ledgerInvoiceId,
  rowBilledMonth,
  monthlyDuesContextOf,
  failedAllocationInvoiceIds,
  invoicesAllSettled,
  isMonthlyAttemptSettled,
  classifySettledFailedAttempt,
  isFailedAllocationSettled,
  SETTLED_INVOICE_STATUSES,
};
