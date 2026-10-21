/**
 * Intelligence Bar — the record_payment card's fences inside the settlement
 * server/services/intelligence-bar/record-payment-fences.js
 *
 * The card (record-payment-tools.js) hands the Invoices page's Record payment handler two things that only the bar sets, so the
 * page's call stays what it was and the settlement (services/invoice-manual-payment.js) carries no card logic:
 *
 *   settlementFence(database, locked)  the settlement's existing fence hook. It runs ONCE before any Stripe session is retired (on
 *       the plain connection, `locked` undefined) and ONCE under the invoice row lock right before the paid flip (on the
 *       transaction, with the locked row). Either run throws a 409 refusal (`drift: true`, which the route answers as
 *       PREVIEW_CHANGED and the card reports as preview_changed) when:
 *         - the invoice is not what the card showed: its status, and the columns that decide what the payment records or completes
 *           (customer, visit link, service record, completion packet, payer links, total, credit). Before the lock the edit time
 *           is compared too; under the lock it cannot be (the combined-session release rewrites it), which is safe because the
 *           settlement builds the invoice notes from the locked row and the paid UPDATE writes no other unpinned column;
 *         - a project's report is held for this payment ('held' / 'releasing'): paying would release it to the customer, which
 *           the card cannot disclose. Under the lock the project rows are locked FOR UPDATE;
 *         - an annual-prepay term resolves to the invoice (its tag, its visit's term as the anchor, or a term whose
 *           prepay_invoice_id is this invoice): those settle a prepaid term and stay on the Invoices page.
 *       A lookup that throws aborts the settlement: nothing is recorded (fail closed).
 *
 *   receiptGuard { check, relabel }  the provider-boundary check for the inline receipt (beforeProviderHandoff on the receipt email
 *       and text). It allows a send only to the email / phone the card showed (digests, receipt-destination-digest.js); the App leg
 *       is never approved. `relabel` words a refused leg "receipt not sent: contact changed".
 */
const { emailDigest, phoneDigest } = require('../receipt-destination-digest');

const PINNED_COLUMNS = ['customer_id', 'scheduled_service_id', 'service_record_id', 'visit_completion_packet_id', 'payer_id', 'payer_statement_id', 'total', 'credit_applied'];
const MONEY_COLUMNS = new Set(['total', 'credit_applied']);
const columnValue = (row, key) => (MONEY_COLUMNS.has(key) ? String(Math.round((Number(row[key]) || 0) * 100)) : String(row[key] ?? ''));
const pinnedColumnsOf = (invoice) => Object.fromEntries(PINNED_COLUMNS.map((key) => [key, invoice[key] ?? null]));

const DRIFT_TEXT = 'The invoice changed after the confirmation card was shown — nothing was recorded';
const HELD_REPORT_TEXT = 'Recording this payment releases a held report to the customer, which the bar can\'t do from here yet; record it on the Invoices page — nothing was recorded';
const ANNUAL_TEXT = 'This is an annual-plan invoice — nothing was recorded. Record the payment from the Invoices page.';
const CONTACT_CHANGED = 'receipt not sent: contact changed';

const drift = (message) => Object.assign(new Error(message), { statusCode: 409, isOperational: true, drift: true });

function rowMatchesPin(row, pin, { editTime }) {
  if (!row || String(row.status || '').toLowerCase() !== String(pin.status || '').toLowerCase()) return false;
  if (editTime && (row.updated_at ? new Date(row.updated_at).getTime() : null) !== (pin.updatedAtMs ?? null)) return false;
  return PINNED_COLUMNS.every((key) => columnValue(row, key) === columnValue(pin.columns, key));
}

async function heldReportExists(database, invoiceId, { lock }) {
  const query = database('projects').where({ invoice_id: invoiceId });
  const projects = await (lock ? query.forUpdate() : query).select('id', 'report_hold_status');
  return projects.some((p) => ['held', 'releasing'].includes(String(p.report_hold_status || '').toLowerCase()));
}

async function annualTermExists(database, row) {
  if (await require('../invoice-prepay').resolveInvoiceTermId(row, database, { strict: true })) return true;
  return Boolean((await database.schema.hasTable('annual_prepay_terms'))
    && await database('annual_prepay_terms').where({ prepay_invoice_id: row.id }).first('id'));
}

// pin: { invoiceId, status, updatedAtMs, columns } as the card read the invoice.
function settlementFenceFor(pin) {
  return async (database, locked = null) => {
    const row = locked || await database('invoices').where({ id: pin.invoiceId }).first();
    if (!rowMatchesPin(row, pin, { editTime: !locked })) throw drift(DRIFT_TEXT);
    if (await heldReportExists(database, pin.invoiceId, { lock: Boolean(locked) })) throw drift(HELD_REPORT_TEXT);
    if (await annualTermExists(database, row)) throw drift(ANNUAL_TEXT);
    return true;
  };
}

// approved: { email, phone } digests the card showed (null = no such leg).
function receiptGuardFor(approved) {
  const refused = new Set();
  const check = async (facts) => {
    const channel = facts?.channel;
    const allowed = (channel === 'email' && Boolean(approved.email) && emailDigest(facts.to) === approved.email)
      || (channel === 'sms' && Boolean(approved.phone) && phoneDigest(facts.to) === approved.phone);
    if (!allowed) refused.add(channel);
    return allowed;
  };
  // A leg the check refused reads as the contact change it was, not as a provider failure.
  const relabel = ({ emailResult, smsResult }) => ({
    emailResult: refused.has('email') && emailResult && !emailResult.ok ? { ok: false, error: CONTACT_CHANGED } : emailResult,
    smsResult: refused.has('sms') && smsResult && !smsResult.ok ? { ok: false, error: CONTACT_CHANGED } : smsResult,
  });
  return { check, relabel };
}

module.exports = { settlementFenceFor, receiptGuardFor, pinnedColumnsOf, PINNED_COLUMNS, CONTACT_CHANGED };
