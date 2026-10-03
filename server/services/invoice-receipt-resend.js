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
 */
const db = require('../models/db');
const logger = require('./logger');

async function sendInvoiceReceipt(invoiceId, { memo, via = 'both', actorTechnicianId = null, sawUnsent } = {}) {
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

  try {
    // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark behind
    // GATE_INVOICE_ISSUED_CLOSES_VISIT): the operator's "resend receipt" is
    // the reachable retry for a payment-triggered closeout that did not
    // finish (pre-push P1). Runs once here, ahead of BOTH legs, so an
    // email-only resend retries too; a completed visit refuses quietly.
    {
      const { closeOutVisitForIssuedInvoice } = require('./invoice-issued-closeout');
      await closeOutVisitForIssuedInvoice({ invoiceId: id, trigger: 'paid', actorTechnicianId });
    }

    if (via === 'email' || via === 'both') {
      emailResult = await sendReceiptEmail(id, { memo: trimmedMemo }).catch((err) => ({ ok: false, error: err.message }));
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
      }
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
    await releaseOperatorReceiptClaim(claim, { emailDelivered: emailResult.ok === true, smsDelivered: smsResult.ok === true, smsResult, emailResult });
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
  };
}

module.exports = { sendInvoiceReceipt };
