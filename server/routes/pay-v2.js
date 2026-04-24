const express = require('express');
const router = express.Router();
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { generateInvoicePDF } = require('../services/pdf/invoice-pdf');
const ConsentService = require('../services/payment-method-consents');
const logger = require('../services/logger');

/**
 * Public pay routes — no auth required.
 * Customers access these via invoice token links (e.g. /pay/abc123def456).
 */

// =========================================================================
// GET /api/pay/:token — Invoice data + processor info + Stripe key
// =========================================================================
router.get('/:token', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const productsApplied = data.products_applied || [];
    const photos = data.service_photos || [];

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
        dueDate: data.due_date,
        paidAt: data.paid_at,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        receiptUrl: data.receipt_url,
        notes: data.notes,
      },
      service: {
        type: data.service_type,
        date: data.service_date,
        techName: data.tech_name,
        techNotes: data.tech_notes,
        productsApplied,
        photos,
      },
      customer: {
        firstName: customer.first_name,
        lastName: customer.last_name,
        tier: customer.waveguard_tier,
        address: customer.address_line1,
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        isCommercial: customer.property_type === 'commercial' || customer.property_type === 'business',
      },
      processor: 'stripe',
      stripe: {
        available: StripeService.isAvailable(),
        publishableKey: stripeConfig.publishableKey || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/setup — Create Stripe PaymentIntent for invoice
// =========================================================================
router.post('/:token/setup', async (req, res, next) => {
  try {
    const { saveCard } = req.body || {};
    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const result = await StripeService.createInvoicePaymentIntent(invoice.id, { saveCard: !!saveCard });

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      amount: result.amount,
      baseAmount: result.baseAmount,
      cardSurchargeRate: result.cardSurchargeRate,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    logger.error(`[pay-v2] Setup error: ${err.message}`);
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/update-amount — Adjust PI for selected payment method
// (adds a 3% processing surcharge for card-family methods; ACH stays at base)
// =========================================================================
router.post('/:token/update-amount', async (req, res, next) => {
  try {
    const { paymentIntentId, methodCategory, saveCard } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const result = await StripeService.updateInvoicePaymentIntentMethod(
      invoice.id,
      paymentIntentId,
      methodCategory,
      { saveCard: !!saveCard },
    );

    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Update-amount error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/confirm — Confirm Stripe payment for invoice
// =========================================================================
router.post('/:token/confirm', async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const paymentRecord = await StripeService.confirmInvoicePayment(invoice.id, paymentIntentId);

    // Send receipt SMS in the background
    InvoiceService.sendReceipt(invoice.id).catch(err => {
      logger.error(`[pay-v2] Receipt send failed: ${err.message}`);
    });

    res.json({
      success: true,
      payment: {
        id: paymentRecord.id,
        amount: parseFloat(paymentRecord.amount),
        status: paymentRecord.status,
      },
    });
  } catch (err) {
    logger.error(`[pay-v2] Confirm error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/consent — Record card-on-file authorization
//
// Called by the client right after a successful confirmPayment when the
// customer ticked the "Save this card on file" box. The Stripe webhook
// will create the payment_methods row asynchronously; this endpoint only
// records the consent (verbatim copy + version + IP/UA) and leaves the
// FK to payment_methods null for the webhook to back-fill.
// =========================================================================
router.post('/:token/consent', async (req, res, next) => {
  try {
    const { stripePaymentMethodId } = req.body || {};
    if (!stripePaymentMethodId) return res.status(400).json({ error: 'stripePaymentMethodId required' });

    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) return res.status(400).json({ error: 'Invoice has no customer' });

    const row = await ConsentService.recordConsent({
      customerId: invoice.customer_id,
      stripePaymentMethodId,
      source: 'pay_page',
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    res.json({ success: true, consentId: row.id, version: row.consent_text_version });
  } catch (err) {
    logger.error(`[pay-v2] Consent record failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// GET /api/pay/:token/invoice.pdf — Branded invoice PDF for download/print
// =========================================================================
router.get('/:token/invoice.pdf', async (req, res, next) => {
  try {
    const data = await InvoiceService.getByToken(req.params.token);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    generateInvoicePDF(data, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
