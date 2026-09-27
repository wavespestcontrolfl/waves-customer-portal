// Provider-retry eligibility for a direct invoice notice's Email leg (#4963):
// the immediate send and its queued replay (billing-email-replay-context.js
// INVOICE_SEND_SOURCES). No collections reservation backs these, so no
// collections policy applies either; the retry re-runs the invoice send's own
// delivery checks instead.
const { INVOICE_SEND_SOURCES } = require('../billing-email-replay-context');

function refused(reason, retryable = false) {
  return { eligible: false, reason, retryable };
}

async function linkedVisitId(invoice, database) {
  if (invoice.scheduled_service_id) return invoice.scheduled_service_id;
  if (!invoice.service_record_id) return null;
  const record = await database('service_records').where({ id: invoice.service_record_id }).first('scheduled_service_id');
  return record?.scheduled_service_id || null;
}

// invoice.js checkInvoiceDeliveryPreconditions, minus the send claim the
// original attempt held, on the Email authority's transaction (which already
// holds the invoice row lock): same customer, still collectible (not paid,
// void or processing; no payer; not withdrawn), a status a send may deliver
// from, something still due, and a linked visit that still ran. The caller's
// ownership check follows. No amount pin: the notice body is the invoice
// text, which names no dollar amount (the pay page shows the live balance),
// so a partial payment or credit leaves it accurate.
async function invoiceSendRefusal(meta, database) {
  if (!INVOICE_SEND_SOURCES.has(meta.source_entry_point)) return null;
  if (!meta.invoice_id) return refused('invoice-missing');
  const invoice = await database('invoices').where({ id: meta.invoice_id }).first();
  if (!invoice) return refused('invoice-missing');
  if (String(invoice.customer_id) !== String(meta.customer_id)) return refused('invoice-customer-changed');
  const collectible = await require('./deferred-replay-registry').invoiceStillCollectible(meta, database);
  if (collectible.eligible !== true) return refused(collectible.reason, collectible.retryable === true);
  const { SEND_FINALIZABLE_STATUSES, invoiceAmountDue, visitRefusesSettlement } = require('../invoice-helpers');
  if (!SEND_FINALIZABLE_STATUSES.includes(invoice.status)) return refused(`invoice-status:${invoice.status}`);
  if (!(invoiceAmountDue(invoice) > 0)) return refused('invoice-nothing-due');
  const visitStatus = await visitRefusesSettlement(database, await linkedVisitId(invoice, database));
  return visitStatus ? refused(`invoice-visit-${visitStatus}`) : null;
}

module.exports = { invoiceSendRefusal };
