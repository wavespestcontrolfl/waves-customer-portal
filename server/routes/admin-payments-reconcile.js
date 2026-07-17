const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { auditPaymentReconcile, ipFromReq, uaFromReq } = require('../services/audit-log');
const { assertInvoiceCollectible, INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue } = require('../services/invoice-helpers');
const { computeChargeAmount } = require('../services/stripe-pricing');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

router.use(adminAuthenticate, requireTechOrAdmin);

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

// GET /recent-charges — last 20 Stripe charges not yet linked to an invoice
router.get('/recent-charges', recentChargesLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const charges = await stripe.charges.list({ limit: 40 });
    const linked = await db('invoices')
      .whereIn('stripe_charge_id', charges.data.map(c => c.id).filter(Boolean))
      .select('stripe_charge_id');
    const linkedSet = new Set(linked.map(r => r.stripe_charge_id));

    const unlinked = charges.data
      .filter(c => c.status === 'succeeded' && !linkedSet.has(c.id))
      .slice(0, 20)
      .map(c => ({
        id: c.id,
        amount: c.amount / 100,
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
    // Third-party Bill-To: a payer-billed invoice is owed by the payer's AP
    // inbox, not the service recipient. Off-platform reconciliation (cash /
    // check / Tap-to-Pay) settled from the homeowner would collect the wrong
    // party's money and mark the AP invoice paid — reject it here, mirroring
    // the Terminal-handoff payer guard.
    if (invoice.payer_id) {
      return res.status(400).json({ error: 'Invoice is billed to a third-party payer — do not collect or reconcile it against the service recipient' });
    }
    // Uncollectible invoices (paid/processing/void/refunded/canceled) can't be
    // reconciled — 'processing' especially: an ACH payment in flight will
    // settle on its own, so a cash/check reconcile would double-collect.
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const updates = {
      status: 'paid',
      paid_at: new Date(),
      collected_via: collectedVia,
      reconciled_by: req.technicianId || null,
      reconciled_at: new Date(),
      notes: note ? `${invoice.notes || ''}\n[reconciliation] ${note}`.trim() : invoice.notes,
      updated_at: new Date(),
    };

    let chargeDetails = null;
    if (stripeChargeId) {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      try {
        chargeDetails = await stripe.charges.retrieve(stripeChargeId);
      } catch (e) {
        return res.status(400).json({ error: `Stripe charge lookup failed: ${e.message}` });
      }
      if (chargeDetails.status !== 'succeeded') {
        return res.status(400).json({ error: `Charge is ${chargeDetails.status}, not succeeded` });
      }

      // Amount agreement, keyed on the amount DUE (total − applied account credit),
      // not the gross total. This route records a FLAT collected amount; it does NOT
      // persist the surcharge breakdown (base/surcharge/rate/policy/funding) the way
      // the Stripe + webhook charge paths do. So only NON-surcharged charges may be
      // reconciled here.
      //
      // Detect a surcharge at CENTS precision BEFORE the broad $1 tax-rounding
      // tolerance: a small surcharge (e.g. $0.58 on a $20 invoice — 2.9%) is under $1
      // and would otherwise slip through and be booked flat with no breakdown,
      // overstating revenue. Compare against the surcharge-inclusive total computed
      // the credit-funded worst case (so it's caught even when the retrieved charge
      // reports funding=null); a surcharged charge belongs to the normal flow.
      const chargeAmtCents = Math.round(chargeDetails.amount);
      const amountDue = invoiceAmountDue(invoice);
      const surcharged = computeChargeAmount(amountDue, 'card', { funding: 'credit' });
      if (surcharged.surchargeCents > 0 && Math.abs(chargeAmtCents - surcharged.totalCents) <= 1) {
        return res.status(400).json({
          error: `This charge includes a $${(surcharged.surchargeCents / 100).toFixed(2)} card surcharge. Surcharged charges are recorded through the normal payment flow with their surcharge breakdown — only non-surcharged charges can be reconciled here.`,
        });
      }
      // Otherwise require the bare amount due within $1 (tax rounding).
      const chargeAmt = chargeAmtCents / 100;
      if (Math.abs(chargeAmt - amountDue) > 1) {
        return res.status(400).json({
          error: `Amount mismatch — charge is $${chargeAmt.toFixed(2)} but invoice amount due is $${amountDue.toFixed(2)}`,
        });
      }

      // Prevent double-linking
      const already = await db('invoices').where({ stripe_charge_id: stripeChargeId }).first();
      if (already && already.id !== invoiceId) {
        return res.status(409).json({ error: `Charge already linked to invoice ${already.invoice_number}` });
      }
      // Also check the payments LEDGER, not just invoices.stripe_charge_id:
      // on-platform charges (webhook, saved-card, pay page) book their own
      // payments row, sometimes without stamping the invoice column —
      // reconciling one of those here would record the same money twice.
      const alreadyBooked = await db('payments').where({ stripe_charge_id: stripeChargeId }).first();
      if (alreadyBooked) {
        return res.status(409).json({ error: 'Charge is already recorded in the payments ledger — it cannot be reconciled again' });
      }
      // Verify the charge belongs to THIS invoice's customer when the charge
      // carries an identity we can map. Portal-created charges pin
      // metadata.waves_customer_id and/or a Stripe customer id; Tap-to-Pay
      // charges from the native Terminal app carry neither, so absence of
      // both stays reconcilable (that is this route's whole purpose).
      const chargeWavesCustomerId = chargeDetails.metadata?.waves_customer_id;
      if (chargeWavesCustomerId && String(chargeWavesCustomerId) !== String(invoice.customer_id)) {
        return res.status(400).json({ error: 'Charge belongs to a different customer than this invoice' });
      }
      const chargeStripeCustomer = typeof chargeDetails.customer === 'string'
        ? chargeDetails.customer
        : chargeDetails.customer?.id || null;
      if (chargeStripeCustomer) {
        const owner = await db('customers').where({ stripe_customer_id: chargeStripeCustomer }).first('id');
        if (owner && String(owner.id) !== String(invoice.customer_id)) {
          return res.status(400).json({ error: 'Charge belongs to a different customer than this invoice' });
        }
      }

      updates.stripe_charge_id = stripeChargeId;
      updates.payment_method = chargeDetails.payment_method_details?.type || null;
      updates.card_brand = chargeDetails.payment_method_details?.card_present?.brand
        || chargeDetails.payment_method_details?.card?.brand || null;
      updates.card_last_four = chargeDetails.payment_method_details?.card_present?.last4
        || chargeDetails.payment_method_details?.card?.last4 || null;
      updates.receipt_url = chargeDetails.receipt_url || null;
    } else if (amount != null) {
      // Manual reconciliation — record the amount collected for audit.
      // Mirror the Stripe path's $1 tolerance: marking an invoice paid while
      // recording a materially different collected amount would silently
      // drift revenue reports from the invoice ledger (e.g. a $1 typo on a
      // $500 invoice). Edit the invoice first if the total really changed.
      const invoiceTotal = invoiceAmountDue(invoice);
      if (Math.abs(Number(amount) - invoiceTotal) > 1) {
        return res.status(400).json({
          error: `Amount mismatch — collected $${Number(amount).toFixed(2)} but invoice is $${invoiceTotal.toFixed(2)}. Edit the invoice total first if it changed.`,
        });
      }
      updates.payment_method = collectedVia;
    }

    // What was actually collected: Stripe reconciles record the verified
    // charge amount (a caller-supplied amount must not override it); manual
    // reconciles honor the operator-supplied amount, else the invoice total.
    const collectedAmount = chargeDetails
      ? chargeDetails.amount / 100
      : (amount != null ? Number(amount) : invoiceAmountDue(invoice));

    // Conditional update closes the TOCTOU window: if the invoice became
    // uncollectible (paid/processing/void/refunded/canceled) between our read
    // and this write, the UPDATE matches 0 rows and we bail instead of
    // double-marking it.
    //
    // The payments-ledger insert rides the SAME transaction as the status
    // flip (mirroring record-payment in admin-invoices.js): the ledger row is
    // load-bearing for every revenue rollup, and a best-effort insert after
    // the flip left collected money permanently missing on a transient DB
    // failure. Either both commit or the operator gets a retryable error and
    // nothing changed.
    const updatedRows = await db.transaction(async (trx) => {
      const rows = await trx('invoices')
        .where({ id: invoiceId })
        .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
        .update(updates);
      if (!rows) return 0;

      // Payments ledger row so revenue reports pick up the collection
      await trx('payments').insert({
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
        }),
      });
      return rows;
    });
    if (!updatedRows) {
      const current = await db('invoices').where({ id: invoiceId }).first('status');
      return res.status(409).json({
        error: `Invoice status changed to '${current?.status || 'unknown'}' while reconciling — no changes applied`,
      });
    }

    try {
      const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
      await AnnualPrepayRenewals.syncTermForInvoicePayment({ id: invoiceId, status: 'paid', paid_at: new Date() });
    } catch (e) {
      logger.warn(`[reconcile] annual prepay activation skipped: ${e.message}`);
    }

    logger.info(`[reconcile] invoice ${invoice.invoice_number} marked paid via ${collectedVia}${stripeChargeId ? ` (${stripeChargeId})` : ''}`);

    // CRITICAL audit row — money flows through this endpoint and a missing
    // row makes a "charged but unpaid" reconciliation drift impossible to
    // trace later. await + let errors bubble (the route's existing try/catch
    // surfaces them); we'd rather 500 the request than silently lose the
    // audit trail.
    await auditPaymentReconcile({
      tech_user_id: req.technicianId || null,
      invoice_id: invoiceId,
      invoice_number: invoice.invoice_number,
      collected_via: collectedVia,
      stripe_charge_id: stripeChargeId || null,
      amount: collectedAmount,
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    const refreshed = await db('invoices').where({ id: invoiceId }).first();
    res.json({ success: true, invoice: refreshed, stripe_charge: chargeDetails ? {
      id: chargeDetails.id, amount: chargeDetails.amount / 100, receipt_url: chargeDetails.receipt_url,
    } : null });
  } catch (err) { next(err); }
});

module.exports = router;
