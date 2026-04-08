const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PaymentRouter = require('../services/payment-router');
const StripeService = require('../services/stripe');
const SquareService = require('../services/square');
const stripeConfig = require('../config/stripe-config');
const config = require('../config');
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
        processor: p.processor || p.pm_processor || null,
        methodType: p.method_type || 'card',
        bankName: p.bank_name || null,
        squarePaymentId: p.square_payment_id || null,
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
        processor: c.processor || 'square',
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
// GET /api/billing/processor — Which processor + publishable keys
// =========================================================================
router.get('/processor', async (req, res, next) => {
  try {
    const processor = await PaymentRouter.getProcessorName(req.customerId);

    res.json({
      processor,
      stripe: {
        available: StripeService.isAvailable(),
        publishableKey: stripeConfig.publishableKey || null,
      },
      square: {
        available: !!config.square?.accessToken,
        appId: process.env.SQUARE_APP_ID || null,
        locationId: config.square?.locationId || null,
        environment: config.square?.environment || 'sandbox',
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
// POST /api/billing/cards — Save a payment method (Stripe or Square)
// =========================================================================
router.post('/cards', async (req, res, next) => {
  try {
    const schema = Joi.object({
      // Stripe: paymentMethodId from confirmed SetupIntent
      paymentMethodId: Joi.string().optional(),
      // Square: cardNonce from Square Web Payments SDK
      cardNonce: Joi.string().optional(),
    }).or('paymentMethodId', 'cardNonce');

    const { paymentMethodId, cardNonce } = await schema.validateAsync(req.body);

    let card;
    if (paymentMethodId) {
      // Stripe flow
      card = await StripeService.savePaymentMethod(req.customerId, paymentMethodId);
    } else {
      // Square flow
      card = await SquareService.saveCard(req.customerId, cardNonce);
    }

    res.json({
      success: true,
      card: {
        id: card.id,
        processor: card.processor || 'square',
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

    if (card.processor === 'stripe') {
      await StripeService.removeCard(req.customerId, req.params.id);
    } else {
      await SquareService.removeCard(req.customerId, req.params.id);
    }

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

    res.json({
      currentBalance: parseFloat(failed?.total || 0) + parseFloat(unpaidInvoices?.total || 0),
      upcomingCharges: parseFloat(upcoming?.total || 0),
      monthlyRate: parseFloat(customer.monthly_rate || 0),
      tier: customer.waveguard_tier,
      processor: await PaymentRouter.getProcessorName(req.customerId),
      nextCharge: nextPayment ? {
        amount: parseFloat(nextPayment.amount),
        date: nextPayment.payment_date,
        description: nextPayment.description,
      } : null,
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
