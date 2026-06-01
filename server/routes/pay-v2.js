const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const InvoiceAttachments = require('../services/invoice-attachments');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { generateInvoicePDF } = require('../services/pdf/invoice-pdf');
const ConsentService = require('../services/payment-method-consents');
const logger = require('../services/logger');
const { assertInvoiceCollectible } = require('../services/invoice-helpers');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');
const BillPaymentErrorAlerts = require('../services/bill-payment-error-alerts');
const { shouldSkipClientPaymentErrorAlert } = require('./pay-v2-helpers');

/**
 * Public pay routes — no auth required.
 * Customers access these via invoice token links (e.g. /pay/abc123def456).
 */

const clientPaymentErrorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment error reports. Please call (941) 297-5749.' },
});

function cleanField(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function paymentRouteLabel(req) {
  if (req.route?.path) {
    return `${req.method} ${req.baseUrl || ''}${req.route.path}`;
  }
  const rawPath = req.originalUrl || req.path || '';
  const token = req.params?.token;
  const safePath = token ? rawPath.replace(String(token), ':token') : rawPath;
  return `${req.method} ${safePath}`;
}

function reportBillPaymentError(req, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode,
  source = 'server',
  metadata = {},
}) {
  if (!invoice?.id) return;
  BillPaymentErrorAlerts.alertBillPaymentError({
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    source,
    metadata: {
      route: paymentRouteLabel(req),
      method: req.method,
      ...metadata,
    },
  }).catch((alertErr) => {
    logger.warn(`[pay-v2] Bill payment error alert failed for invoice ${invoice.id}: ${alertErr.message}`);
  });
}

function respondWithPaymentError(req, res, {
  invoice,
  phase,
  methodCategory,
  paymentIntentId,
  error,
  message,
  code,
  statusCode = 400,
  clientMessage,
  metadata,
}) {
  reportBillPaymentError(req, {
    invoice,
    phase,
    methodCategory,
    paymentIntentId,
    error,
    message,
    code,
    statusCode,
    metadata,
  });
  return res.status(statusCode).json({ error: clientMessage || message || error?.message || 'Payment error' });
}

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
    const attachments = await InvoiceAttachments.list(data.id).catch((err) => {
      logger.warn(`[pay-v2] attachment list failed for invoice ${data.id}: ${err.message}`);
      return [];
    });

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
        attachments: attachments.map((a) => ({
          id: a.id,
          fileName: a.file_name,
          mimeType: a.mime_type,
          fileSizeBytes: a.file_size_bytes,
          createdAt: a.created_at,
        })),
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
// GET /api/pay/:token/attachments/:attachmentId — token-gated attachment view
// =========================================================================
router.get('/:token/attachments/:attachmentId', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first('id');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const attachment = await InvoiceAttachments.getForInvoice(invoice.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    const url = await InvoiceAttachments.signedViewUrl(attachment);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/setup — Create Stripe PaymentIntent for invoice
// =========================================================================
router.post('/:token/setup', async (req, res, next) => {
  let invoice = null;
  try {
    const { saveCard, cardOnly } = req.body || {};
    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.createInvoicePaymentIntent(invoice.id, { saveCard: !!saveCard, cardOnly: !!cardOnly });

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
    reportBillPaymentError(req, {
      invoice,
      phase: 'setup',
      methodCategory: 'card',
      error: err,
      statusCode: err.statusCode || 500,
      metadata: { save_card: !!req.body?.saveCard },
    });
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// =========================================================================
// POST /api/pay/:token/update-amount — Adjust PI for selected payment method
// No surcharge at this stage — both card and ACH stay at base amount.
// Surcharge is added at /quote + /finalize after PM funding is known.
// =========================================================================
router.post('/:token/update-amount', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId, methodCategory, saveCard } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.updateInvoicePaymentIntentMethod(
      invoice.id,
      paymentIntentId,
      methodCategory,
      { saveCard: !!saveCard },
    );

    res.json(result);
  } catch (err) {
    logger.error(
      `[pay-v2] Update-amount error `
      + `(PI ${req.body?.paymentIntentId || 'missing'}): ${err.type || 'Error'} — ${err.message}`
      + `${err.code ? ` [code=${err.code}]` : ''}`
      + `${err.param ? ` [param=${err.param}]` : ''}`,
    );
    reportBillPaymentError(req, {
      invoice,
      phase: 'update_amount',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: 'Could not update payment total. Please refresh and try again, or call (941) 297-5749.' });
  }
});

// =========================================================================
// POST /api/pay/:token/quote — Get surcharge quote for a specific PM
// =========================================================================
router.post('/:token/quote', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.quoteInvoiceSurcharge(invoice.id, paymentMethodId);
    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Quote error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'quote',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/finalize — Confirm payment with surcharge applied
// =========================================================================
router.post('/:token/finalize', async (req, res, next) => {
  let invoice = null;
  try {
    const { quoteToken, saveCard } = req.body || {};
    if (!quoteToken) return res.status(400).json({ error: 'quoteToken required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }

    const result = await StripeService.finalizeInvoicePayment(invoice.id, quoteToken, { saveCard: !!saveCard });
    res.json(result);
  } catch (err) {
    logger.error(`[pay-v2] Finalize error: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'finalize',
      methodCategory: 'card',
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
      metadata: { save_card: !!req.body?.saveCard },
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/confirm — Confirm Stripe payment for invoice
// (Legacy — kept for ACH confirmation and Express Checkout which skip /finalize)
// =========================================================================
router.post('/:token/confirm', async (req, res, next) => {
  let invoice = null;
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (['void', 'refunded', 'canceled', 'cancelled'].includes(String(invoice.status || '').toLowerCase())) {
      try {
        assertInvoiceCollectible(invoice.status);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.stripe_payment_intent_id
      && String(invoice.stripe_payment_intent_id) !== String(paymentIntentId)) {
      return res.status(409).json({ error: 'Invoice has a different active payment' });
    }

    const paymentRecord = await StripeService.confirmInvoicePayment(invoice.id, paymentIntentId);

    // Card payments are paid immediately. ACH bank payments sit in
    // `processing` until Stripe emits payment_intent.succeeded, so the
    // webhook sends the receipt after funds clear.
    if (paymentRecord.status === 'paid') {
      await ReceiptDeliveryQueue.enqueueReceiptDelivery({
        invoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId,
        source: 'pay_confirm',
      });
      ReceiptDeliveryQueue.scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 5 });
    }

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
    reportBillPaymentError(req, {
      invoice,
      phase: 'confirm',
      methodCategory: req.body?.methodCategory || invoice?.payment_method,
      paymentIntentId: req.body?.paymentIntentId,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/consent — Record save-payment-method authorization
//
// Called by the client right after a successful confirmPayment when the
// customer ticked the save-payment-method box. The Stripe webhook will
// create the payment_methods row asynchronously; this endpoint only
// records the consent (verbatim copy + version + IP/UA) and leaves the
// FK to payment_methods null for the webhook to back-fill.
//
// Method type (card vs ACH) is derived server-side from the invoice's
// own Stripe PaymentIntent, not from the request body. We also verify
// that the client-submitted stripePaymentMethodId is the same PM the
// PaymentIntent actually charged — that defends against a tampered
// client submitting an unrelated PM id. The endpoint fails closed if
// any of those checks can't be confirmed, since recording the wrong
// authorization variant defeats the entire snapshot audit trail.
// =========================================================================
router.post('/:token/consent', async (req, res, next) => {
  let invoice = null;
  try {
    const { stripePaymentMethodId, methodCategory } = req.body || {};
    if (!stripePaymentMethodId) return res.status(400).json({ error: 'stripePaymentMethodId required' });

    invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.customer_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Invoice has no customer',
        statusCode: 400,
      });
    }
    if (!invoice.stripe_payment_intent_id) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        message: 'Invoice has no PaymentIntent - cannot verify payment method',
        statusCode: 409,
      });
    }

    let pi;
    try {
      pi = await StripeService.retrievePaymentIntent(invoice.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
    } catch (err) {
      logger.error(`[pay-v2] PI retrieve failed for consent on invoice ${invoice.id}: ${err.message}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        error: err,
        statusCode: 502,
        clientMessage: 'Could not verify payment with Stripe',
      });
    }
    if (!pi) {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Payment processing temporarily unavailable',
        statusCode: 503,
      });
    }

    if (pi.payment_method !== stripePaymentMethodId) {
      logger.warn(`[pay-v2] Consent PM mismatch: client=${stripePaymentMethodId} pi.payment_method=${pi.payment_method} invoice=${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'PaymentMethod does not match the invoice charge',
        statusCode: 409,
        metadata: { stripe_payment_method_id: stripePaymentMethodId },
      });
    }

    // PI status acceptable for consent: succeeded (cards / wallets) or
    // processing (ACH, which clears asynchronously). Anything else means
    // the customer hasn't actually authorized a charge against this PM
    // on this invoice yet.
    if (pi.status !== 'succeeded' && pi.status !== 'processing') {
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: `PaymentIntent not in a consent-eligible state (status=${pi.status})`,
        statusCode: 409,
      });
    }

    // The customer must have opted to save the payment method when the
    // PI was set up. Both signals are written together by stripe.js
    // when saveCard is true on /setup or /update-amount:
    // setup_future_usage becomes 'off_session' and metadata.save_card_opt_in
    // becomes 'true'. Without those, a tampered client could otherwise
    // call /consent after any one-time payment and fabricate an
    // authorization row that the customer never actually agreed to.
    const optedIn = pi.setup_future_usage === 'off_session'
      && pi?.metadata?.save_card_opt_in === 'true';
    if (!optedIn) {
      logger.warn(`[pay-v2] Consent rejected — PI ${pi.id} not configured for save-on-file (setup_future_usage=${pi.setup_future_usage}, save_card_opt_in=${pi?.metadata?.save_card_opt_in})`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Save-on-file was not requested on this payment',
        statusCode: 409,
      });
    }

    // Prefer the verified charge.payment_method_details.type — that's
    // the method that actually ran. Fall back to pi.payment_method_types
    // only when there's no charge yet (rare for processing ACH).
    const pmdType = pi.latest_charge?.payment_method_details?.type || null;
    const fallbackType = Array.isArray(pi.payment_method_types) && pi.payment_method_types.length === 1
      ? pi.payment_method_types[0]
      : null;
    const verifiedMethodType = pmdType || fallbackType;
    if (!verifiedMethodType) {
      logger.warn(`[pay-v2] Could not determine method type for consent on invoice ${invoice.id}`);
      return respondWithPaymentError(req, res, {
        invoice,
        phase: 'consent',
        methodCategory,
        paymentIntentId: invoice.stripe_payment_intent_id,
        message: 'Could not determine payment method type',
        statusCode: 409,
      });
    }

    const row = await ConsentService.recordConsent({
      customerId: invoice.customer_id,
      stripePaymentMethodId,
      source: 'pay_page',
      methodType: verifiedMethodType,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });

    res.json({ success: true, consentId: row.id, version: row.consent_text_version });
  } catch (err) {
    logger.error(`[pay-v2] Consent record failed: ${err.message}`);
    reportBillPaymentError(req, {
      invoice,
      phase: 'consent',
      methodCategory: req.body?.methodCategory,
      paymentIntentId: invoice?.stripe_payment_intent_id,
      error: err,
      statusCode: 400,
    });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// POST /api/pay/:token/error — Browser-side payment form error report
//
// Used for Stripe.js/network failures that never become a Stripe webhook
// event and may never reach one of the server-side catch blocks above.
// =========================================================================
router.post('/:token/error', clientPaymentErrorLimiter, async (req, res) => {
  try {
    const invoice = await db('invoices').where({ token: req.params.token }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (shouldSkipClientPaymentErrorAlert(invoice)) {
      return res.json({ success: true, skipped: true, reason: 'non_collectible' });
    }

    const body = req.body || {};
    const message = cleanField(body.message || body.error || 'Payment form error');
    if (!message) return res.json({ success: true, skipped: true });

    await BillPaymentErrorAlerts.alertBillPaymentError({
      invoice,
      phase: cleanField(body.phase || 'client', 60),
      methodCategory: cleanField(body.methodCategory || invoice.payment_method || 'unknown', 60),
      paymentIntentId: cleanField(body.paymentIntentId || invoice.stripe_payment_intent_id || '', 128),
      message,
      code: cleanField(body.code || '', 100),
      statusCode: Number(body.statusCode || 0) || null,
      source: 'client',
      metadata: {
        route: paymentRouteLabel(req),
        stripe_type: cleanField(body.stripeType || '', 100) || null,
        client_phase: cleanField(body.clientPhase || '', 100) || null,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[pay-v2] Client payment error report failed: ${err.message}`);
    res.status(500).json({ error: 'Could not record payment error report' });
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
