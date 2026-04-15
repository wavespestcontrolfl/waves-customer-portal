const express = require('express');
const router = express.Router();
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
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
    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const result = await StripeService.createInvoicePaymentIntent(invoice.id);

    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      amount: result.amount,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    logger.error(`[pay-v2] Setup error: ${err.message}`);
    next(err);
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

module.exports = router;
