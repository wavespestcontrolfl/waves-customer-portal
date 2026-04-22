const express = require('express');
const router = express.Router();
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { generateInvoicePDF, generateReceiptPDF } = require('../services/pdf/invoice-pdf');
const logger = require('../services/logger');

// Public receipt routes — no auth required. Reuses the permanent invoice.token.
// Token is 64-char crypto-random and has no TTL — receipts are records, not
// actions, so customers may retrieve them months later for bookkeeping.

async function loadPaymentForInvoice(invoiceId, customerId) {
  try {
    const row = await db('payments')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'refunded', 'processing'])
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoiceId])
      .orderBy('created_at', 'desc')
      .first();
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

    const customer = data.customer || {};
    const lineItems = data.line_items || [];
    const payment = await loadPaymentForInvoice(data.id, data.customer_id);

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
        dueDate: data.due_date,
        paidAt: data.paid_at,
        cardBrand: data.card_brand,
        cardLastFour: data.card_last_four,
        stripeReceiptUrl: data.receipt_url,
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
      },
      payment: payment
        ? {
          amount: totalPaid,
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
    if (data.status !== 'paid') return res.status(409).json({ error: 'Receipt not available — invoice unpaid' });

    const payment = await loadPaymentForInvoice(data.id, data.customer_id);
    generateReceiptPDF(data, payment, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
