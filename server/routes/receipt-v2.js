const express = require('express');
const router = express.Router();
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { generateInvoicePDF, generateReceiptPDF } = require('../services/pdf/invoice-pdf');
const logger = require('../services/logger');

// Public receipt routes — no auth required. Reuses the permanent invoice.token.
// Token is 64-char crypto-random and has no TTL — receipts are records, not
// actions, so customers may retrieve them months later for bookkeeping.

async function loadPaymentForInvoice(invoiceId, customerId, { stripePaymentIntentId = null, stripeChargeId = null } = {}) {
  try {
    const base = () => db('payments')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'refunded', 'processing'])
      .orderBy('created_at', 'desc');
    // Primary: payments tagged with this invoice in metadata.invoice_id.
    let row = await base()
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoiceId])
      .first();
    // Fallback for legacy / card-on-file rows that predate the metadata tag: resolve
    // by the invoice's own Stripe PaymentIntent / charge id. Without this a refunded
    // invoice can return no payment row → the receipt PDF would render no refund and
    // read as 'paid'.
    if (!row && (stripePaymentIntentId || stripeChargeId)) {
      row = await base()
        .where(function () {
          if (stripePaymentIntentId) this.orWhere('stripe_payment_intent_id', stripePaymentIntentId);
          if (stripeChargeId) this.orWhere('stripe_charge_id', stripeChargeId);
        })
        .first();
    }
    return row || null;
  } catch (err) {
    logger.warn(`[receipt-v2] payment lookup failed: ${err.message}`);
    return null;
  }
}

// =========================================================================
// GET /api/receipt/:token — Receipt view data (paid invoice record)
// =========================================================================
router.get('/:token', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Receipt not found' });

    // Third-party Bill-To: the AP contact opening the receipt link must see the
    // payer as "Billed to" (the emailed receipt PDF already does).
    await require('../services/payer').attachToInvoice(data);

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const payment = await loadPaymentForInvoice(data.id, data.customer_id, {
      stripePaymentIntentId: data.stripe_payment_intent_id,
      stripeChargeId: data.stripe_charge_id,
    });

    const refundAmount = payment ? Number(payment.refund_amount || 0) : 0;
    const totalPaid = payment ? Number(payment.amount || 0) : Number(data.total || 0);
    const remainingPaid = Math.max(0, totalPaid - refundAmount);
    const refundState = refundAmount > 0
      ? (refundAmount >= totalPaid ? 'fully_refunded' : 'partially_refunded')
      : null;

    res.json({
      invoice: {
        id: data.id,
        invoiceNumber: data.invoice_number,
        title: data.title,
        status: data.status,
        lineItems,
        subtotal: parseFloat(data.subtotal),
        discountAmount: parseFloat(data.discount_amount),
        discountLabel: data.discount_label,
        taxRate: parseFloat(data.tax_rate),
        taxAmount: parseFloat(data.tax_amount),
        total: parseFloat(data.total),
        // Applied account credit reduces the cash charged — surface it so the
        // receipt page can show the deduction and visually reconcile to the total.
        creditApplied: parseFloat(data.credit_applied || 0),
        dueDate: data.due_date,
        paidAt: data.paid_at,
        paymentMethod: data.payment_method,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        notes: data.notes,
      },
      service: {
        type: data.service_type,
        date: data.service_date,
        techName: data.tech_name,
      },
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        tier: customer.waveguard_tier,
        address: customer.address_line1,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        email: customer.email,
        isCommercial: customer.property_type === 'commercial' || customer.property_type === 'business',
      },
      payer: data.payer
        ? {
            name: data.payer.company_name || data.payer.display_name || null,
            email: data.payer.ap_email || null,
            address: data.payer.billing_address_line1 || null,
            city: data.payer.billing_city || null,
            state: data.payer.billing_state || null,
            zip: data.payer.billing_zip || null,
            poNumber: data.po_number || null,
          }
        // Fail closed: this receipt IS payer-billed (payer_id set) but the payer
        // couldn't be attached (legacy, no snapshot, inactive/deleted payer).
        // Serialize a third-party placeholder rather than null so the receipt
        // page does NOT render the homeowner as "Billed to" alongside the
        // payer's payment-method details.
        : data.payer_id
          ? {
              name: 'Third-party payer',
              email: null,
              address: null,
              city: null,
              state: null,
              zip: null,
              poNumber: data.po_number || null,
            }
          : null,
      payment: payment
        ? {
          amount: totalPaid,
          baseAmountCents: payment.base_amount_cents ?? null,
          surchargeAmountCents: payment.surcharge_amount_cents ?? 0,
          surchargeRateBps: payment.surcharge_rate_bps ?? 0,
          cardFunding: payment.card_funding ?? null,
          paymentDate: payment.payment_date,
          cardBrand: payment.card_brand || data.card_brand,
          cardLastFour: payment.card_last_four || data.card_last_four,
          refundAmount,
          refundStatus: payment.refund_status || refundState,
          refundedAt: payment.refunded_at,
          remainingPaid,
          state: data.status === 'paid'
            ? (refundState || 'paid')
            : data.status,
        }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/receipt/:token/pdf — Bookkeeping-grade receipt PDF (paid only)
// =========================================================================
router.get('/:token/pdf', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Receipt not found' });
    // Receipt permanence: a paid invoice that is later (fully) refunded moves to
    // status 'refunded' but keeps a valid bookkeeping receipt for the payment that
    // occurred — the view route + payment lookup already serve refunded receipts,
    // so the PDF must too (otherwise a credit-applied full refund silently breaks
    // the existing receipt link).
    if (!['paid', 'refunded'].includes(data.status)) {
      return res.status(409).json({ error: 'Receipt not available — invoice unpaid' });
    }

    const payment = await loadPaymentForInvoice(data.id, data.customer_id, {
      stripePaymentIntentId: data.stripe_payment_intent_id,
      stripeChargeId: data.stripe_charge_id,
    });
    // A refunded receipt MUST show the refund — if the payment/refund row can't be
    // resolved (e.g. a legacy row with neither metadata.invoice_id nor a matching
    // PI/charge), refuse rather than render a PDF that omits the refund and reads as
    // a plain 'paid' receipt for a refunded invoice.
    if (data.status === 'refunded' && !payment) {
      return res.status(409).json({ error: 'Receipt not available — refund record could not be resolved' });
    }
    // Keep the receipt's Bill-To consistent with the invoice (payer, not the
    // homeowner, when the job was third-party-billed).
    await require('../services/payer').attachToInvoice(data);
    // Fail closed: don't render the homeowner as Bill-To on a payer-billed
    // receipt PDF when the payer can't attach (legacy/inactive/deleted).
    if (!data.payer && data.payer_id) {
      data.payer = { company_name: 'Third-party payer', ap_email: null };
    }
    generateReceiptPDF(data, payment, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
