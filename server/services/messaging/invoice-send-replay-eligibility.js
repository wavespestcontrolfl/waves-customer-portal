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
// ownership check follows. The invoice must also have been finalized as
// sent (see the resendable refusal below). No amount pin: the notice body is the invoice
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
  // Collections DISPUTE hold (owner ruling 2026-09-30): the ONE live hold check
  // for every delayed invoice pay-link delivery - this function is the shared
  // locked provider-boundary eligibility for the queued replay's Text/App/Email
  // legs and for the billing Email provider retry. Placed after the
  // collectibility check, which already refuses a payer-billed invoice, so a
  // third-party payer's AP delivery is exempt. A hold - or a lookup that cannot
  // answer - keeps the leg retryable and DEFERRED (holdDefer), never terminal:
  // it sends after the release. Read on the caller's held handle (savepoint).
  const held = await require('../collections/collection-hold').dueInvoiceHeldByDisputeHold(invoice.customer_id, database);
  if (held.held) {
    return { eligible: false, reason: held.reason === 'lookup_failed' ? 'collection-hold-lookup-failed' : 'collection-hold', retryable: true, holdDefer: true, held };
  }
  const { SEND_FINALIZABLE_STATUSES, invoiceAmountDue, visitRefusesSettlement } = require('../invoice-helpers');
  if (!SEND_FINALIZABLE_STATUSES.includes(invoice.status)) return refused(`invoice-status:${invoice.status}`);
  // A live send claim: the send that queued this Email, or a newer one, still
  // owns the invoice. Wait for it to finalize or restore.
  if (invoice.status === 'sending') return refused('invoice-send-in-flight', true);
  // Never finalized as sent: the send that queued this Email accepted no leg
  // and restored the invoice (possibly reversing credit it applied). A
  // pay-link email must not reach the customer while the invoice still reads
  // unsent, since nothing would finalize it (Codex #4963 P1). Refused as
  // RESENDABLE, not blocked: the row settles as a definitely-unsent failure,
  // so the invoice's next send re-delivers through the same notice key
  // instead of deduping against a block. The one exception is a queued
  // pay-link text whose own finalize marks the delivery
  // (mark_invoice_delivery: sendViaSMSAndEmail's held text, the only delivery
  // when its email leg failed too): that replay IS the finalization, so it
  // may reach an unsent invoice. A stored Email replay context never carries
  // the flag.
  if (!invoice.sent_at && meta.mark_invoice_delivery !== true) {
    return { eligible: false, reason: 'invoice-send-not-finalized', retryable: false, resendable: true };
  }
  if (!(invoiceAmountDue(invoice) > 0)) return refused('invoice-nothing-due');
  const visitStatus = await visitRefusesSettlement(database, await linkedVisitId(invoice, database));
  return visitStatus ? refused(`invoice-visit-${visitStatus}`) : null;
}

module.exports = { invoiceSendRefusal };
