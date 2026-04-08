// DEPRECATED — replaced by billing-v2.js (Stripe + Square dual-processor support)
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const SquareService = require('../services/square');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// =========================================================================
// GET /api/billing — Payment history
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const payments = await SquareService.getPaymentHistory(req.customerId, parseInt(limit));

    res.json({
      payments: payments.map(p => ({
        id: p.id,
        date: p.payment_date,
        amount: parseFloat(p.amount),
        status: p.status,
        description: p.description,
        cardBrand: p.card_brand,
        lastFour: p.last_four,
        squarePaymentId: p.square_payment_id,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/billing/balance — Current balance and next charge info
// =========================================================================
router.get('/balance', async (req, res, next) => {
  try {
    const customer = req.customer;

    // Check for any unpaid/upcoming payments
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

    res.json({
      currentBalance: parseFloat(failed?.total || 0),
      upcomingCharges: parseFloat(upcoming?.total || 0),
      monthlyRate: parseFloat(customer.monthly_rate),
      tier: customer.waveguard_tier,
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
// GET /api/billing/cards — Cards on file
// =========================================================================
router.get('/cards', async (req, res, next) => {
  try {
    const cards = await SquareService.getCards(req.customerId);

    res.json({
      cards: cards.map(c => ({
        id: c.id,
        brand: c.card_brand,
        lastFour: c.last_four,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        isDefault: c.is_default,
        autopayEnabled: c.autopay_enabled,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/billing/cards — Add a new card (using Square card nonce)
// =========================================================================
router.post('/cards', async (req, res, next) => {
  try {
    const schema = Joi.object({
      cardNonce: Joi.string().required(),
    });

    const { cardNonce } = await schema.validateAsync(req.body);
    const card = await SquareService.saveCard(req.customerId, cardNonce);

    res.json({
      success: true,
      card: {
        id: card.id,
        brand: card.card_brand,
        lastFour: card.last_four,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        isDefault: card.is_default,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// DELETE /api/billing/cards/:id — Remove a card
// =========================================================================
router.delete('/cards/:id', async (req, res, next) => {
  try {
    await SquareService.removeCard(req.customerId, req.params.id);
    res.json({ success: true, message: 'Card removed' });
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

    if (!card) return res.status(404).json({ error: 'Card not found' });

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
