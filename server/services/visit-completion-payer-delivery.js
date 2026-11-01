'use strict';

// GATE_PAYER_PACKET_AUTOSEND. A grouped closeout whose billed members all resolve to ONE active third-party payer
// mints a single invoice owned by that payer (visit-completion-invoice.js). The homeowner is never asked to pay it
// (no pay link in the summary text, no charge: visit-completion-payment.js answers `payer_billed`). This module is the
// packet twin of complete-scheduled-service.js `sendPayerInvoiceToApIfEligible`: it emails the invoice to the payer's
// AP inbox (InvoiceEmail reroutes a payer invoice there and refuses to fall back to the homeowner) and finalizes it
// with markDeliverySent, once. The packet's effects phase calls it on every run, so it is built to be re-entered.
//
// One sender at a time, through the invoice's OWN send claim (status 'sending' + send_claim_token, taken by
// claimInvoiceForSend, the claim the office Send in sendViaSMSAndEmail takes): an office send, the recovery sweep and
// a Resume tap all serialize on it. A claim someone else holds is pending (their outcome decides), never office review.
const db = require('../models/db');
const logger = require('./logger');

// Statuses that mean the invoice has already been delivered, or has left delivery for good.
const DELIVERED_OR_TERMINAL = new Set([
  'sent', 'viewed', 'overdue', 'paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled',
]);
const DELIVERY_SOURCE = 'dispatch_completion_payer';

function pending(invoiceId) {
  return { state: 'payment_pending', invoiceId };
}

// The payer invoice stays for the office: an unfinalized draft (the single-visit path's failed AP send), raised as
// the packet's existing payer office review. The homeowner is never texted or emailed in its place.
// The handoff is PERSISTED the way the other payer paths do it: the visit goes on billing hold, which the collector
// reads before it reaches the payer branch, so a Resume or the sweep never tries AP delivery again (and never reports
// a success beside the open alert) until the office releases the hold.
async function officeHandoff(database, packetId, payment) {
  await database('service_visits')
    .whereIn('id', database('visit_completion_packets').where({ id: packetId }).select('visit_id'))
    .update({ billing_hold: true, updated_at: database.fn.now() });
  return { state: 'office_required', reason: 'payer_assigned', payerId: payment.payerId || null, invoiceId: payment.invoiceId };
}

async function packetIsBackfill(database, packetId) {
  const { parseJsonObject } = require('./job-costing');
  const rows = await database('visit_completion_packet_items as i').join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packetId).select('r.structured_notes');
  return rows.some((row) => parseJsonObject(row.structured_notes).backfill);
}

// What a refused claim means for the packet. Another sender's live claim, or a delivery or void that landed since the
// read, is pending: the next run reads that outcome. A coded refusal (a parked ambiguous send, nothing due, a queued
// pay link) or a row that can no longer be claimed is the office's. Anything else (a failed read) retries on the sweep.
async function claimRefusal(database, invoiceId, err) {
  const current = await database('invoices').where({ id: invoiceId }).first('status', 'email_sent_at');
  const status = String(current?.status || '').toLowerCase();
  if (status === 'sending' || DELIVERED_OR_TERMINAL.has(status)) return 'pending';
  // Another runner's AP email was accepted between the read and this claim: the next run repeats only its finalize.
  if (err?.code === 'already_delivered') return current?.email_sent_at ? 'pending' : 'office';
  if (err?.code) return 'office';
  const { SEND_CLAIMABLE_STATUSES } = require('./invoice-helpers');
  return SEND_CLAIMABLE_STATUSES.includes(status) ? 'pending' : 'office';
}

// Take the invoice's send claim. A first delivery claims with firstDeliveryOnly, so the claim's own UPDATE refuses a
// row any sender has already delivered; a stamped draft (finalize only) claims to finalize under the same token.
async function takeSendClaim(database, invoice) {
  try {
    const claim = await require('./invoice').claimInvoiceForSend(invoice.id, { firstDeliveryOnly: !invoice.email_sent_at, database });
    return { claim };
  } catch (err) {
    logger.info(`[visit-closeout] payer invoice ${invoice.id} send claim not taken (${err.code || err.message})`);
    return { refusal: await claimRefusal(database, invoice.id, err) };
  }
}

// Give the claim back to the status it was taken from, as the office send does on a non-delivery. A failed give-back
// leaves the row 'sending'; stale-claim recovery then parks it for the office, and the next run reads that park.
async function releaseSendClaim(database, claim) {
  const released = await require('./invoice').restoreSendClaim(
    claim.invoice.id, claim.previousStatus, claim.claimed, claim.consumedQueuedSendRows || [], database, claim.invoice.send_claim_token,
  );
  if (!released) logger.error(`[visit-closeout] payer invoice ${claim.invoice.id} send claim could not be given back; left for stale-claim recovery`);
}

// The AP email under this runner's claim. True only when the provider accepted it (sendInvoiceEmail then stamps
// email_sent_at under the same token).
async function sendToAp(claim) {
  const invoiceId = claim.invoice.id;
  try {
    const sent = await require('./invoice-email').sendInvoiceEmail(invoiceId, { claimToken: claim.invoice.send_claim_token });
    if (sent?.ok) return true;
    logger.warn(`[visit-closeout] payer invoice ${invoiceId} not delivered to AP (${sent?.error || sent?.code || 'unknown'}); left unfinalized for the office`);
  } catch (err) {
    logger.error(`[visit-closeout] payer invoice AP send failed for ${invoiceId}: ${err.message}`);
  }
  return false;
}

// Finalize under the claim: markDeliverySent with the claim token requires and releases it in one UPDATE (the decline
// notice's pattern). True when the invoice is finalized. A failure is reported, never swallowed: the claim is given back,
// the caller keeps the packet on the recovery sweep, and the next run (email_sent_at is already stamped) repeats only this.
async function finalizeDelivery(database, claim) {
  const invoiceId = claim.invoice.id;
  try {
    const finalized = await require('./invoice').markDeliverySent(invoiceId, {
      email: true, source: DELIVERY_SOURCE, claimToken: claim.invoice.send_claim_token,
    });
    if (DELIVERED_OR_TERMINAL.has(String(finalized?.status || '').toLowerCase())) return true;
    logger.error(`[visit-closeout] payer invoice ${invoiceId} was emailed to AP but the finalize lost its claim`);
  } catch (err) {
    // AP already has the email (email_sent_at is stamped); a failed finalize must never re-send it.
    logger.error(`[visit-closeout] payer invoice ${invoiceId} was emailed to AP but could not be finalized: ${err.message}`);
  }
  await releaseSendClaim(database, claim);
  return false;
}

/**
 * Deliver the packet's payer-owned invoice to the payer, once. `payment` is the collector's `payer_billed` answer.
 * Returns the payment verdict to carry on: `payer_billed` (delivered, already delivered, or carried on the payer's
 * monthly statement), `payment_pending` (another sender holds the invoice's send claim, or the AP email went out but
 * the finalize failed and is retried), or `office_required` (not delivered; the visit is put on billing hold).
 */
async function deliverPacketInvoiceToPayer(packetId, payment, database = db) {
  const invoice = await database('invoices').where({ id: payment.invoiceId, visit_completion_packet_id: packetId }).first();
  if (!invoice || !invoice.payer_id) return officeHandoff(database, packetId, payment);
  // An invoice accrued to the payer's monthly statement is never emailed on its own; the statement carries it.
  if (invoice.payer_statement_id) return payment;
  const status = String(invoice.status || '').toLowerCase();
  if (DELIVERED_OR_TERMINAL.has(status)) return payment;
  // An office Send or another runner holds the send claim: its outcome decides. Never office review for this.
  if (status === 'sending') return pending(invoice.id);
  // Backfill closeouts skip the automatic payer send; the invoice stays for the office to review and send by hand.
  if (!invoice.email_sent_at && await packetIsBackfill(database, packetId)) return officeHandoff(database, packetId, payment);
  const { claim, refusal } = await takeSendClaim(database, invoice);
  if (refusal === 'office') return officeHandoff(database, packetId, payment);
  if (refusal) return pending(invoice.id);
  // Delivered by another sender between the read and the claim: nothing left to do here.
  if (DELIVERED_OR_TERMINAL.has(String(claim.previousStatus || '').toLowerCase())) {
    await releaseSendClaim(database, claim);
    return payment;
  }
  // An accepted AP email whose finalize then failed (email_sent_at stamped): finalize again, never mail again.
  if (!claim.invoice.email_sent_at && !await sendToAp(claim)) {
    // The hold is written before the claim is given back, so no runner can claim the draft before the handoff is durable.
    try {
      return await officeHandoff(database, packetId, payment);
    } finally {
      await releaseSendClaim(database, claim);
    }
  }
  return await finalizeDelivery(database, claim) ? payment : pending(invoice.id);
}

module.exports = { deliverPacketInvoiceToPayer };
