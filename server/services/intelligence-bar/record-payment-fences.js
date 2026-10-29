/**
 * Intelligence Bar — the record_payment card's fences inside the settlement
 * server/services/intelligence-bar/record-payment-fences.js
 *
 * The card (record-payment-tools.js) hands the Invoices page's Record payment handler one thing that only the bar sets, so the
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
 *         - the ET day is not the day the card showed (midnight passed), or the visit the card said the payment would complete has
 *           been edited since (edit time, scheduled date, service type) or is gone, or a technician started its job timer since (the
 *           closeout's own visitJobTimerRunning: a running timer leaves the visit open, so the promised closeout would not happen);
 *         - an annual-prepay term resolves to the invoice (its tag, its visit's term as the anchor, or a term whose
 *           prepay_invoice_id is this invoice): those settle a prepaid term and stay on the Invoices page.
 *       A lookup that throws aborts the settlement: nothing is recorded (fail closed).
 *       The function also carries `closeoutTarget` (the visit the card said the payment would complete, or 'none') and `closeoutVisit`
 *       (that visit's facts as the card showed them): the settlement pins both and the closeout re-asserts the facts under the visit's lock.
 */
const { etDateString } = require('../../utils/datetime-et');

const PINNED_COLUMNS = ['customer_id', 'scheduled_service_id', 'service_record_id', 'visit_completion_packet_id', 'payer_id', 'payer_statement_id', 'total', 'credit_applied'];
const MONEY_COLUMNS = new Set(['total', 'credit_applied']);
const columnValue = (row, key) => (MONEY_COLUMNS.has(key) ? String(Math.round((Number(row[key]) || 0) * 100)) : String(row[key] ?? ''));
const pinnedColumnsOf = (invoice) => Object.fromEntries(PINNED_COLUMNS.map((key) => [key, invoice[key] ?? null]));

const DRIFT_TEXT = 'The invoice changed after the confirmation card was shown — nothing was recorded';
const DATE_TEXT = 'The day changed after the confirmation card was shown, so the payment would be recorded as of a different day — nothing was recorded';
const VISIT_TEXT = 'The linked visit changed after the confirmation card was shown — nothing was recorded';
const TIMER_TEXT = 'A technician started the visit timer since this card; try again after the visit — nothing was recorded';
const ANNUAL_TEXT = 'This is an annual-plan invoice — nothing was recorded. Record the payment from the Invoices page.';

const drift = (message) => Object.assign(new Error(message), { statusCode: 409, isOperational: true, drift: true });

function rowMatchesPin(row, pin, { editTime }) {
  if (!row || String(row.status || '').toLowerCase() !== String(pin.status || '').toLowerCase()) return false;
  if (editTime && (row.updated_at ? new Date(row.updated_at).getTime() : null) !== (pin.updatedAtMs ?? null)) return false;
  return PINNED_COLUMNS.every((key) => columnValue(row, key) === columnValue(pin.columns, key));
}

const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

// The visit the card said the payment's closeout would complete, as the card read it: its edit time, scheduled date and service type.
// A visit edited (or gone) since refuses, rather than completing a changed visit. Read on the settlement's own handle: under the lock
// that is the transaction, which by then holds the linked visit's lock (visitRefusesSettlement runs before the fence).
async function closeoutVisitUnchanged(database, visit) {
  const row = await database('scheduled_services').where({ id: visit.visitId }).first('id', 'updated_at', 'scheduled_date', 'service_type', 'status');
  return Boolean(row)
    && (row.updated_at ? new Date(row.updated_at).getTime() : null) === visit.updatedAtMs
    && dateOnly(row.scheduled_date) === visit.date
    && (row.service_type || null) === (visit.serviceType || null)
    && (visit.status === undefined || (row.status ?? null) === (visit.status ?? null));
}

async function annualTermExists(database, row) {
  if (await require('../invoice-prepay').resolveInvoiceTermId(row, database, { strict: true })) return true;
  return Boolean((await database.schema.hasTable('annual_prepay_terms'))
    && await database('annual_prepay_terms').where({ prepay_invoice_id: row.id }).first('id'));
}

// pin: { invoiceId, status, updatedAtMs, columns, closeoutTarget, closeout, paymentDate } as the card read the invoice. closeout is the
// visit the closeout would complete { visitId, serviceType, date, updatedAtMs } (null = none); paymentDate is the ET day the card showed. closeoutTarget is the visit the card
// said the payment's closeout would complete, or 'none': the settlement pins it in its transaction and hands it to the closeout
// (invoice-issued-closeout.js approvedTarget), so a visit that became closable after the card is left open, on retries too.
function settlementFenceFor(pin) {
  const fence = async (database, locked = null) => {
    const row = locked || await database('invoices').where({ id: pin.invoiceId }).first();
    if (!rowMatchesPin(row, pin, { editTime: !locked })) throw drift(DRIFT_TEXT);
    // The ledger row and the invoice note are stamped with the ET day the settlement runs on: never a different day than the card's.
    if (pin.paymentDate !== etDateString()) throw drift(DATE_TEXT);
    if (pin.closeout && !(await closeoutVisitUnchanged(database, pin.closeout))) throw drift(VISIT_TEXT);
    // A job timer started after the card leaves no mark on the visit row, yet the closeout leaves a visit with a running timer open: the
    // promised closeout would silently not happen. The closeout's own predicate, on the same handle.
    if (pin.closeout && await require('../invoice-issued-closeout').visitJobTimerRunning(database, pin.closeout.visitId)) throw drift(TIMER_TEXT);
    if (await annualTermExists(database, row)) throw drift(ANNUAL_TEXT);
    return true;
  };
  fence.closeoutTarget = pin.closeoutTarget;
  // The carded visit's facts, pinned with the target and re-asserted by the closeout under the visit's lock.
  fence.closeoutVisit = pin.closeout ? { serviceType: pin.closeout.serviceType, date: pin.closeout.date, status: pin.closeout.status, updatedAtMs: pin.closeout.updatedAtMs } : null;
  return fence;
}

module.exports = { settlementFenceFor, pinnedColumnsOf, PINNED_COLUMNS };
