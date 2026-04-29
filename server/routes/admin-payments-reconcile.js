const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { auditPaymentReconcile, ipFromReq, uaFromReq } = require('../services/audit-log');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

router.use(adminAuthenticate, requireTechOrAdmin);

/**
 * Stripe Tap to Pay — Path A reconciliation
 *
 * Tech collects payment via the native Stripe Terminal iOS app (off-platform),
 * then admin reconciles by marking the portal invoice paid + attaching the
 * Stripe charge id so revenue reporting, receipts, and autopay state stay in sync.
 */

// GET /recent-charges — last 20 Stripe charges not yet linked to an invoice
router.get('/recent-charges', async (req, res, next) => {
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
router.post('/reconcile', async (req, res, next) => {
  try {
    const { invoiceId, stripeChargeId, collectedVia, amount, note } = req.body || {};
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
    if (!collectedVia) return res.status(400).json({ error: 'collectedVia required' });

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') {
      return res.status(409).json({ error: 'Invoice already paid' });
    }
    if (invoice.status === 'void') {
      return res.status(409).json({ error: 'Invoice is void' });
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

      // Sanity check amount (within $1 tolerance for tax rounding)
      const chargeAmt = chargeDetails.amount / 100;
      const invoiceTotal = parseFloat(invoice.total || 0);
      if (Math.abs(chargeAmt - invoiceTotal) > 1) {
        return res.status(400).json({
          error: `Amount mismatch — charge is $${chargeAmt.toFixed(2)} but invoice is $${invoiceTotal.toFixed(2)}`,
        });
      }

      // Prevent double-linking
      const already = await db('invoices').where({ stripe_charge_id: stripeChargeId }).first();
      if (already && already.id !== invoiceId) {
        return res.status(409).json({ error: `Charge already linked to invoice ${already.invoice_number}` });
      }

      updates.stripe_charge_id = stripeChargeId;
      updates.payment_method = chargeDetails.payment_method_details?.type || null;
      updates.card_brand = chargeDetails.payment_method_details?.card_present?.brand
        || chargeDetails.payment_method_details?.card?.brand || null;
      updates.card_last_four = chargeDetails.payment_method_details?.card_present?.last4
        || chargeDetails.payment_method_details?.card?.last4 || null;
      updates.receipt_url = chargeDetails.receipt_url || null;
    } else if (amount != null) {
      // Manual reconciliation — record the amount collected for audit
      updates.payment_method = collectedVia;
    }

    await db('invoices').where({ id: invoiceId }).update(updates);

    // Also create a payments ledger row so revenue reports pick up the collection
    try {
      await db('payments').insert({
        customer_id: invoice.customer_id,
        amount: parseFloat(invoice.total),
        status: 'paid',
        description: `Invoice ${invoice.invoice_number} — ${collectedVia}`,
        payment_date: etDateString(),
        stripe_charge_id: stripeChargeId || null,
        processor: stripeChargeId ? 'stripe' : null,
      });
    } catch (e) {
      logger.warn(`[reconcile] payments ledger insert skipped: ${e.message}`);
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
      amount: amount != null ? Number(amount) : parseFloat(invoice.total),
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
