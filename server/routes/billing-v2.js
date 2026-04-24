const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PaymentRouter = require('../services/payment-router');
const StripeService = require('../services/stripe');
const stripeConfig = require('../config/stripe-config');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// GET /api/billing — Payment history (routed to correct processor)
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const service = await PaymentRouter.getServiceForCustomer(req.customerId);
    const payments = await service.getPaymentHistory(req.customerId, parseInt(limit));

    res.json({
      payments: payments.map(p => ({
        id: p.id,
        date: p.payment_date,
        amount: parseFloat(p.amount),
        status: p.status,
        description: p.description,
        cardBrand: p.card_brand,
        lastFour: p.last_four,
        processor: 'stripe',
        methodType: p.method_type || 'card',
        bankName: p.bank_name || null,
        stripePaymentIntentId: p.stripe_payment_intent_id || null,
        refundAmount: p.refund_amount ? parseFloat(p.refund_amount) : null,
        refundStatus: p.refund_status || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/cards — All payment methods (both processors)
// =========================================================================
router.get('/cards', async (req, res, next) => {
  try {
    const cards = await db('payment_methods')
      .where({ customer_id: req.customerId })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');

    res.json({
      cards: cards.map(c => ({
        id: c.id,
        processor: 'stripe',
        methodType: c.method_type || 'card',
        brand: c.card_brand,
        lastFour: c.last_four,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        isDefault: c.is_default,
        autopayEnabled: c.autopay_enabled,
        bankName: c.bank_name || null,
        bankLastFour: c.bank_last_four || null,
        achStatus: c.ach_status || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/processor — Stripe publishable key + availability
// =========================================================================
router.get('/processor', async (req, res, next) => {
  try {
    res.json({
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
// POST /api/billing/cards/setup-intent — Create Stripe SetupIntent
// =========================================================================
router.post('/cards/setup-intent', async (req, res, next) => {
  try {
    const schema = Joi.object({
      paymentMethodType: Joi.string().valid('card', 'us_bank_account').default('card'),
    });

    const { paymentMethodType } = await schema.validateAsync(req.body);
    const result = await StripeService.createSetupIntent(req.customerId, paymentMethodType);

    res.json({
      clientSecret: result.clientSecret,
      setupIntentId: result.setupIntentId,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/billing/cards — Save a payment method (Stripe)
// =========================================================================
router.post('/cards', async (req, res, next) => {
  try {
    const schema = Joi.object({
      // Stripe: paymentMethodId from confirmed SetupIntent
      paymentMethodId: Joi.string().required(),
    });

    const { paymentMethodId } = await schema.validateAsync(req.body);

    const card = await StripeService.savePaymentMethod(req.customerId, paymentMethodId);

    // Record consent — the portal add-card modal shows SaveCardConsent
    // as locked + checked because saving is the whole point of the
    // modal. Arriving here means the customer saw the copy.
    try {
      const ConsentService = require('../services/payment-method-consents');
      await ConsentService.recordConsent({
        customerId: req.customerId,
        paymentMethodId: card.id,
        stripePaymentMethodId: paymentMethodId,
        source: 'portal_add_card',
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
      });
    } catch (consentErr) {
      require('../services/logger').error(`[billing-v2] Consent record failed: ${consentErr.message}`);
    }

    res.json({
      success: true,
      card: {
        id: card.id,
        processor: 'stripe',
        methodType: card.method_type || 'card',
        brand: card.card_brand,
        lastFour: card.last_four,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        isDefault: card.is_default,
        bankName: card.bank_name || null,
        bankLastFour: card.bank_last_four || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// DELETE /api/billing/cards/:id — Remove a payment method (auto-detect)
// =========================================================================
router.delete('/cards/:id', async (req, res, next) => {
  try {
    const card = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!card) return res.status(404).json({ error: 'Payment method not found' });

    await StripeService.removeCard(req.customerId, req.params.id);

    res.json({ success: true, message: 'Payment method removed' });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/balance — Outstanding balance
// =========================================================================
router.get('/balance', async (req, res, next) => {
  try {
    const customer = req.customer;

    const upcoming = await db('payments')
      .where({ customer_id: req.customerId, status: 'upcoming' })
      .sum('amount as total')
      .first();

    const failed = await db('payments')
      .where({ customer_id: req.customerId, status: 'failed' })
      .sum('amount as total')
      .first();

    const nextPayment = await db('payments')
      .where({ customer_id: req.customerId, status: 'upcoming' })
      .orderBy('payment_date', 'asc')
      .first();

    // Check for unpaid invoices
    const unpaidInvoices = await db('invoices')
      .where({ customer_id: req.customerId })
      .whereIn('status', ['sent', 'viewed', 'overdue'])
      .sum('total as total')
      .first();

    // The portal's billing banner flips to "failed" when the most recent
    // completed attempt failed — not when there's any failed row in history.
    const mostRecentAttempt = await db('payments')
      .where({ customer_id: req.customerId })
      .whereIn('status', ['paid', 'failed', 'refunded'])
      .orderBy('payment_date', 'desc')
      .first();

    res.json({
      currentBalance: parseFloat(failed?.total || 0) + parseFloat(unpaidInvoices?.total || 0),
      upcomingCharges: parseFloat(upcoming?.total || 0),
      monthlyRate: parseFloat(customer.monthly_rate || 0),
      tier: customer.waveguard_tier,
      processor: 'stripe',
      nextCharge: nextPayment ? {
        amount: parseFloat(nextPayment.amount),
        date: nextPayment.payment_date,
        description: nextPayment.description,
      } : null,
      lastPaymentFailed: mostRecentAttempt?.status === 'failed',
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/billing/cards/:id/default — Set a card as default
// =========================================================================
router.put('/cards/:id/default', async (req, res, next) => {
  try {
    const card = await db('payment_methods')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!card) return res.status(404).json({ error: 'Payment method not found' });

    await db('payment_methods')
      .where({ customer_id: req.customerId })
      .update({ is_default: false });

    await db('payment_methods')
      .where({ id: req.params.id })
      .update({ is_default: true });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
