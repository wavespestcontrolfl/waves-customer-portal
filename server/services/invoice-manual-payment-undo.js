/**
 * Undo a manual (off-Stripe) invoice payment — the ONE writer, the counterpart of recordManualPayment
 * (invoice-manual-payment.js). Shared by POST /admin/invoices/:id/undo-payment and, later, an Intelligence Bar tool.
 *
 *   undoManualPayment(invoiceId, { reason, paymentId, undoneBy, undoneByTechnicianId })
 *     paymentId = the payment the caller was shown (describeManualPaymentUndo's payment.id); a different payment on the invoice now → 409
 *     → { invoice, payment: { id, amount, method }, remindersRearmed }
 *   describeManualPaymentUndo(invoiceId)
 *     → { eligible, code, message, payment } — the same rules, read without a lock, for the Invoices page
 *
 * Owner rule (2026-10-29): "Undo works on cash, check and Zelle entries on the same day, before any reminder or receipt goes
 * out." Every manual tender counts (cash, check, zelle, venmo, paypal, other). The Zelle reconciler's settlements
 * (`automated`) and Stripe payments are never undone here.
 *
 * What it works from: recordManualPayment writes a marker (audit_log, MANUAL_PAYMENT_RECORDED_ACTION) in the payment's own
 * transaction. It names the payments row that backs the payment, whether a person or the reconciler recorded it, and every
 * invoice column the paid flip overwrote. A payment recorded before the marker existed has none and is refused.
 *
 * A payment is undoable only after recordManualPayment wrote its completion marker (MANUAL_PAYMENT_EFFECTS_DONE_ACTION, the last thing it does,
 * after the reminder stop, pause clear, review ask, closeout and receipt). A crash or a lost marker leaves a payment un-undoable here.
 *
 * A PART payment (GATE_PARTIAL_PAYMENTS; the invoice stays open with invoices.amount_paid > 0) is undone by the same writer and the same
 * rules, from the marker with `partial: true`: it subtracts exactly that payment's amount from amount_paid (refused if it would go below 0),
 * cancels that payments row, restores the notes and recorded-at/by it overwrote, and re-arms nothing (a part payment stopped nothing).
 * It is refused once the customer opened a payment page for the remainder (a live session was priced for the smaller amount) or a payment
 * plan was set up. Undoing the FINAL payment of a part-paid invoice restores amount_paid from the marker (the paid flip reset it to 0).
 * Only the latest part can be undone: undoing it moves the invoice's edit time past the earlier part's payment, so that one is refused.
 *
 * Every rule runs again under the invoice row lock, in the order the payment writer locks (the per-customer combined-session
 * lock, the receipt-claim lock, then the invoice). The payment writer's effects and what Undo does about each:
 *   paid flip + operator note            reversed exactly from the marker
 *   payments row                         kept as history, status 'canceled' + the undo note (every revenue reader counts 'paid')
 *   follow-up sequence completed         re-armed after commit (resumeSequenceIfSystemResumable + scheduleForInvoice)
 *   payment-failed admin bells closed    reopened
 *   receipt (inline or queued)           refused when any exists; Undo and every receipt claim take the per-invoice claim lock
 *                                        (lockInvoiceReceiptClaim), and a claiming sender re-reads 'paid' under it (requirePaid)
 *   review ask enrolled                  refused when one exists
 *   visit closed out                     refused when one was
 *   billing pause auto-cleared           refused when it was
 *   annual prepay term activated         refused when the invoice is a term's prepay invoice
 *   payment plan completed               refused when the payment closed one
 *   retired Stripe session               not restorable; the pay page opens a new one on demand
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');
const { undoManualPaymentLive } = require('../config/feature-gates');
const { lockInvoiceReceiptClaim } = require('./receipt-delivery-queue');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('./invoice-helpers');
const {
  VALID_PAYMENT_METHODS, MANUAL_PAYMENT_RECORDED_ACTION, MANUAL_PAYMENT_EFFECTS_DONE_ACTION, PAID_FIELDS, PART_FIELDS, refusal,
} = require('./invoice-manual-payment');

const UNDO_NOTE_KEY = 'manualPaymentUndo';
const TOO_LATE = 'This payment can only be undone on the day it was recorded, before any receipt or reminder.';

// A send the messaging pipeline refused for good never left: no provider saw it and nothing waits to retry it (an opt-out, a
// suppression, no consent, a channel the customer turned off). Such a row does not block Undo. A hold that can still send later
// (quiet hours, a lookup that failed, an in-flight leg) and any row a provider saw still refuse.
const DEFINITIVE_NON_SEND_CODES = Object.freeze([
  'SMS_OPTED_OUT', 'PURPOSE_OPTED_OUT', 'EMAIL_OPTED_OUT', 'CONTACT_DECLINED',
  'SUPPRESSED_OPT_OUT', 'SUPPRESSED_WRONG_NUMBER', 'SUPPRESSED_NON_MOBILE', 'SUPPRESSED_MANUAL_DNC', 'SUPPRESSED_OTHER', 'DNC_SUPPRESSED',
  'NO_CONSENT_RECORD', 'NO_MARKETING_CONSENT', 'NON_MOBILE_SMS_RECIPIENT', 'REASSIGNED_NUMBER_RISK',
  'CHANNEL_NOT_SELECTED', 'CHANNEL_EMAIL_ONLY', 'IDENTITY_TRUST_TOO_LOW', 'MISSING_REQUIRED_IDS', 'EMOJI_FOR_CUSTOMER',
]);

// Things that must NOT have happened since the payment (:since) or must not exist at all. One row from the query = refused.
// Each probe names the side effect of recordManualPayment, or of what followed it, that Undo cannot take back.
const AFTER_PAYMENT_PROBES = [
  // The invoice's own receipt stamps (email, text), and a receipt queued for delivery that has not gone out yet.
  {
    code: 'receipt',
    message: TOO_LATE,
    sql: `SELECT 1 FROM invoices WHERE id = :invoiceId AND (receipt_sent_at IS NOT NULL OR receipt_sms_sent_at IS NOT NULL)
          UNION ALL SELECT 1 FROM receipt_delivery_jobs WHERE invoice_id = :invoiceId`,
  },
  // Every text or email about the invoice since the payment, except one the pipeline refused for good (DEFINITIVE_NON_SEND_CODES).
  {
    code: 'customer_message',
    message: TOO_LATE,
    sql: `SELECT 1 FROM messaging_audit_log WHERE invoice_id = CAST(:invoiceId AS text) AND created_at >= :since
            AND NOT (COALESCE(blocked_code, '') = ANY(CAST(:definitiveNonSendCodes AS text[])) AND provider IS NULL AND provider_message_id IS NULL AND sent_at IS NULL)`,
  },
  {
    code: 'review_ask',
    message: 'A review request was already started by this payment, so it cannot be undone here.',
    sql: `SELECT 1 FROM review_requests WHERE customer_id = :customerId AND created_at >= :since
          UNION ALL SELECT 1 FROM review_sequences WHERE customer_id = :customerId AND created_at >= :since`,
  },
  {
    code: 'visit_closed',
    message: 'This payment already closed out its visit, so it cannot be undone here.',
    sql: `SELECT 1 FROM audit_log WHERE created_at >= :since AND metadata->>'invoiceId' = CAST(:invoiceId AS text) AND metadata->>'trigger' = 'paid'
            AND (action = 'visit.completed_on_invoice_issued' OR (action = 'visit.completion_on_invoice_issued_refused' AND metadata->>'code' = 'error'))
          UNION ALL SELECT 1 FROM service_completion_attempts WHERE invoice_id = :invoiceId AND created_at >= :since`,
  },
  {
    code: 'billing_pause_cleared',
    message: 'This payment already cleared a billing pause on the customer, so it cannot be undone here.',
    sql: `SELECT 1 FROM audit_log WHERE action = 'customer.billing_pause_cleared' AND resource_id = :customerId AND created_at >= :since
            AND metadata->>'source' = 'admin_record_payment'`,
  },
  {
    code: 'later_payment',
    message: 'Another payment or credit was recorded on this invoice after this one, so it cannot be undone here.',
    // Only money after this payment: rows written later, whose status is not failed or canceled (a saved-card attempt that was declined
    // BEFORE the office recorded this payment carries the same description prefix but moved no money).
    sql: `SELECT 1 FROM payments WHERE customer_id = :customerId AND id <> :paymentId AND starts_with(description, :descriptionPrefix)
            AND created_at > :since AND status NOT IN ('failed', 'canceled')
          UNION ALL SELECT 1 FROM customer_credit_ledger WHERE invoice_id = :invoiceId AND created_at >= :since
          UNION ALL SELECT 1 FROM stripe_orphan_charges WHERE invoice_id = :invoiceId AND created_at >= :since`,
  },
  {
    code: 'synced',
    message: 'This payment was already sent to an ad or accounting system, so it cannot be undone here.',
    sql: `SELECT 1 FROM google_ads_conversion_uploads WHERE invoice_id = :invoiceId AND created_at >= :since
          UNION ALL SELECT 1 FROM meta_conversion_uploads WHERE invoice_id = :invoiceId AND created_at >= :since`,
  },
  {
    code: 'annual_prepay',
    message: 'This is an annual prepay invoice. Its term was activated by the payment, so it cannot be undone here.',
    sql: 'SELECT 1 FROM annual_prepay_terms WHERE prepay_invoice_id = :invoiceId',
  },
  {
    code: 'payment_plan',
    message: 'This payment closed a payment plan, so it cannot be undone here.',
    sql: "SELECT 1 FROM payment_plans WHERE invoice_id = :invoiceId AND status = 'completed' AND completed_at >= :since",
  },
  {
    code: 'reminders_paused',
    message: 'Reminders for this invoice were paused before the payment, so it cannot be undone here. Ask for help.',
    sql: 'SELECT 1 FROM invoice_followup_sequences WHERE invoice_id = :invoiceId AND (paused_reason IS NOT NULL OR paused_by_admin_id IS NOT NULL)',
  },
];

// Only for a part payment: a plan set up after it was sized from the remainder, which undoing would leave short.
const PART_PAYMENT_PLAN_PROBE = {
  code: 'payment_plan_active',
  message: 'A payment plan was set up for this invoice after the part payment, so it cannot be undone here.',
  sql: "SELECT 1 FROM payment_plans WHERE invoice_id = :invoiceId AND status = 'active'",
};

const ms = (value) => (value ? new Date(value).getTime() : null);

// The marker belonging to the payment now on the invoice: the one whose created_at is the same transaction instant as
// payment_recorded_at. An older marker (a payment already undone, or replaced) never matches. Newest first, a few deep: after the
// latest part of a part-paid invoice is undone, payment_recorded_at is the earlier part's instant again.
async function markerFor(conn, invoice) {
  const recorded = ms(invoice.payment_recorded_at);
  if (recorded == null) return null;
  const markers = await conn('audit_log')
    .where({ action: MANUAL_PAYMENT_RECORDED_ACTION, resource_type: 'invoices', resource_id: invoice.id })
    .orderBy('created_at', 'desc')
    .limit(10)
    .select('created_at', 'metadata');
  const match = markers.find((marker) => ms(marker.created_at) === recorded);
  return match ? match.metadata : null;
}

// Why this invoice's payment cannot be undone, or null. `conn` is the pool (describe) or the transaction holding the invoice lock
// (the writer). Returns { refusal: { code, message } | null, marker, payment }.
async function manualPaymentUndoRefusal(conn, invoice) {
  const notEligible = (code, message) => ({ refusal: { code, message }, marker: null, payment: null });
  const manualOnly = 'Only an invoice paid by cash, check, Zelle, Venmo, PayPal or another off-card tender recorded by the office can be undone.';
  // A part payment: the invoice is still open and holds money received (amount_paid). Anything else is the full-payment case.
  const isPart = invoice.status !== 'paid' && Number(invoice.amount_paid) > 0;
  if (isPart) {
    if (INVOICE_UNCOLLECTIBLE_STATUSES.includes(invoice.status) || invoice.stripe_charge_id || invoice.processor) {
      return notEligible('not_manual_paid', manualOnly);
    }
    // The remainder was priced for a payment page the customer opened after the part payment: undoing now would leave a session for less
    // than what is owed.
    if (invoice.stripe_payment_intent_id) {
      return notEligible('payment_session', 'The customer opened a payment page for this invoice after the part payment, so it cannot be undone here.');
    }
    // A saved-card charge for the rest that is submitted or unresolved keeps its own claim row even when a crash rolled the invoice
    // write back: if it settles after this Undo, the settle books the invoice paid without the part. Read only, never released here.
    try {
      await require('./stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, conn, { readOnly: true });
    } catch (err) {
      if (!['STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED'].includes(err.code)) throw err;
      return notEligible('card_charge_pending', 'A card charge for the rest of this invoice is still being settled, so the part payment cannot be undone now. Try again later.');
    }
  } else if (invoice.status !== 'paid' || !VALID_PAYMENT_METHODS.includes(invoice.payment_method)
    || invoice.stripe_payment_intent_id || invoice.stripe_charge_id || invoice.processor) {
    return notEligible('not_manual_paid', manualOnly);
  }
  const marker = await markerFor(conn, invoice);
  if (!marker || marker.automated || Boolean(marker.partial) !== isPart) return notEligible('not_recorded_by_office', manualOnly);
  // recordManualPayment releases its transaction before it stops reminders, clears a billing pause and enrolls a review. Until its
  // completion marker for THIS payment exists those effects may still be running, so a reversal now would be followed by them.
  const effectsDone = await conn('audit_log')
    .where({ action: MANUAL_PAYMENT_EFFECTS_DONE_ACTION, resource_type: 'invoices', resource_id: invoice.id })
    .whereRaw("metadata->>'paymentId' = ?", [String(marker.paymentId)])
    .first('id');
  if (!effectsDone) return notEligible('still_finishing', 'This payment is still finishing; try again in a minute.');
  const sinceMs = ms(invoice.payment_recorded_at);
  if (etDateString(new Date(sinceMs)) !== etDateString() || ms(invoice.updated_at) > sinceMs) {
    return notEligible('too_late', TOO_LATE);
  }
  // The ledger row the marker names: still paid, never refunded, an off-gateway row written by this same transaction.
  const payment = await conn('payments')
    .where({ id: marker.paymentId, customer_id: invoice.customer_id, status: 'paid' })
    .whereNull('processor').whereNull('stripe_payment_intent_id').whereNull('refunded_at')
    .whereRaw('COALESCE(refund_amount, 0) = 0')
    .first();
  if (!payment || ms(payment.created_at) !== sinceMs
    || (isPart && Math.round(Number(invoice.amount_paid) * 100) < Math.round(Number(payment.amount) * 100))) {
    return notEligible('payment_row', 'The payment record for this invoice changed after it was recorded, so it cannot be undone here.');
  }
  const bindings = {
    invoiceId: invoice.id,
    customerId: invoice.customer_id,
    paymentId: payment.id,
    since: new Date(sinceMs),
    descriptionPrefix: `Invoice ${invoice.invoice_number} — `,
    definitiveNonSendCodes: [...DEFINITIVE_NON_SEND_CODES],
  };
  for (const probe of isPart ? [...AFTER_PAYMENT_PROBES, PART_PAYMENT_PLAN_PROBE] : AFTER_PAYMENT_PROBES) {
    const { rows } = await conn.raw(probe.sql, bindings);
    if (rows.length) return notEligible(probe.code, probe.message);
  }
  return { refusal: null, marker, payment, isPart };
}

// The Invoices page asks this before it offers the action: the same rules the writer re-runs under the lock.
async function describeManualPaymentUndo(invoiceId) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) throw refusal(404, 'Invoice not found');
  const { refusal: refused, payment, marker, isPart } = await manualPaymentUndoRefusal(db, invoice);
  if (refused) return { eligible: false, ...refused };
  return {
    eligible: true,
    payment: {
      id: payment.id,
      amount: Number(payment.amount),
      method: isPart ? marker.method : invoice.payment_method,
      recordedAt: invoice.payment_recorded_at,
      part: isPart,
    },
  };
}

// Payment-failed admin bells the payment's settlement closed ("The invoice was paid"): the invoice is unpaid again, so they reopen. The
// closer's own link resolution picks them (payment-failed-allocation.js: payload.invoiceId, payload.allocationInvoiceIds, and
// payload.paymentIntentId through the ledger's metadata.invoice_id, which also covers legacy bells and combined allocations whose
// representative invoice is another one). Only a bell closed since the payment: one a person closed earlier keeps its earlier done_at
// (or a resolution of their own) and is left.
async function reopenPaymentFailedBells(trx, invoiceId, since) {
  const { RESOLUTION } = require('./payment-failed-alert-close');
  const { parseJson, failedAllocationInvoiceIds } = require('./payment-failed-allocation');
  const closed = await trx('notifications')
    .where({ recipient_type: 'admin', category: 'payment', done_by: 'payments', resolution: RESOLUTION })
    .whereRaw("metadata->>'triggerKey' = 'payment_failed'")
    .where('done_at', '>=', since)
    .select('id', 'metadata');
  const reopen = [];
  for (const bell of closed) {
    const { paymentIntentId, invoiceId: bellInvoiceId, allocationInvoiceIds } = parseJson(bell.metadata).payload || {};
    const allocation = await failedAllocationInvoiceIds(trx, { paymentIntentId, invoiceId: bellInvoiceId, allocationInvoiceIds });
    if (allocation.includes(String(invoiceId))) reopen.push(bell.id);
  }
  if (!reopen.length) return 0;
  return trx('notifications').whereIn('id', reopen).update({ done_at: null, done_by: null, resolution: null });
}

async function undoManualPayment(invoiceId, { reason, paymentId, undoneBy = 'admin', undoneByTechnicianId = null } = {}) {
  if (!undoManualPaymentLive()) throw refusal(403, 'Undo payment is not turned on');
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 400) : '';
  if (!cleanReason) throw refusal(400, 'A reason is required to undo a payment');
  if (!paymentId) throw refusal(400, 'The payment to undo is required');
  const unlocked = await db('invoices').where({ id: invoiceId }).first('id', 'customer_id');
  if (!unlocked) throw refusal(404, 'Invoice not found');

  const done = await db.transaction(async (trx) => {
    // The payment writer's lock order: the per-customer combined-session lock first (re-read until the owner is stable), then the invoice
    // (with the receipt-claim lock between them, below).
    await require('./pay-combined').lockCombinedCustomerStable(trx, invoiceId, unlocked.customer_id);
    // Then the receipt-claim lock: a sender claiming a receipt either committed before this point (the receipt probe below sees its claim row)
    // or waits here and re-reads the invoice after this commit (see lockInvoiceReceiptClaim in receipt-delivery-queue.js).
    await lockInvoiceReceiptClaim(trx, invoiceId);
    const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!locked) throw refusal(404, 'Invoice not found');
    const { refusal: refused, marker, payment, isPart } = await manualPaymentUndoRefusal(trx, locked);
    if (refused) throw refusal(409, refused.message, { code: refused.code });
    // The caller confirmed the payment it was shown. Another operator may have undone it and recorded a different one since.
    if (String(payment.id) !== String(paymentId)) {
      throw refusal(409, 'This invoice\'s payment changed since you opened this. Close and try again.', { code: 'payment_changed' });
    }

    const since = new Date(ms(locked.payment_recorded_at));
    const undone = {
      at: new Date().toISOString(), by: undoneBy, reason: cleanReason, method: isPart ? marker.method : locked.payment_method, amount: Number(payment.amount),
      ...(isPart ? { part: true } : {}),
    };
    let restored;
    if (isPart) {
      // Subtract exactly this payment from the money received; the status and the tender were never touched by the part.
      const remainingPaidCents = Math.round(Number(locked.amount_paid) * 100) - Math.round(Number(payment.amount) * 100);
      if (remainingPaidCents < 0) throw refusal(409, 'The payment record for this invoice changed after it was recorded, so it cannot be undone here.', { code: 'payment_row' });
      [restored] = await trx('invoices').where({ id: invoiceId, status: locked.status })
        .update({
          ...Object.fromEntries(PART_FIELDS.map((field) => [field, marker.previous?.[field] ?? null])),
          amount_paid: remainingPaidCents / 100,
          updated_at: trx.fn.now(),
        })
        .returning('*');
    } else {
      // A marker written before partial payments has no amount_paid: the column is NOT NULL and was 0.
      [restored] = await trx('invoices').where({ id: invoiceId, status: 'paid' })
        .update({
          ...Object.fromEntries(PAID_FIELDS.map((field) => [field, marker.previous?.[field] ?? (field === 'amount_paid' ? 0 : null)])),
          updated_at: trx.fn.now(),
        })
        .returning('*');
    }
    if (!restored) throw refusal(409, 'Invoice status changed before the payment could be undone');
    // History stays: the ledger row is kept as 'canceled' (the status Stripe-canceled payments already carry) with what happened.
    await trx('payments').where({ id: payment.id }).update({
      status: 'canceled',
      metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [UNDO_NOTE_KEY]: undone })]),
      updated_at: trx.fn.now(),
    });
    // A part payment closed no bell; the full payment's settlement did.
    if (!isPart) await reopenPaymentFailedBells(trx, invoiceId, since);
    await trx('activity_log').insert({
      customer_id: locked.customer_id,
      admin_user_id: undoneByTechnicianId,
      action: 'invoice_payment_undone',
      description: `${isPart ? 'Part payment' : 'Manual payment'} undone for ${locked.invoice_number} ($${undone.amount.toFixed(2)} via ${undone.method}) — ${undoneBy} — ${cleanReason.slice(0, 120)}`,
      metadata: JSON.stringify({ invoice_id: invoiceId, payment_id: payment.id, ...undone }),
    });
    await recordAuditEvent({
      actor_type: undoneByTechnicianId ? 'admin' : 'system',
      actor_id: undoneByTechnicianId,
      action: 'invoice.manual_payment_undone',
      resource_type: 'invoices',
      resource_id: invoiceId,
      metadata: { paymentId: payment.id, ...undone },
      critical: true,
      trx,
    });
    return { restored, payment, undone, isPart };
  });

  // Reminders resume on the normal schedule. After commit: resumeSequence reads the invoice and stops on a terminal one, so it must see
  // the restored status. A completed row re-arms at its stored step (a step already sent never fires again); an office stop stays stopped.
  // A part payment stopped nothing, so there is nothing to re-arm (remindersRearmed stays true: nothing is waiting).
  let remindersRearmed = true;
  if (!done.isPart) {
    try {
      const FollowUps = require('./invoice-followups');
      await FollowUps.resumeSequenceIfSystemResumable(invoiceId);
      await FollowUps.scheduleForInvoice(invoiceId);
    } catch (err) {
      remindersRearmed = false;
      logger.warn(`[invoice-manual-payment-undo] reminder re-arm failed for invoice ${invoiceId}: ${err.message}`);
    }
  }
  return {
    invoice: await db('invoices').where({ id: invoiceId }).first(),
    payment: { id: done.payment.id, amount: done.undone.amount, method: done.undone.method },
    remindersRearmed,
  };
}

module.exports = { undoManualPayment, describeManualPaymentUndo, manualPaymentUndoRefusal };
