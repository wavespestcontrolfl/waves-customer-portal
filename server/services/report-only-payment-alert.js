'use strict';

// The office check after a "report only, no pay link" completion (owner
// 2026-10-30, option A of the tech portal gaps audit). A technician cannot
// record cash or a check (record-payment is admin-only), so a bill still open
// the day after a report-only closeout usually means money the office must
// record. One needs-you alert per invoice, raised from the next ET day on; the
// same pass closes it once the bill is paid, voided, handed to a payer or no
// longer owed. Office-side only: it sends the customer nothing.
//
// The completion records the choice as structured_notes.payLinkOmitted
// (complete-scheduled-service.js). Gate: GATE_REPORT_ONLY_PAYMENT_ALERT,
// read per tick by the scheduler (reportOnlyPaymentAlertLive).

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { invoiceAmountDue, isInvoiceCollectibleStatus, invoiceWithdrawnFromCustomer } = require('./invoice-helpers');
const { completionNewestLiveInvoiceLookup } = require('./completion-invoice-candidate');

const KEY_PREFIX = 'report-only-payment:';
// A report-only visit older than this stops raising new alerts; an alert that
// is already open still closes when its bill settles.
const LOOKBACK_DAYS = 30;
const RESOLUTION = 'The bill was paid, voided or is no longer owed';

const alertKey = (invoiceId) => `${KEY_PREFIX}${invoiceId}`;

// Money is still owed by the customer on this bill: a live status, a balance,
// and not billed to a third-party payer.
function stillOwed(invoice) {
  return !!invoice
    && isInvoiceCollectibleStatus(invoice.status)
    && invoiceAmountDue(invoice) > 0
    && !invoice.payer_id
    && !invoiceWithdrawnFromCustomer(invoice);
}

// Report-only completions from before today (ET) inside the lookback window.
async function reportOnlyRecords(now) {
  return db('service_records as sr')
    .leftJoin('customers as c', 'c.id', 'sr.customer_id')
    .leftJoin('technicians as t', 't.id', 'sr.technician_id')
    .whereRaw("sr.structured_notes->>'payLinkOmitted' = 'true'")
    .whereRaw("(sr.created_at AT TIME ZONE 'America/New_York')::date < ?::date", [etDateString(now)])
    .where('sr.created_at', '>=', new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000))
    .select('sr.id', 'sr.scheduled_service_id', 'sr.created_at',
      'c.first_name', 'c.last_name', 't.name as technician_name');
}

function alertSpec(invoice, record) {
  const names = require('./admin-alert-names');
  const amount = `$${invoiceAmountDue(invoice).toFixed(2)}`;
  const customer = names.fullName(record) || 'a customer';
  const tech = names.tidyName(record.technician_name);
  const day = names.shortDateET(record.created_at);
  return {
    area: 'Billing',
    severity: 'needs-you',
    who: 'person',
    action: names.fitAction('Billing', customer, [
      (n) => `record ${n}'s ${amount} payment`,
      (n) => `record ${n}'s payment`,
    ]),
    why: `${tech || 'The visit'} closed ${day} with no pay link, and the ${amount} bill is still open.`,
    link: `/admin/invoices?invoice=${invoice.id}`,
    subject: { type: 'invoice', id: String(invoice.id) },
    doneWhen: 'invoice_paid',
  };
}

async function runReportOnlyPaymentCheck({ now = new Date() } = {}) {
  const { composeAdminAlert } = require('./admin-alert-compose');
  const episodes = require('./admin-alert-episodes');

  const owed = new Map();
  for (const record of await reportOnlyRecords(now)) {
    const invoice = await completionNewestLiveInvoiceLookup(db, {
      serviceRecordId: record.id, scheduledServiceId: record.scheduled_service_id,
    });
    if (stillOwed(invoice) && !owed.has(alertKey(invoice.id))) owed.set(alertKey(invoice.id), { invoice, record });
  }

  // Close first: an open alert whose bill no longer qualifies. A key outside
  // this pass's window is judged by reading its bill again, so an alert never
  // closes just because its visit aged out of the lookback.
  let closed = 0;
  const settled = [];
  for (const key of await episodes.openAdminAlertKeys(db, KEY_PREFIX)) {
    if (owed.has(key)) continue;
    const invoice = await db('invoices').where({ id: key.slice(KEY_PREFIX.length) }).first();
    if (!stillOwed(invoice)) settled.push(key);
  }
  if (settled.length) {
    closed = await episodes.closeAdminAlertKeys(db, settled, 'report_only_bill_settled', { resolution: RESOLUTION });
  }

  let raised = 0;
  for (const [key, { invoice, record }] of owed) {
    try {
      // A standing row for the key dedupes silently: one ring per episode. A
      // row this pass closed (a bank payment processing, a payer handoff) and
      // whose bill is owed again (the debit returned) reopens and rings.
      const composed = composeAdminAlert(alertSpec(invoice, record));
      await episodes.raiseAdminAlertWithReopen('billing', composed.headline, composed.why, {
        link: composed.link, dedupeKey: key, metadata: composed.metadata,
      });
      raised += 1;
    } catch (err) {
      logger.error(`[report-only-payment-alert] invoice ${invoice.id}: ${err.message}`);
    }
  }
  return { checked: owed.size, raised, closed };
}

module.exports = { runReportOnlyPaymentCheck, _private: { stillOwed, alertSpec, alertKey, KEY_PREFIX } };
