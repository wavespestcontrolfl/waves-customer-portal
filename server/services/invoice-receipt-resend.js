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
 * One operator send per invoice at a time: everything from the receipt-job claim to its
 * release runs under a Postgres advisory lock (receipt-send-lock.js, nothing persisted); a
 * second send meets 409 receipt_delivery_in_flight with no effects, and runs only after the
 * first has stamped receipt_sent_at and released.
 * `expect` (the IB tool; the route passes none): `{ approved, rederive }` — the
 * version the operator approved and a function that re-derives it. The writer
 * owns the final check: once it holds the claim (so no other operator send or
 * the drain can run on this invoice) and before the closeout or either leg, it
 * re-derives and refuses with 409 `receipt_approval_changed` on ANY difference
 * (receipt_sent_at, recipients, amount, linked visit, channels): no effect, the
 * claim handed back untouched. `rederive({ownClaimToken})` must ignore the
 * caller's own claim row.
 * Besides `{status, body}` the result carries what the caller must not guess:
 * `lockLost` / `stampWritten` (the send lock's session ended mid-send: which step found it,
 * and whether the stamp was written),
 * `closeout` (what the visit closeout ahead of the legs reported), `delivery`
 * (per-leg certainty, see smsDelivery / emailDelivery) and `queue` (what became
 * of the automatic receipt job, from releaseOperatorReceiptClaim) — never part
 * of the route's body.
 */
const db = require('../models/db');
const logger = require('./logger');
const { withReceiptSendLock } = require('./receipt-send-lock');

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
  return classifyDeliveryCertainty(err.providerOutcome);
}
const emailDelivery = (result) => (result?.ok ? 'sent' : result?.deliveryOutcome === 'uncertain' ? 'unknown' : 'not_sent');

// Re-read, just before each delivery leg, the approved facts that leg depends
// on. The send lock excludes other receipt sends, not contact or payment edits,
// and the closeout and the email leg both take time. The full approved version
// is not compared here: those steps have legitimately moved the rest (linked
// visit, job state).
const LEG_DRIFT = 'recipient or amount changed after approval';
async function legStillApproved(expect, claim, id) {
  try {
    const current = await expect.rederive({ ownClaimToken: claim.token || null });
    return Boolean(current)
      && current.recipients_key === expect.approved.recipients_key
      && current.amount === expect.approved.amount;
  } catch (err) {
    logger.warn(`[invoice-receipt-resend] text-leg re-check failed for ${id}: ${err.message}`);
    return false;
  }
}

async function sendInvoiceReceipt(invoiceId, { memo, via = 'both', actorTechnicianId = null, sawUnsent, holdUnknownOutcome = false, expect = null } = {}) {
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

  let emailResult = { ok: false, skipped: true };
  let smsResult = { ok: false, skipped: true };
  let smsThrown = null;
  let closeout = null;
  let refused = null;
  let queue = 'none';
  let lockLost = null; // the first step that found the send lock's session gone
  let stampWritten = null;
  const delivery = { email: 'not_requested', sms: 'not_requested' };

  // One operator send per invoice at a time (a Postgres advisory lock held on its own
  // connection for the whole send — see receipt-send-lock.js): claim, the re-check, the
  // closeout, both legs, the receipt_sent_at stamp and the claim release all run under it,
  // so a second send starts only after the first has stamped and released.
  const lock = await withReceiptSendLock(id, async (owner) => {
    // Ownership is checked before each effect: once the lock's session is gone another send
    // may hold the lock, so nothing further starts (the claim release below is cleanup of
    // our own claim, not a new effect, and still runs).
    const stillHeld = (step) => {
      if (owner.lost()) {
        lockLost = lockLost || step;
        return false;
      }
      return true;
    };
    if (!stillHeld('before_claim')) {
      return {
        early: {
          status: 409,
          body: { error: 'The send lock was lost before anything was sent — nothing was sent. Try again in a minute.', code: 'receipt_delivery_in_flight' },
        },
      };
    }
    // The invoice's queued receipt job (if any) is claimed before anything
    // else runs, so it cannot deliver a second receipt around this send.
    const claim = await claimReceiptJobForOperatorSend(id, { sawUnsent: sawUnsent ?? !invoice.receipt_sent_at });
    if (claim.inFlight) {
      return {
        early: {
          status: 409,
          body: {
            error: claim.byOperator
              ? 'Another receipt send for this invoice is in progress — refresh in a minute before resending.'
              : 'The automatic receipt for this invoice is being delivered right now — refresh in a minute before resending.',
            code: 'receipt_delivery_in_flight',
          },
        },
      };
    }
    if (claim.alreadySent) {
      return {
        early: {
          status: 409,
          body: {
            error: 'This receipt was already sent — refresh the page.',
            code: 'receipt_already_sent',
          },
        },
      };
    }

    try {
      // The final check, under the claim and ahead of every effect.
      if (expect) {
        let current = null;
        try {
          current = await expect.rederive({ ownClaimToken: claim.token || null });
        } catch (err) {
          logger.warn(`[invoice-receipt-resend] approved-state re-check failed for ${id}: ${err.message}`);
        }
        if (!current || JSON.stringify(current) !== JSON.stringify(expect.approved)) {
          refused = {
            status: 409,
            body: {
              error: 'What this receipt would do changed after it was approved (or could not be re-checked) — nothing was sent.',
              code: 'receipt_approval_changed',
            },
          };
        }
      }
      if (!refused) {
        // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark behind
        // GATE_INVOICE_ISSUED_CLOSES_VISIT): the operator's "resend receipt" is
        // the reachable retry for a payment-triggered closeout that did not
        // finish (pre-push P1). Runs once here, ahead of BOTH legs, so an
        // email-only resend retries too; a completed visit refuses quietly.
        if (stillHeld('before_closeout')) {
          const { closeOutVisitForIssuedInvoice } = require('./invoice-issued-closeout');
          closeout = await closeOutVisitForIssuedInvoice({ invoiceId: id, trigger: 'paid', actorTechnicianId });
        }

        if ((via === 'email' || via === 'both') && !stillHeld('before_email')) {
          emailResult = { ok: false, error: 'send lock lost' };
          delivery.email = 'not_sent';
        } else if ((via === 'email' || via === 'both') && expect && !(await legStillApproved(expect, claim, id))) {
          emailResult = { ok: false, error: LEG_DRIFT };
          delivery.email = 'not_sent';
        } else if (via === 'email' || via === 'both') {
          emailResult = await sendReceiptEmail(id, { memo: trimmedMemo }).catch((err) => ({ ok: false, error: err.message }));
          delivery.email = emailDelivery(emailResult);
          if (emailResult.ok) await recordOperatorReceiptDelivered(claim, 'email');
        }
        if ((via === 'sms' || via === 'both') && !stillHeld('before_text')) {
          smsResult = { ok: false, error: 'send lock lost' };
          delivery.sms = 'not_sent';
        } else if (expect && !(await legStillApproved(expect, claim, id))) {
          smsResult = { ok: false, error: LEG_DRIFT };
          delivery.sms = 'not_sent';
        } else if (via === 'sms' || via === 'both') {
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
          // A throw AFTER the provider accepted the text (its bookkeeping
          // failed) is a delivered receipt: record, stamp and release as sent,
          // or the "failure" invites a duplicate resend.
          if (delivery.sms === 'sent') smsResult = { ok: true };
          if (smsResult.ok) await recordOperatorReceiptDelivered(claim, 'sms');
        }

        // Stamp receipt metadata whenever at least one channel succeeded. If
        // both failed, leave receipt_sent_at NULL so the operator can retry.
        if ((emailResult.ok || smsResult.ok) && stillHeld('before_stamp')) {
          await db('invoices').where({ id }).update({
            receipt_sent_at: db.fn.now(),
            receipt_memo: trimmedMemo || null,
          });
          stampWritten = true;
        } else if (emailResult.ok || smsResult.ok) {
          stampWritten = false;
        }
      }
    } finally {
      const holdForReconciliation = holdUnknownOutcome && emailResult.ok !== true
        && (delivery.email === 'unknown' || delivery.sms === 'unknown');
      queue = await releaseOperatorReceiptClaim(claim, {
        emailDelivered: emailResult.ok === true, smsDelivered: smsResult.ok === true, smsResult, emailResult,
        ...(holdForReconciliation ? { holdForReconciliation } : {}),
      });
    }
    return {};
  });
  if (!lock.acquired) {
    return {
      status: 409,
      body: {
        error: lock.reason === 'unavailable'
          ? 'A receipt send could not start (the send lock is busy or unavailable) — nothing was sent; try again in a minute.'
          : 'Another receipt send for this invoice is in progress — refresh in a minute before resending.',
        code: 'receipt_delivery_in_flight',
      },
    };
  }
  if (lock.value.early) return lock.value.early;

  if (refused) return { ...refused, queue };

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
    queue,
    // The first step that found the send lock lost (its remaining steps were not started), and whether
    // the receipt_sent_at stamp was written (false: skipped for the same reason; null: nothing to stamp).
    lockLost,
    stampWritten,
  };
}

module.exports = { sendInvoiceReceipt };
