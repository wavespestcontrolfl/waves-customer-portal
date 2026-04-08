// DEPRECATED — replaced by pay-v2.js (Stripe + Square dual-processor support)
const express = require('express');
const router = express.Router();
const InvoiceService = require('../services/invoice');
const config = require('../config');
const logger = require('../services/logger');

// GET /api/pay/:token — public invoice data for the customer pay page
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
      },
      square: {
        appId: process.env.SQUARE_APP_ID || null,
        locationId: config.square?.locationId || null,
        environment: config.square?.environment || 'sandbox',
      },
    });
  } catch (err) { next(err); }
});

// POST /api/pay/:token — process payment
router.post('/:token', async (req, res, next) => {
  try {
    const { sourceId, verificationToken, paymentMethod } = req.body;
    if (!sourceId) return res.status(400).json({ error: 'sourceId required' });

    const result = await InvoiceService.processPayment(req.params.token, {
      sourceId, verificationToken, paymentMethod,
    });

    // Send receipt SMS in the background
    const invoice = await require('../models/db')('invoices').where({ token: req.params.token }).first();
    if (invoice) {
      InvoiceService.sendReceipt(invoice.id).catch(err => {
        logger.error(`[pay] Receipt send failed: ${err.message}`);
      });
    }

    res.json(result);
  } catch (err) {
    logger.error(`[pay] Payment error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
