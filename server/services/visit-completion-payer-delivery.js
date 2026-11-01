'use strict';

// GATE_PAYER_PACKET_AUTOSEND. A grouped closeout whose billed members all resolve to ONE active third-party payer
// mints a single invoice owned by that payer (visit-completion-invoice.js). The homeowner is never asked to pay it
// (no pay link in the summary text, no charge: visit-completion-payment.js answers `payer_billed`). This module is the
// packet twin of complete-scheduled-service.js `sendPayerInvoiceToApIfEligible`: it emails the invoice to the payer's
// AP inbox (InvoiceEmail reroutes a payer invoice there and refuses to fall back to the homeowner) and finalizes it
// with markDeliverySent, once. The packet's effects phase calls it on every run, so it is built to be re-entered.
const db = require('../models/db');
const logger = require('./logger');

// Statuses that mean the invoice has already been delivered, or has left delivery for good.
const DELIVERED_OR_TERMINAL = new Set([
  'sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled',
]);
const CLAIM_LEASE_MINUTES = 10;

// The payer invoice stays for the office: an unfinalized draft (the single-visit path's failed AP send), now also
// raised as the packet's existing payer office review. The homeowner is never texted or emailed in its place.
function officeVerdict(payment) {
  return { state: 'office_required', reason: 'payer_assigned', payerId: payment.payerId || null, invoiceId: payment.invoiceId };
}

async function packetIsBackfill(database, packetId) {
  const { parseJsonObject } = require('./job-costing');
  const rows = await database('visit_completion_packet_items as i').join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packetId).select('r.structured_notes');
  return rows.some((row) => parseJsonObject(row.structured_notes).backfill);
}

// One runner at a time (the recovery sweep and a Resume tap can overlap): a short lease on the packet payload,
// taken in one conditional UPDATE. A crashed runner's lease expires; email_sent_at (stamped by sendInvoiceEmail the
// moment the provider accepts) then keeps the retry from mailing AP twice.
async function claimPayerDelivery(database, packetId, invoiceId) {
  const claimed = await database('visit_completion_packets').where({ id: packetId })
    .whereRaw(`COALESCE((payload #>> '{payerDelivery,claimedAt}')::timestamptz, 'epoch'::timestamptz) < NOW() - interval '${CLAIM_LEASE_MINUTES} minutes'`)
    .update({
      payload: database.raw('payload || ?::jsonb', [JSON.stringify({ payerDelivery: { invoiceId, claimedAt: new Date().toISOString() } })]),
      updated_at: database.fn.now(),
    });
  return Number(claimed) > 0;
}

// True when the invoice is finalized. A failure is reported, never swallowed: the caller keeps the packet on the
// recovery sweep, and the next run (email_sent_at is already stamped) repeats only this step.
async function finalizeDelivery(invoiceId) {
  try {
    await require('./invoice').markDeliverySent(invoiceId, { email: true, source: 'dispatch_completion_payer' });
    return true;
  } catch (err) {
    // AP already has the email (email_sent_at is stamped); a failed finalize must never re-send it.
    logger.error(`[visit-closeout] payer invoice ${invoiceId} was emailed to AP but could not be finalized: ${err.message}`);
    return false;
  }
}

/**
 * Deliver the packet's payer-owned invoice to the payer, once. `payment` is the collector's `payer_billed` answer.
 * Returns the payment verdict to carry on: `payer_billed` (delivered, already delivered, or carried on the payer's
 * monthly statement), `payment_pending` (another runner holds the send, or the AP email went out but the finalize failed and is retried), or `office_required` (not delivered).
 */
async function deliverPacketInvoiceToPayer(packetId, payment, database = db) {
  const invoice = await database('invoices').where({ id: payment.invoiceId, visit_completion_packet_id: packetId }).first();
  if (!invoice || !invoice.payer_id) return officeVerdict(payment);
  // An invoice accrued to the payer's monthly statement is never emailed on its own; the statement carries it.
  if (invoice.payer_statement_id) return payment;
  const status = String(invoice.status || '').toLowerCase();
  if (DELIVERED_OR_TERMINAL.has(status) || invoice.email_sent_at) {
    // An accepted AP email whose finalize then failed: finalize again, never mail again.
    if (!DELIVERED_OR_TERMINAL.has(status) && !await finalizeDelivery(invoice.id)) {
      return { state: 'payment_pending', invoiceId: invoice.id };
    }
    return payment;
  }
  // Backfill closeouts skip the automatic payer send; the invoice stays for the office to review and send by hand.
  if (await packetIsBackfill(database, packetId)) return officeVerdict(payment);
  if (!await claimPayerDelivery(database, packetId, invoice.id)) return { state: 'payment_pending', invoiceId: invoice.id };
  try {
    const sent = await require('./invoice-email').sendInvoiceEmail(invoice.id);
    if (!sent?.ok) {
      logger.warn(`[visit-closeout] payer invoice ${invoice.id} not delivered to AP (${sent?.error || 'unknown'}); left unfinalized for the office`);
      return officeVerdict(payment);
    }
  } catch (err) {
    logger.error(`[visit-closeout] payer invoice AP send failed for ${invoice.id}: ${err.message}`);
    return officeVerdict(payment);
  }
  if (!await finalizeDelivery(invoice.id)) return { state: 'payment_pending', invoiceId: invoice.id };
  return payment;
}

module.exports = { deliverPacketInvoiceToPayer };
