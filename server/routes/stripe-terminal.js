const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const { adminAuthenticate } = require('../middleware/admin-auth');

const TERMINAL_LOCATION_ID = process.env.STRIPE_TERMINAL_LOCATION_ID || null;

function getStripe() {
  return new Stripe(stripeConfig.secretKey);
}

// POST /api/stripe/terminal/connection-token
// Issues a short-lived connection token to the iOS Terminal SDK.
// Auth: admin OR tech JWT (both roles can collect in person).
router.post('/connection-token', adminAuthenticate, async (req, res) => {
  try {
    const stripe = getStripe();
    const opts = TERMINAL_LOCATION_ID ? { location: TERMINAL_LOCATION_ID } : {};
    const token = await stripe.terminal.connectionTokens.create(opts);
    res.json({ secret: token.secret });
  } catch (err) {
    logger.error(`[stripe-terminal] connection-token failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/payment-intent
// Creates a card_present PaymentIntent tied to an invoice.
// Body: { invoiceId }
// Returns: { clientSecret, paymentIntentId, amount }
router.post('/payment-intent', adminAuthenticate, async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const amountCents = Math.round(Number(invoice.total) * 100);
    if (!amountCents || amountCents < 50) return res.status(400).json({ error: 'Invalid invoice amount' });

    const stripe = getStripe();
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        invoice_id: String(invoice.id),
        customer_id: String(invoice.customer_id || ''),
        source: 'tap_to_pay',
      },
    });

    await db('invoices').where({ id: invoice.id }).update({
      stripe_payment_intent_id: pi.id,
    });

    res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount: amountCents,
    });
  } catch (err) {
    logger.error(`[stripe-terminal] payment-intent failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/capture
// Manual capture path (if we ever switch capture_method to 'manual').
// Body: { paymentIntentId }
router.post('/capture', adminAuthenticate, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.capture(paymentIntentId);
    res.json({ status: pi.status, paymentIntentId: pi.id });
  } catch (err) {
    logger.error(`[stripe-terminal] capture failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
