// The ALLOCATION of a failed payment attempt: the invoices that attempt was
// collecting for. A combined PaymentIntent covers several invoices and has one
// payments row per invoice (metadata.invoice_id), all sharing the PI id; the
// alert may also carry payload.invoiceId. The allocation is SETTLED when it is
// non-empty and every invoice in it is paid/prepaid. A payment_failed alert is
// obsolete exactly then: dispatch (payment-failure-notifications.js) refuses to
// raise one for a settled allocation, and the closer
// (payment-failed-alert-close.js) closes one only when its whole allocation is
// settled, not when just the invoice that triggered the hook is.
//
// Ledger metadata.invoice_id can be a legacy non-UUID value; comparing it to
// invoices.id (uuid) would throw, so every id is format-checked here first and
// a malformed one is ignored.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid'];

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) || {} : {}; } catch { return {}; }
}

// The invoice id a ledger row names, or null when absent or not a UUID.
function ledgerInvoiceId(row) {
  const id = parseJson(row?.metadata).invoice_id;
  return id != null && isUuid(String(id)) ? String(id) : null;
}

// Valid invoice ids of the failed attempt's allocation (deduplicated).
async function failedAllocationInvoiceIds(conn, { paymentIntentId = null, invoiceId = null } = {}) {
  const ids = new Set();
  if (invoiceId != null && isUuid(String(invoiceId))) ids.add(String(invoiceId));
  if (paymentIntentId) {
    const rows = await conn('payments').where({ stripe_payment_intent_id: String(paymentIntentId) }).select('metadata');
    for (const row of rows || []) {
      const id = ledgerInvoiceId(row);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

// True when `ids` is non-empty and every invoice in it exists as paid/prepaid.
async function invoicesAllSettled(conn, ids) {
  if (!ids.length) return false;
  const rows = await conn('invoices').whereIn('id', ids).whereIn('status', SETTLED_INVOICE_STATUSES).select('id');
  return new Set((rows || []).map((r) => String(r.id))).size >= ids.length;
}

async function isFailedAllocationSettled(conn, attempt) {
  return invoicesAllSettled(conn, await failedAllocationInvoiceIds(conn, attempt));
}

module.exports = {
  isUuid, parseJson, ledgerInvoiceId, failedAllocationInvoiceIds, invoicesAllSettled, isFailedAllocationSettled,
  SETTLED_INVOICE_STATUSES,
};
