/**
 * Manual (off-Stripe) invoice settlement — the ONE path that marks an invoice
 * paid for cash / check / Zelle / Venmo / PayPal / other money that landed
 * outside the gateway. Extracted 1:1 from POST /admin/invoices/:id/record-
 * payment (2026-09-02) so a non-route caller — the Zelle payment-notice
 * reconciler — settles through exactly the same guards, transaction, ledger
 * row, side effects and receipt pipeline as the operator's Add-payment tap.
 *
 * Contract (unchanged from the route):
 *   recordManualPayment(invoiceId, { method, reference, note, recordedBy,
 *                                    sendReceipt = true, via = 'both',
 *                                    expectedAmountCents, requireSelfPay,
 *                                    automated })
 *     → { invoice, receipt }   receipt = { email, sms } | null
 *
 * expectedAmountCents (optional, the Zelle notice reconciler): the amount the
 * caller is settling FOR. Checked under the invoice row lock right before the
 * paid flip — if the amount due moved since the caller looked (an edit, a
 * credit), nothing is written and a 409 says so, so the ledger can never
 * record a different sum than the money that arrived.
 *
 * requireSelfPay (optional, both Zelle notice paths): the caller matched the
 * invoice as an OPEN SELF-PAY invoice (no payer, no statement, live payer
 * resolution empty) before calling. Re-run those predicates on the LOCKED row
 * inside the transaction — a concurrent payer reassignment between the
 * caller's check and the paid flip would otherwise settle another billing
 * party's invoice with the homeowner's transfer. Refuses with a 409 and
 * writes nothing.
 *
 * automated (optional, the Zelle reconciler's auto-settlement): nobody tapped
 * a button, so the receipt is NOT sent inline — a receipt_delivery_jobs row
 * is inserted IN the settlement transaction (the automatic receipt queue,
 * receipt-delivery-queue.js, is the one mechanism that honors
 * payment_receipt / email_enabled opt-outs, the SMS send window and the
 * retry ladder) and drained after commit. The job commits with the
 * payment or not at all. `receipt` then reads { queued: true }. Operator
 * paths leave it false and send inline.
 *
 * settlementFence (optional, both Zelle paths): async (db|trx) => boolean.
 * Run TWICE: on the pre-lock read before any Stripe session is retired (a
 * worker that no longer owns its claim must not destroy the customer's
 * checkout), and under the invoice row lock right before the paid flip on
 * the payment connection — there the callers SELECT … FOR UPDATE their
 * notice claim (id + status + claim_token) so the row stays locked through
 * the commit and a swept-and-RECLAIMED worker can never commit a second
 * invoice for one transfer. false → 409, nothing written.
 *
 * Refusals throw an Error carrying `statusCode` (400 / 404 / 409) and
 * `isOperational`; the lost-race 409 also carries `currentStatus`. Anything
 * else (DB outage, a sentinel thrown inside the transaction) is rethrown
 * untouched so the route surfaces it as a 500 exactly as before.
 *
 * Refuses to overwrite an already-paid invoice (use refund flow first) and
 * refuses to mark a void invoice paid. Stripe-paid invoices keep their
 * card_brand/card_last_four; manual payments leave those NULL so timeline
 * rendering can distinguish. Venmo and PayPal are named tenders (2026-08-29)
 * so revenue reports can tell them apart from 'other' — still off-gateway
 * settlements (no webhook, no Stripe object); recorded after the money lands.
 */
const db = require('../models/db');
const logger = require('./logger');
const InvoiceService = require('./invoice');
const PaymentPlans = require('./payment-plans');
const { guardOpenPaymentIntentForPrepaid } = require('./prepaid-pi-guard');
const { etDateString } = require('../utils/datetime-et');
const { assertInvoiceCollectible, INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue, visitRefusesSettlement, lockVisitForSettlement } = require('./invoice-helpers');

const VALID_PAYMENT_METHODS = ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'];
const VALID_RECEIPT_CHANNELS = ['email', 'sms', 'both'];

function refusal(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  Object.assign(err, extra);
  return err;
}

// ── Retire an open Stripe collection session before an off-Stripe settlement ──
// Once the invoice is paid/prepaid, assertInvoiceCollectible blocks NEW
// PaymentIntents / Terminal handoffs, but an already-minted PI (the pay page
// mints one on load) could still be confirmed from a still-open tab and
// charge the card a second time. The ONE mechanism for this is
// services/prepaid-pi-guard.js (also run by mark-prepaid in admin-schedule
// and the completion-side application in admin-dispatch — codex #3610 r6
// P1: no parallel retire logic here). This wrapper only maps its verdict to
// the { status, error } the routes send as-is; null means clear. Shared by
// apply-credit (route) and recordManualPayment.
async function retireOpenPaymentIntentBeforeSettlement(invoice, { action }) {
  const openPiId = invoice.stripe_payment_intent_id || null;
  if (!openPiId) return null;
  const verdict = await guardOpenPaymentIntentForPrepaid(invoice);
  if (verdict.ok) return null;
  if (verdict.reason === 'payment_in_flight') {
    return { status: 409, error: `A payment is already in flight (${verdict.piStatus}); wait for it to settle or refund it before ${action}` };
  }
  return { status: 409, error: `Open payment session ${openPiId} could not be verified (${verdict.detail || 'payment service unavailable'}); resolve it before ${action}` };
}

async function recordManualPayment(id, {
  method,
  reference,
  note,
  recordedBy = 'admin',
  sendReceipt = true,
  via = 'both',
  expectedAmountCents = null,
  requireSelfPay = false,
  automated = false,
  settlementFence = null,
} = {}) {
  if (expectedAmountCents != null && !(Number.isSafeInteger(expectedAmountCents) && expectedAmountCents > 0)) {
    throw refusal(400, 'expectedAmountCents must be a positive integer number of cents');
  }
  if (!method || !VALID_PAYMENT_METHODS.includes(method)) {
    throw refusal(400, `method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
  }
  if (sendReceipt && !VALID_RECEIPT_CHANNELS.includes(via)) {
    throw refusal(400, "via must be 'email', 'sms', or 'both'");
  }
  const trimmedReference = typeof reference === 'string' ? reference.trim().slice(0, 200) : '';
  const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';

  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw refusal(404, 'Invoice not found');
  // Phase 2: an accrued invoice is collected ONLY via its consolidated
  // statement — never mark an individual accrued invoice paid here (it would
  // settle once manually and again when the statement settles).
  if (invoice.payer_statement_id) {
    throw refusal(400, 'Invoice is billed on the payer’s monthly statement — record the payment against the statement, not the individual invoice');
  }
  // Terminal or in-flight invoices can never be manually marked paid.
  // This shares the same transition guard as Stripe collection paths.
  try {
    assertInvoiceCollectible(invoice.status);
  } catch (err) {
    throw refusal(invoice.status === 'processing' ? 409 : 400, err.message);
  }
  // Refuse to mark a $0 invoice paid — surfaces upstream creation bugs
  // instead of silently producing "$0.00 PAID" rows that misreport revenue.
  if (parseFloat(invoice.total || 0) <= 0) {
    throw refusal(400, 'Invoice has no amount to collect (total is $0)');
  }

  // Combined pay-page session release BEFORE accepting a manual payment
  // (codex #3427 r29 P0): this invoice may ride a combined PI a browser
  // can still confirm directly — recording cash/check now and letting
  // that capture land later double-charges the customer. Unconfirmed →
  // cancel + unstamp (fail closed); already canceled → finish the stamp
  // cleanup; anything in flight refuses (the collectible guard above
  // already blocks 'processing' invoices, this covers seam races).

  // Standalone pay-page PaymentIntent (codex #3610 P1): the combined-session
  // release inside the transaction below leaves a NON-combined PI untouched,
  // yet the pay page mints one on load and steers customers to Zelle beside
  // it. Cancel it before the paid flip so a still-open tab can't confirm it
  // after the transfer is recorded; refuse while money is in flight. Runs
  // pre-lock (Stripe call), same as apply-credit; the trx's collectible
  // guard covers the seam.
  // Zelle-caller predicates FIRST, on the pre-lock read: a stale or raced
  // automated match must refuse here, BEFORE the customer's live Stripe
  // session is retired below — never cancel a valid checkout for a
  // settlement that then records nothing. The under-lock re-checks below
  // remain the race fences.
  if (expectedAmountCents != null) {
    const actualCents = Math.round(invoiceAmountDue(invoice) * 100);
    if (actualCents !== expectedAmountCents) {
      throw refusal(409, `Invoice amount due is $${(actualCents / 100).toFixed(2)}, not the $${(expectedAmountCents / 100).toFixed(2)} being recorded — nothing was recorded`, { amountMismatch: { expectedCents: expectedAmountCents, actualCents } });
    }
  }
  if (requireSelfPay) {
    const { rowIsSelfPayDue } = require('./open-balance');
    if (invoice.payer_id || invoice.payer_statement_id || !(await rowIsSelfPayDue(invoice.customer_id, invoice))) {
      throw refusal(409, 'Invoice is no longer an open self-pay invoice (a payer or statement was assigned) — nothing was recorded');
    }
  }
  if (settlementFence && !(await settlementFence(db))) {
    throw refusal(409, 'The settlement claim was lost before the payment could be recorded (the notice was reclaimed) — nothing was recorded');
  }
  const triagedPiId = invoice.stripe_payment_intent_id || null;
  const openPi = await retireOpenPaymentIntentBeforeSettlement(invoice, { action: 'recording a manual payment' });
  if (openPi) throw refusal(openPi.status, openPi.error);

  // Append operator note to invoice notes (don't clobber existing notes).
  let nextNotes = invoice.notes || null;
  if (trimmedNote) {
    // ET wall-clock date (the one convention — utils/datetime-et), not UTC.
    const stamp = etDateString();
    const line = `[${stamp}] ${method.toUpperCase()}${trimmedReference ? ` ${trimmedReference}` : ''}: ${trimmedNote}`;
    nextNotes = nextNotes ? `${nextNotes}\n${line}` : line;
  }

  // Atomic transition. Two concurrent double-clicks both pass the
  // precheck above, but Postgres serializes UPDATEs against the same
  // row so only one of these statements actually changes anything;
  // the loser gets an empty .returning('*') and bails out before any
  // side effects (receipt send, activity row) run a second time.
  //
  // The payments-ledger insert rides the SAME transaction as the status
  // flip: the ledger row is load-bearing for every revenue rollup, and a
  // best-effort insert after commit left collected cash permanently
  // missing on a transient DB failure — with no alert and no sweep (the
  // dashboard gap-fallback only rescues Stripe-PI invoices). Either both
  // commit or the operator gets a retryable error and nothing changed.
  const updatedInvoice = await db.transaction(async (trx) => {
    // Combined-session reservation INSIDE the collection transaction
    // (codex #3427 r30 P0, serialized r31 P0): the helper takes the
    // per-customer combined lock, re-reads the invoice under it, and
    // releases any combined session — the lock holds through this
    // commit, so /setup cannot stamp a confirmable combined PI between
    // the check and the paid flip. Throws are 409-shaped; the caller
    // surfaces them.
    await require('./pay-combined').releaseCombinedSessionBeforeCollection(trx, invoice, { context: 'recording a manual payment' });
    // Seam re-check under the row lock (codex #3610 r2 P1, mirrors
    // apply-credit): /setup could have minted a NEW standalone PI between
    // the pre-lock triage above and this lock. The combined release only
    // handles combined PIs, so a fresh standalone stamp means a live client
    // secret we never retired — refuse; the operator retries and the new PI
    // gets triaged. A cleared stamp (null) is fine: nothing is live.
    const locked = await trx('invoices').where({ id }).forUpdate().first();
    if (!locked) return null;
    const lockedPiId = locked.stripe_payment_intent_id || null;
    if (lockedPiId && lockedPiId !== triagedPiId) return { racedNewPaymentIntent: lockedPiId };
    // Amount fence under the same lock as the paid flip: the caller settles
    // a specific sum; the ledger row below records invoiceAmountDue(row), so
    // the two must agree NOW, not when the caller last looked.
    if (expectedAmountCents != null) {
      const actualCents = Math.round(invoiceAmountDue(locked) * 100);
      if (actualCents !== expectedAmountCents) return { amountMismatch: { expectedCents: expectedAmountCents, actualCents } };
    }
    // Self-pay fence under the same lock: the row's own payer columns plus
    // the live payer re-resolution (rowIsSelfPayDue, fail-closed). A payer
    // assigned after the caller's eligibility check makes this refuse. The
    // resolution rides THIS trx: the Zelle callers hold their notice trx on
    // one connection and this trx on the other (DB_POOL_MAX floor is 2), so
    // a third acquire here would wait on itself.
    if (requireSelfPay) {
      // Lock the payer-SOURCE rows the resolution reads (customers.payer_id,
      // the visit's payer_id / self_pay_override) AND the payer rows they
      // point at (an inactive payer resolves as self-pay; a concurrent
      // re-activation must wait) so no reassignment can commit between this
      // read and the paid flip. Lock order: invoice → customer → visit → payer.
      // The visit lock is NOWAIT (Codex #3882 r4 P2): this is the first
      // visit acquisition on the self-pay path, so a blocking wait here
      // would recreate the invoice↔visit cycle the fence below avoids.
      const cust = await trx('customers').where({ id: locked.customer_id }).forUpdate().first('id', 'payer_id');
      const visit = locked.scheduled_service_id
        ? await lockVisitForSettlement(trx, locked.scheduled_service_id, ['id', 'payer_id'])
        : null;
      const payerIds = [...new Set([cust?.payer_id, visit?.payer_id].filter(Boolean))];
      if (payerIds.length) await trx('payers').whereIn('id', payerIds).orderBy('id', 'asc').forUpdate().select('id');
      const { rowIsSelfPayDue } = require('./open-balance');
      const selfPay = !locked.payer_id && !locked.payer_statement_id && await rowIsSelfPayDue(locked.customer_id, locked, { database: trx });
      if (!selfPay) return { notSelfPay: true };
    }
    // Visit fence under the same lock (after the invoice → customer → visit
    // → payer order above; the visit row is re-locked, never taken earlier):
    // an invoice whose visit is cancelled / no-show / skipped takes no
    // money. The cancel voids it post-commit; a payment that raced that
    // void would otherwise sit on a visit that never happens (#3878 r2).
    {
      const neverRan = await visitRefusesSettlement(trx, locked.scheduled_service_id);
      if (neverRan) return { visitNeverRan: neverRan };
    }
    if (settlementFence && !(await settlementFence(trx))) return { fenceLost: true };
    const [row] = await trx('invoices')
      .where({ id })
      .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
      .update({
        status: 'paid',
        paid_at: trx.fn.now(),
        payment_method: method,
        payment_reference: trimmedReference || null,
        payment_recorded_by: recordedBy,
        payment_recorded_at: trx.fn.now(),
        // The pay-page PI was retired above (or never existed) and this
        // invoice is settling OFF-gateway: drop the stamp and the stale
        // 'stripe' processor tag (codex #3610 r3 P1) — otherwise the tax
        // export's gap-revenue synthesis (admin-tax: paid + processor=stripe
        // + PI with no payments row) double-counts it beside the manual
        // ledger row inserted below. The ID was needed only for the locked
        // seam comparison, which already ran.
        stripe_payment_intent_id: null,
        processor: null,
        notes: nextNotes,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    if (!row) return null;

    // Payments-ledger row so revenue dashboards (admin-dashboard, monthly
    // reports) sum manual cash/check/Zelle alongside Stripe collections.
    // No `processor` set — that column is reserved for actual gateways
    // (`stripe`); leaving it null is the existing convention for off-
    // gateway money (see admin-payments-reconcile.js manual branch).
    const paymentRow = {
      customer_id: row.customer_id,
      // Record the CASH actually received — amount due (total − applied account
      // credit) — not the full total, or manual cash/check/Zelle over-states
      // revenue by the applied credit (which isn't cash).
      amount: invoiceAmountDue(row),
      status: 'paid',
      description: `Invoice ${row.invoice_number} — ${method}`
        + `${trimmedReference ? ` (${trimmedReference})` : ''}`,
      payment_date: etDateString(),
    };
    // Third-party Bill-To: link a payer-billed manual payment to its invoice so
    // the customer-facing billing history/balance can filter it out. Self-pay
    // rows normally stay unlinked to use the receipt-total fallback — BUT when
    // account credit was applied the recorded cash (amount due) differs from
    // invoice.total, so they MUST be linked or the receipt falls back to the
    // pre-credit total instead of the amount actually received.
    if (row.payer_id || Number(row.credit_applied) > 0) {
      paymentRow.metadata = JSON.stringify({
        invoice_id: row.id,
        // Payer ownership rides the ledger row itself: billing-cron's
        // pause veto and the webhook auto-clear both exclude payer-funded
        // money by metadata.payer_id — without this stamp a manually
        // recorded third-party payment would read as the homeowner's own
        // tender and veto a pause their dead card earned.
        ...(row.payer_id ? { payer_id: row.payer_id } : {}),
      });
    }
    await trx('payments').insert(paymentRow);
    // The invoice is settled — an active payment plan has nothing left to
    // collect. Complete it on the SAME trx so a paid invoice never keeps
    // an `active` plan that blocks edits / credit reversal.
    await PaymentPlans.completeActivePlansForInvoice(row.id, trx);
    if (sendReceipt && automated) {
      // Same transaction as the paid flip: the receipt job is durable the
      // moment the payment is. The customer sent the money themselves (a
      // Zelle transfer minutes ago), so the receipt is customer-initiated
      // for the send-window decision.
      await require('./receipt-delivery-queue').enqueueReceiptDelivery({ invoiceId: id, source: 'zelle_notice_reconciler', customerInitiated: true, database: trx });
    }
    return row;
  });

  if (updatedInvoice?.racedNewPaymentIntent) {
    throw refusal(409, 'A new payment session started for this invoice — retry recording the payment');
  }
  if (updatedInvoice?.amountMismatch) {
    const { expectedCents, actualCents } = updatedInvoice.amountMismatch;
    throw refusal(409, `Invoice amount due is $${(actualCents / 100).toFixed(2)}, not the $${(expectedCents / 100).toFixed(2)} being recorded — nothing was recorded`, { amountMismatch: updatedInvoice.amountMismatch });
  }
  if (updatedInvoice?.fenceLost) {
    throw refusal(409, 'The settlement claim was lost before the payment could be recorded (the notice was reclaimed) — nothing was recorded');
  }
  if (updatedInvoice?.visitNeverRan) {
    throw refusal(409, `This invoice's visit is ${updatedInvoice.visitNeverRan.replace('_', '-')} — nothing was recorded. Void or reissue the invoice, or record the money as account credit.`, { visitNeverRan: updatedInvoice.visitNeverRan });
  }
  if (updatedInvoice?.notSelfPay) {
    throw refusal(409, 'Invoice is no longer an open self-pay invoice (a payer or statement was assigned) — nothing was recorded');
  }
  if (!updatedInvoice) {
    // Lost the race to a concurrent caller (or another path marked it
    // paid in between). Re-fetch so the caller can return a useful 409 body.
    const current = await db('invoices').where({ id }).first();
    throw refusal(409, 'Invoice status changed before payment could be recorded', { currentStatus: current?.status });
  }

  // Stop the follow-up sequence the same way the Stripe webhook does.
  try {
    const FollowUps = require('./invoice-followups');
    await FollowUps.stopOnPayment(id);
  } catch (err) {
    logger.warn(`[admin-invoices:record-payment] stopOnPayment failed: ${err.message}`);
  }

  // The automatic-clear contract does not stop at Stripe: a check/cash/
  // Zelle payment recorded here is the customer paying, and the Customer
  // 360 banner promises the pause clears when a payment succeeds. NOT for
  // payer-funded rows — the payer's tender proves nothing about the
  // homeowner's card. The settlement moment is NOW (a human recorded
  // money they are holding). The helper owns every other rule (reason
  // gate, causality, locking); a failure logs — the operator who just
  // recorded the payment sees the banner still up and has the button.
  if (!updatedInvoice.payer_id) {
    try {
      const { maybeResumeBillingPauseOnPayment } = require('./billing-pause');
      await maybeResumeBillingPauseOnPayment(updatedInvoice.customer_id, {
        paymentIntentId: null,
        source: 'admin_record_payment',
        settledAt: new Date(),
      });
    } catch (pauseErr) {
      logger.warn(`[admin-invoices:record-payment] billing-pause auto-clear failed: ${pauseErr.message}`);
    }
  }

  // A completion invoice delivered unpaid deferred its review ask to
  // payment — an off-Stripe settlement (cash/check/Zelle) never reaches the
  // Stripe webhook, so trigger the same shared enrollment here (Codex P2,
  // PR #3104 r2). Guards (completion opt-out, visit outcome, dedupe,
  // cap/cooldown) all live in the helper; standalone invoices no-op.
  if (updatedInvoice.status === 'paid') {
    try {
      const ReviewService = require('./review-request');
      await ReviewService.enrollForPaidInvoice(updatedInvoice, { source: 'record_payment' });
    } catch (err) {
      logger.warn(`[admin-invoices:record-payment] review enrollment failed: ${err.message}`);
    }
  }

  // Fire-and-forget: a manually recorded payment (check/cash/Zelle) may
  // settle an invoice gating a payment-held WDO report — nudge the release
  // sweep (60s interval is the fallback).
  require('./project-report-hold').scheduleHoldReleaseSweep({ delayMs: 1500 });

  try {
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    await AnnualPrepayRenewals.syncTermForInvoicePayment(updatedInvoice);
  } catch (err) {
    logger.warn(`[admin-invoices:record-payment] annual prepay activation failed: ${err.message}`);
  }

  await db('activity_log').insert({
    customer_id: updatedInvoice.customer_id,
    action: 'invoice_payment_recorded',
    description: `Manual payment recorded for ${updatedInvoice.invoice_number}`
      + ` ($${invoiceAmountDue(updatedInvoice).toFixed(2)} via ${method}`
      + `${trimmedReference ? ` · ref ${trimmedReference}` : ''})`
      + ` — ${recordedBy}`,
  }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));

  // Optional inline receipt — same pipeline as /:id/send-receipt.
  let emailResult = null;
  let smsResult = null;
  let queued = false;
  if (sendReceipt && automated) {
    // The job row committed with the payment above; just nudge the drain.
    require('./receipt-delivery-queue').scheduleReceiptDeliveryDrain({ delayMs: 3000, limit: 5 });
    queued = true;
  } else if (sendReceipt) {
    const { sendReceiptEmail } = require('./invoice-email');
    const emailLeg = via === 'email' || via === 'both';
    if (emailLeg) {
      emailResult = await sendReceiptEmail(id).catch((err) => ({ ok: false, error: err.message }));
    }
    if (via === 'sms' || via === 'both') {
      try {
        const r = await InvoiceService.sendReceipt(id, { force: true, recordActivity: false, hasEmailLeg: emailLeg, operatorInitiated: true });
        smsResult = r?.sent ? { ok: true } : { ok: false, error: r?.reason || r?.code || 'not-sent' };
      } catch (err) {
        smsResult = { ok: false, error: err.message };
      }
    }
    if (emailResult?.ok || smsResult?.ok) {
      await db('invoices').where({ id }).update({ receipt_sent_at: db.fn.now() });
      await db('activity_log').insert({
        customer_id: updatedInvoice.customer_id,
        action: 'invoice_receipt_sent',
        description: `Receipt sent for invoice ${updatedInvoice.invoice_number}`
          + ` (${[emailResult?.ok && 'email', smsResult?.ok && 'sms'].filter(Boolean).join(' + ')})`
          + ' — auto after manual payment',
      }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));
    }
  }

  const final = await db('invoices').where({ id }).first();
  return {
    invoice: final,
    receipt: !sendReceipt ? null : queued ? { queued: true } : { email: emailResult, sms: smsResult },
  };
}

module.exports = {
  VALID_PAYMENT_METHODS,
  recordManualPayment,
  retireOpenPaymentIntentBeforeSettlement,
};
