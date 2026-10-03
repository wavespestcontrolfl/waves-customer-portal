/**
 * Operator-triggered receipt delivery for ONE paid invoice — the single writer
 * behind the Invoices page "Resend receipt" button (POST
 * /api/admin/invoices/:id/send-receipt) and the Intelligence Bar
 * `resend_receipt` tool. Returns `{ status, body }`: the HTTP shape the route
 * answers with, which the tool reads as its own outcome.
 *
 * Hits the branded email + the invoice_receipt SMS template, then stamps
 * invoices.receipt_sent_at so the UI can mark the service closed.
 * `via`: 'email' | 'sms' | 'both' (default 'both'); `memo` ≤400 chars.
 * `sawUnsent` (optional): the receipt state the caller's own card showed;
 * defaults to the live row's, as the route has always derived it.
 * `holdUnknownOutcome` (the IB tool; the route leaves it off): when a leg's
 * provider outcome is unknown and nothing was recorded delivered, the claimed
 * automatic receipt job is parked for reconciliation instead of handed back to
 * the drain, which would send again (see releaseOperatorReceiptClaim).
 * Besides `{status, body}` the result carries `closeout` (what the visit
 * closeout ahead of the legs reported) and `delivery` (per-leg certainty, see
 * smsDelivery / emailDelivery) — never part of the route's body.
 */
const db = require('../models/db');
const logger = require('./logger');

// Per leg: 'sent' | 'not_sent' | 'unknown' | 'not_requested' — from the senders'
// own structured evidence, never from message text.
//  - Text: the messaging layer's deliveryOutcome (accepted / not_sent /
//    uncertain, originating in twilio.js and carried by sendCustomerMessage),
//    which InvoiceService.sendReceipt puts on a thrown error as providerOutcome.
//    classifyDeliveryCertainty is the shared reader (the IB send_sms tools, the
//    dunning and briefing senders all use it). A throw without providerOutcome
//    came from sendReceipt's own pre-dispatch work: nothing was handed to Twilio.
//  - Email: sendReceiptEmail tags a post-handoff failure deliveryOutcome
//    'uncertain' (SendGrid handoff started, no definite rejection); every
//    other failure is a definite non-send.
function smsDelivery(result, err) {
  if (result?.sent) return 'sent';
  if (!err?.providerOutcome) return 'not_sent';
  const { classifyDeliveryCertainty } = require('./messaging/send-customer-message');
  return classifyDeliveryCertainty(err.providerOutcome) === 'unknown' ? 'unknown' : 'not_sent';
}
const emailDelivery = (result) => (result?.ok ? 'sent' : result?.deliveryOutcome === 'uncertain' ? 'unknown' : 'not_sent');

async function sendInvoiceReceipt(invoiceId, { memo, via = 'both', actorTechnicianId = null, sawUnsent, holdUnknownOutcome = false } = {}) {
  const id = invoiceId;
  if (!['email', 'sms', 'both'].includes(via)) {
    return { status: 400, body: { error: "via must be 'email', 'sms', or 'both'" } };
  }
  const trimmedMemo = typeof memo === 'string' ? memo.trim().slice(0, 400) : '';

  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) return { status: 404, body: { error: 'Invoice not found' } };
  if (invoice.status !== 'paid') {
    return { status: 400, body: { error: 'Invoice is not paid — receipt can only be sent for paid invoices' } };
  }

  const InvoiceService = require('./invoice');
  const { sendReceiptEmail } = require('./invoice-email');
  const { claimReceiptJobForOperatorSend, recordOperatorReceiptDelivered, releaseOperatorReceiptClaim } = require('./receipt-delivery-queue');

  // The invoice's queued receipt job (if any) is claimed before anything
  // else runs, so it cannot deliver a second receipt around this send.
  const claim = await claimReceiptJobForOperatorSend(id, { sawUnsent: sawUnsent ?? !invoice.receipt_sent_at });
  if (claim.inFlight) {
    return {
      status: 409,
      body: {
        error: 'The automatic receipt for this invoice is being delivered right now — refresh in a minute before resending.',
        code: 'receipt_delivery_in_flight',
      },
    };
  }
  if (claim.alreadySent) {
    return {
      status: 409,
      body: {
        error: 'This receipt was already sent — refresh the page.',
        code: 'receipt_already_sent',
      },
    };
  }

  let emailResult = { ok: false, skipped: true };
  let smsResult = { ok: false, skipped: true };
  let smsThrown = null;
  let closeout = null;
  const delivery = { email: 'not_requested', sms: 'not_requested' };

  try {
    // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark behind
    // GATE_INVOICE_ISSUED_CLOSES_VISIT): the operator's "resend receipt" is
    // the reachable retry for a payment-triggered closeout that did not
    // finish (pre-push P1). Runs once here, ahead of BOTH legs, so an
    // email-only resend retries too; a completed visit refuses quietly.
    {
      const { closeOutVisitForIssuedInvoice } = require('./invoice-issued-closeout');
      closeout = await closeOutVisitForIssuedInvoice({ invoiceId: id, trigger: 'paid', actorTechnicianId });
    }

    if (via === 'email' || via === 'both') {
      emailResult = await sendReceiptEmail(id, { memo: trimmedMemo }).catch((err) => ({ ok: false, error: err.message }));
      delivery.email = emailDelivery(emailResult);
      if (emailResult.ok) await recordOperatorReceiptDelivered(claim, 'email');
    }
    if (via === 'sms' || via === 'both') {
      // Manual operator resend — pass force:true to override the auto-send
      // idempotency guard (otherwise re-clicking SEND RECEIPT would no-op
      // for invoices already auto-receipted by the Stripe webhook).
      // recordActivity:false because this function writes its own activity_log
      // row below with the memo and channel mix.
      try {
        const r = await InvoiceService.sendReceipt(id, { force: true, recordActivity: false, hasEmailLeg: via === 'both', operatorInitiated: true });
        smsResult = r?.sent ? { ok: true } : { ok: false, error: r?.reason || r?.code || 'not-sent' };
      } catch (err) {
        smsResult = { ok: false, error: err.message };
        smsThrown = err;
      }
      delivery.sms = smsDelivery(smsResult.ok ? { sent: true } : null, smsThrown);
      if (smsResult.ok) await recordOperatorReceiptDelivered(claim, 'sms');
    }

    // Stamp receipt metadata whenever at least one channel succeeded. If
    // both failed, leave receipt_sent_at NULL so the operator can retry.
    if (emailResult.ok || smsResult.ok) {
      await db('invoices').where({ id }).update({
        receipt_sent_at: db.fn.now(),
        receipt_memo: trimmedMemo || null,
      });
    }
  } finally {
    const holdForReconciliation = holdUnknownOutcome && emailResult.ok !== true
      && (delivery.email === 'unknown' || delivery.sms === 'unknown');
    await releaseOperatorReceiptClaim(claim, {
      emailDelivered: emailResult.ok === true, smsDelivered: smsResult.ok === true, smsResult, emailResult,
      ...(holdForReconciliation ? { holdForReconciliation } : {}),
    });
  }

  if (emailResult.ok || smsResult.ok) {
    await db('activity_log').insert({
      customer_id: invoice.customer_id,
      action: 'invoice_receipt_sent',
      description: `Receipt sent for invoice ${invoice.invoice_number}`
        + ` (${[emailResult.ok && 'email', smsResult.ok && 'sms'].filter(Boolean).join(' + ')})`
        + (trimmedMemo ? ` — memo: ${trimmedMemo.slice(0, 80)}${trimmedMemo.length > 80 ? '…' : ''}` : ''),
    }).catch((err) => logger.warn(`[admin-invoices] activity_log insert failed: ${err.message}`));
  }

  const updated = await db('invoices').where({ id }).first();
  return {
    status: 200,
    body: {
      ok: emailResult.ok || smsResult.ok,
      email: emailResult,
      sms: smsResult,
      invoice: updated,
    },
    closeout,
    delivery,
  };
}

module.exports = { sendInvoiceReceipt };
