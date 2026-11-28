const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { auditPaymentReconcile, ipFromReq, uaFromReq } = require('../services/audit-log');
const {
  assertInvoiceCollectible,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  invoiceAmountDue,
  neverRanVisitStatus,
  lockVisitForSettlement,
} = require('../services/invoice-helpers');
const { computeChargeAmount } = require('../services/stripe-pricing');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

router.use(adminAuthenticate, requireAdmin);

// Per-admin rate limit on /recent-charges. Each call hits Stripe's
// charges.list endpoint with limit=40 — admin clicking refresh
// repeatedly burns the per-account API quota that the rest of the
// portal shares (webhook reads, autopay charges, refunds). 30/min
// per tech is generous for legitimate UI use, well under the cap.
const recentChargesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tech_${req.technicianId || req.ip}`,
  message: { error: 'Too many recent-charges requests. Try again in a minute.' },
});

/**
 * Stripe Tap to Pay — Path A reconciliation
 *
 * Tech collects payment via the native Stripe Terminal iOS app (off-platform),
 * then admin reconciles by marking the portal invoice paid + attaching the
 * Stripe charge id so revenue reporting, receipts, and autopay state stay in sync.
 */

// Mirror of the /reconcile validity guards: refunded, disputed, and non-USD
// charges are unreconcilable there, so offering them in the picker only
// produces guaranteed 400s — and Stripe keeps refunded charges in status
// 'succeeded', so the status check alone doesn't exclude them. Also keeps
// dead entries from crowding valid ones out of the 20-slot list.
function chargeIsReconcilable(charge) {
  return charge.status === 'succeeded'
    && charge.captured !== false
    && !(charge.amount_captured != null && Number(charge.amount_captured) <= 0)
    && !charge.refunded
    && !(Number(charge.amount_refunded) > 0)
    && !charge.disputed
    && String(charge.currency || '').toLowerCase() === 'usd';
}

// GET /recent-charges — last 20 Stripe charges not yet linked to an invoice
router.get('/recent-charges', recentChargesLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const charges = await stripe.charges.list({ limit: 40 });
    const chargeIds = charges.data.map(c => c.id).filter(Boolean);
    const linked = await db('invoices')
      .whereIn('stripe_charge_id', chargeIds)
      .select('stripe_charge_id');
    // Also exclude charges already booked in the payments LEDGER: on-platform
    // charges (webhook, saved-card, pay page) book a payments row, sometimes
    // without stamping invoices.stripe_charge_id. Offering one of those here
    // wastes a result slot on a charge the /reconcile guard below is
    // guaranteed to 409 — only reconcilable entries should be returned.
    const booked = await db('payments')
      .whereIn('stripe_charge_id', chargeIds)
      .select('stripe_charge_id');
    const linkedSet = new Set([...linked, ...booked].map(r => r.stripe_charge_id));

    const unlinked = charges.data
      .filter(c => chargeIsReconcilable(c) && !linkedSet.has(c.id))
      .slice(0, 20)
      .map(c => ({
        id: c.id,
        amount: Number(c.amount_captured ?? c.amount) / 100,
        currency: c.currency,
        created: new Date(c.created * 1000).toISOString(),
        payment_method_type: c.payment_method_details?.type,
        card_brand: c.payment_method_details?.card_present?.brand || c.payment_method_details?.card?.brand || null,
        last4: c.payment_method_details?.card_present?.last4 || c.payment_method_details?.card?.last4 || null,
        receipt_url: c.receipt_url,
        description: c.description,
      }));

    res.json({ charges: unlinked });
  } catch (err) { next(err); }
});

function payerRefusalForInvoice(invoice) {
  if (invoice.payer_id) {
    return 'Invoice is billed to a third-party payer — do not collect or reconcile it against the service recipient';
  }
  if (invoice.payer_statement_id) {
    return 'Invoice is billed on the payer’s monthly statement — reconcile against the statement, not the individual invoice';
  }
  return null;
}

async function verifyChargeCustomerOwner(invoice, chargeDetails) {
  const chargeWavesCustomerId = chargeDetails.metadata?.waves_customer_id;
  if (chargeWavesCustomerId && String(chargeWavesCustomerId) !== String(invoice.customer_id)) {
    return { status: 400, error: 'Charge belongs to a different customer than this invoice' };
  }
  const chargeStripeCustomer = typeof chargeDetails.customer === 'string'
    ? chargeDetails.customer
    : chargeDetails.customer?.id || null;
  if (!chargeStripeCustomer) return null;
  const owner = await db('customers').where({ stripe_customer_id: chargeStripeCustomer }).first('id');
  if (!owner) {
    return { status: 400, error: `Charge's Stripe customer (${chargeStripeCustomer}) is not linked to any portal customer — cannot verify ownership, so it cannot be reconciled` };
  }
  if (String(owner.id) !== String(invoice.customer_id)) {
    return { status: 400, error: 'Charge belongs to a different customer than this invoice' };
  }
  return null;
}

async function verifyStripeChargeForReconcile(invoice, stripeChargeId) {
  if (!stripe) return { refusal: { status: 503, error: 'Stripe not configured' } };
  let chargeDetails;
  try {
    // balance_transaction is created when the charge SUCCEEDS — for async
    // methods (ACH) that is settlement, not initiation, so its timestamp is
    // the authoritative settlement moment billing-pause compares against.
    chargeDetails = await stripe.charges.retrieve(stripeChargeId, { expand: ['balance_transaction'] });
  } catch (e) {
    return { refusal: { status: 400, error: `Stripe charge lookup failed: ${e.message}` } };
  }
  if (chargeDetails.status !== 'succeeded') {
    return { refusal: { status: 400, error: `Charge is ${chargeDetails.status}, not succeeded` } };
  }
  if (chargeDetails.captured === false || (chargeDetails.amount_captured != null && Number(chargeDetails.amount_captured) <= 0)) {
    return { refusal: { status: 400, error: 'Charge is authorized but not captured — capture the funds in Stripe before reconciling' } };
  }
  if (chargeDetails.refunded || Number(chargeDetails.amount_refunded) > 0 || chargeDetails.disputed) {
    return { refusal: { status: 400, error: 'Charge has been refunded or disputed — it cannot be reconciled against an invoice' } };
  }
  if (String(chargeDetails.currency || '').toLowerCase() !== 'usd') {
    return { refusal: { status: 400, error: `Charge currency is ${String(chargeDetails.currency || 'unknown').toUpperCase()} — only USD charges can be reconciled` } };
  }

  const chargeAmtCents = Math.round(Number(chargeDetails.amount_captured ?? chargeDetails.amount));
  const amountDue = invoiceAmountDue(invoice);
  const surcharged = computeChargeAmount(amountDue, 'card', { funding: 'credit' });
  if (surcharged.surchargeCents > 0 && Math.abs(chargeAmtCents - surcharged.totalCents) <= 1) {
    return {
      refusal: {
        status: 400,
        error: `This charge includes a $${(surcharged.surchargeCents / 100).toFixed(2)} card surcharge. Surcharged charges are recorded through the normal payment flow with their surcharge breakdown — only non-surcharged charges can be reconciled here.`,
      },
    };
  }
  const chargeAmt = chargeAmtCents / 100;
  if (Math.abs(chargeAmt - amountDue) > 1) {
    return {
      refusal: {
        status: 400,
        error: `Amount mismatch — charge is $${chargeAmt.toFixed(2)} but invoice amount due is $${amountDue.toFixed(2)}`,
      },
    };
  }

  const ownerRefusal = await verifyChargeCustomerOwner(invoice, chargeDetails);
  if (ownerRefusal) return { refusal: ownerRefusal };
  return { chargeDetails };
}

async function verifySelfPayAndVisitUnderLock(trx, lockedInvoice, lockedCust) {
  // Caller already holds customers FOR UPDATE -> invoices FOR UPDATE (matching
  // apply-credit lock order to avoid ABBA deadlocks). Lock visit -> payers next.
  const visit = lockedInvoice.scheduled_service_id
    ? await lockVisitForSettlement(trx, lockedInvoice.scheduled_service_id, ['id', 'status', 'payer_id'])
    : null;
  const neverRan = neverRanVisitStatus(visit?.status);
  if (neverRan) {
    return `This invoice's visit is ${neverRan.replace('_', '-')} — nothing was reconciled. Void or reissue the invoice first.`;
  }
  const payerIds = [...new Set([lockedCust?.payer_id, visit?.payer_id].filter(Boolean))];
  if (payerIds.length) await trx('payers').whereIn('id', payerIds).orderBy('id', 'asc').forUpdate().select('id');
  const resolved = await require('../services/payer').resolveForInvoice({
    database: trx,
    customerId: lockedInvoice.customer_id,
    customer: lockedCust || null,
    scheduledServiceId: lockedInvoice.scheduled_service_id || null,
    throwOnError: true,
  });
  if (resolved?.payerId) {
    return 'Invoice is billed to a third-party payer — do not collect or reconcile it against the service recipient';
  }
  return null;
}

async function checkReconcileFencesInLock(trx, { invoiceId, invoice, triagedPiId, chargePiId }) {
  // Acquire customers FOR UPDATE BEFORE invoices FOR UPDATE (matches apply-credit
  // lock order so concurrent reconcile + apply-credit cannot ABBA deadlock).
  const lockedCust = invoice.customer_id
    ? await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id', 'payer_id')
    : null;
  const lockedInvoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
  if (!lockedInvoice) return { updated: 0 };
  if (lockedInvoice.customer_id && String(lockedInvoice.customer_id) !== String(invoice.customer_id || '')) {
    return { conflict: 'Invoice customer changed while reconciling — reload it and reconcile again' };
  }

  const lockedPiId = lockedInvoice.stripe_payment_intent_id || null;
  if (lockedPiId && lockedPiId !== triagedPiId && lockedPiId !== chargePiId) {
    return { conflict: 'A new payment session started for this invoice — retry reconciling the payment' };
  }
  const payerRefusal = payerRefusalForInvoice(lockedInvoice);
  if (payerRefusal) return { conflict: payerRefusal };
  try {
    assertInvoiceCollectible(lockedInvoice);
  } catch (e) {
    return { conflict: e.message };
  }
  // Saved-card claim fence (mirrors recordManualPayment / apply-credit):
  // refuse while an in-progress/ambiguous/orphan saved-card charge exists.
  try {
    await require('../services/stripe').assertNoInvoiceChargeReconciliationPending(invoiceId, trx);
  } catch (fenceErr) {
    if (['STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED'].includes(fenceErr.code)) {
      return { conflict: `${fenceErr.message} — resolve it before reconciling` };
    }
    throw fenceErr;
  }

  const visitOrPayerConflict = await verifySelfPayAndVisitUnderLock(trx, lockedInvoice, lockedCust);
  if (visitOrPayerConflict) return { conflict: visitOrPayerConflict };

  const lockedOwedCents = Math.round(invoiceAmountDue(lockedInvoice) * 100);
  if (lockedOwedCents !== Math.round(invoiceAmountDue(invoice) * 100)) {
    return { conflict: `The amount owed on this invoice changed to $${(lockedOwedCents / 100).toFixed(2)} while it was being reconciled. Reload it and reconcile again. Nothing was recorded.` };
  }
  return { lockedInvoice };
}

function buildReconcilePaymentRecord(invoice, { invoiceId, collectedVia, collectedAmount, stripeChargeId, chargeDetails }) {
  const settledEpoch = stripeChargeId
    ? (chargeDetails?.balance_transaction?.created || chargeDetails?.created || null)
    : null;
  return {
    customer_id: invoice.customer_id,
    amount: collectedAmount,
    status: 'paid',
    description: `Invoice ${invoice.invoice_number} — ${collectedVia}`,
    payment_date: etDateString(),
    stripe_charge_id: stripeChargeId || null,
    processor: stripeChargeId ? 'stripe' : null,
    metadata: JSON.stringify({
      invoice_id: invoiceId,
      source: 'admin_payment_reconcile',
      ...(settledEpoch ? { settled_event_at: new Date(settledEpoch * 1000).toISOString() } : {}),
      ...(invoice.payer_id ? { payer_id: invoice.payer_id } : {}),
    }),
  };
}

async function runPostReconcileSideEffects(invoice, { invoiceId, chargeDetails, technicianId }) {
  try {
    await require('../services/invoice-followups').stopOnPayment(invoiceId);
  } catch (followUpErr) {
    logger.warn(`[reconcile] stopOnPayment failed: ${followUpErr.message}`);
  }

  try {
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    await AnnualPrepayRenewals.syncTermForInvoicePayment({ id: invoiceId, status: 'paid', paid_at: new Date() });
  } catch (e) {
    logger.warn(`[reconcile] annual prepay activation skipped: ${e.message}`);
  }

  if (!invoice.payer_id) {
    try {
      const { maybeResumeBillingPauseOnPayment } = require('../services/billing-pause');
      const settledEpoch = chargeDetails?.balance_transaction?.created || chargeDetails?.created || null;
      await maybeResumeBillingPauseOnPayment(invoice.customer_id, {
        paymentIntentId: chargeDetails?.payment_intent || null,
        source: 'admin_payment_reconcile',
        settledAt: settledEpoch ? new Date(settledEpoch * 1000) : new Date(),
      });
    } catch (pauseErr) {
      logger.warn(`[reconcile] billing-pause auto-clear failed: ${pauseErr.message}`);
    }
  }

  const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');
  await closeOutVisitForIssuedInvoice({ invoiceId, trigger: 'paid', actorTechnicianId: technicianId || null });

  let reviewUnrecordedWarning = null;
  try {
    const settled = await db('invoices').where({ id: invoiceId }).first('id', 'invoice_number', 'customer_id', 'service_record_id', 'visit_completion_packet_id');
    if (settled) {
      const outcome = await require('../services/review-request').enrollForPaidInvoice(settled, { source: 'payments_reconcile' });
      if (outcome && outcome.recorded === false) {
        logger.error(`[reconcile] invoice ${settled.invoice_number || invoiceId} settled with an UNRECORDED review enrollment — the packet recovery sweep owns it`);
        const alerted = await require('../services/dispatch-alerts').createAlert({
          type: 'visit_closeout_review',
          severity: 'warn',
          payload: {
            reason: 'review_enrollment_unrecorded',
            source: 'payments_reconcile',
            invoiceIds: [invoiceId],
            detail: 'This settled invoice owes a review ask that could not be recorded — re-run the enrollment or ask manually.',
          },
        }).catch((alertErr) => {
          logger.error(`[reconcile] could not raise the unrecorded-enrollment alert: ${alertErr.message}`);
          return null;
        });
        if (!alerted) reviewUnrecordedWarning = invoiceId;
      }
    }
  } catch (enrollErr) {
    logger.error(`[reconcile] review enrollment failed for invoice ${invoiceId}: ${enrollErr.message}`);
  }
  return reviewUnrecordedWarning;
}

/**
 * POST /reconcile
 * Body: { invoiceId, stripeChargeId?, collectedVia, amount?, note? }
 *
 * If stripeChargeId is provided, the endpoint verifies the charge with Stripe
 * and pulls receipt/card details automatically. Otherwise it records a
 * manual reconciliation (cash/check/off-platform).
 */
router.post('/reconcile', requireAdmin, async (req, res, next) => {
  try {
    const { invoiceId, stripeChargeId, collectedVia, amount, note } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
    if (!collectedVia) return res.status(400).json({ error: 'collectedVia required' });
    if (amount != null && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const prePayerRefusal = payerRefusalForInvoice(invoice);
    if (prePayerRefusal) return res.status(400).json({ error: prePayerRefusal });
    try {
      assertInvoiceCollectible(invoice);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const updates = {
      status: 'paid',
      amount_paid: 0,
      paid_at: new Date(),
      collected_via: collectedVia,
      reconciled_by: req.technicianId || null,
      reconciled_at: new Date(),
      notes: note ? `${invoice.notes || ''}\n[reconciliation] ${note}`.trim() : invoice.notes,
      updated_at: new Date(),
    };

    let chargeDetails = null;
    if (stripeChargeId) {
      const verified = await verifyStripeChargeForReconcile(invoice, stripeChargeId);
      if (verified.refusal) return res.status(verified.refusal.status).json({ error: verified.refusal.error });
      chargeDetails = verified.chargeDetails;
      updates.stripe_charge_id = stripeChargeId;
      updates.payment_method = chargeDetails.payment_method_details?.type || null;
      updates.card_brand = chargeDetails.payment_method_details?.card_present?.brand
        || chargeDetails.payment_method_details?.card?.brand || null;
      updates.card_last_four = chargeDetails.payment_method_details?.card_present?.last4
        || chargeDetails.payment_method_details?.card?.last4 || null;
      updates.receipt_url = chargeDetails.receipt_url || null;
    } else if (amount != null) {
      const invoiceTotal = invoiceAmountDue(invoice);
      if (Math.abs(Number(amount) - invoiceTotal) > 1) {
        return res.status(400).json({
          error: `Amount mismatch — collected $${Number(amount).toFixed(2)} but invoice is $${invoiceTotal.toFixed(2)}. Edit the invoice total first if it changed.`,
        });
      }
      updates.payment_method = collectedVia;
    }

    if (!stripeChargeId) {
      updates.stripe_payment_intent_id = null;
      updates.processor = null;
    }

    // Retire any standalone open pay-page PI before committing settlement
    // (mirrors recordManualPayment / apply-credit) so an open browser tab
    // cannot confirm it after cash/check/off-platform reconciliation.
    const triagedPiId = invoice.stripe_payment_intent_id || null;
    const chargePiId = chargeDetails?.payment_intent
      ? (typeof chargeDetails.payment_intent === 'string' ? chargeDetails.payment_intent : chargeDetails.payment_intent.id || null)
      : null;
    if (triagedPiId && triagedPiId !== chargePiId) {
      const { retireOpenPaymentIntentBeforeSettlement } = require('../services/invoice-manual-payment');
      const openPi = await retireOpenPaymentIntentBeforeSettlement(invoice, { action: 'reconciling this payment' });
      if (openPi) return res.status(openPi.status).json({ error: openPi.error });
      updates.stripe_payment_intent_id = chargePiId;
    }

    const collectedAmount = chargeDetails
      ? Number(chargeDetails.amount_captured ?? chargeDetails.amount) / 100
      : (amount != null ? Number(amount) : invoiceAmountDue(invoice));

    let txResult;
    try {
      txResult = await db.transaction(async (trx) => {
        const reservation = await require('../services/pay-combined').releaseCombinedSessionBeforeCollection(trx, invoice, { context: 'reconciling this payment' });
        if (reservation.invoice?.customer_id) invoice.customer_id = reservation.invoice.customer_id;
        if (stripeChargeId) {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['reconcile.stripe_charge', stripeChargeId],
          );
          const linkedNow = await trx('invoices').where({ stripe_charge_id: stripeChargeId }).first();
          if (linkedNow && linkedNow.id !== invoiceId) {
            return { conflict: `Charge already linked to invoice ${linkedNow.invoice_number}` };
          }
          const alreadyBooked = await trx('payments').where({ stripe_charge_id: stripeChargeId }).first();
          if (alreadyBooked) {
            return { conflict: 'Charge is already recorded in the payments ledger — it cannot be reconciled again' };
          }
        }

        const fence = await checkReconcileFencesInLock(trx, { invoiceId, invoice, triagedPiId, chargePiId });
        if (fence.conflict || fence.updated === 0) return fence;

        const rows = await trx('invoices')
          .where({ id: invoiceId })
          .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
          .update(updates);
        if (!rows) return { updated: 0 };

        await require('../services/payment-plans').completeActivePlansForInvoice(invoiceId, trx);

        await trx('payments').insert(buildReconcilePaymentRecord(invoice, {
          invoiceId,
          collectedVia,
          collectedAmount,
          stripeChargeId,
          chargeDetails,
        }));

        await auditPaymentReconcile({
          tech_user_id: req.technicianId || null,
          invoice_id: invoiceId,
          invoice_number: invoice.invoice_number,
          collected_via: collectedVia,
          stripe_charge_id: stripeChargeId || null,
          amount: collectedAmount,
          ip_address: ipFromReq(req),
          user_agent: uaFromReq(req),
          trx,
        });

        return { updated: rows };
      });
    } catch (releaseErr) {
      if (releaseErr.statusCode === 409) {
        return res.status(409).json({ error: releaseErr.message });
      }
      throw releaseErr;
    }
    if (txResult.conflict) {
      return res.status(409).json({ error: txResult.conflict });
    }
    if (!txResult.updated) {
      const current = await db('invoices').where({ id: invoiceId }).first('status');
      return res.status(409).json({
        error: `Invoice status changed to '${current?.status || 'unknown'}' while reconciling — no changes applied`,
      });
    }

    logger.info(`[reconcile] invoice ${invoice.invoice_number} marked paid via ${collectedVia}${stripeChargeId ? ` (${stripeChargeId})` : ''}`);

    const reviewUnrecordedWarning = await runPostReconcileSideEffects(invoice, {
      invoiceId,
      chargeDetails,
      technicianId: req.technicianId || null,
    });

    const refreshed = await db('invoices').where({ id: invoiceId }).first();
    res.json({
      success: true,
      invoice: refreshed,
      stripe_charge: chargeDetails ? {
        id: chargeDetails.id,
        amount: Number(chargeDetails.amount_captured ?? chargeDetails.amount) / 100,
        receipt_url: chargeDetails.receipt_url,
      } : null,
      ...(reviewUnrecordedWarning ? {
        reviewsUnrecorded: [reviewUnrecordedWarning],
        warning: 'The payment is recorded, but the review ask for this visit could not be recorded and no alert could be raised — enroll it from the visit or ask manually.',
      } : {}),
    });
  } catch (err) { next(err); }
});

module.exports = router;
