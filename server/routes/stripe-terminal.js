const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const { adminAuthenticate } = require('../middleware/admin-auth');
const { auditTerminalHandoffMint, ipFromReq, uaFromReq } = require('../services/audit-log');

const TERMINAL_LOCATION_ID = process.env.STRIPE_TERMINAL_LOCATION_ID || null;

// Handoff JWT lifetime. Short enough that a leaked token from a logged
// screenshot or sniffed link is useless within minutes.
const HANDOFF_TTL_SECONDS = 60;
const HANDOFF_ISS = 'waves-portal';
const HANDOFF_AUD = 'waves-pay-ios';

function getStripe() {
  return new Stripe(stripeConfig.secretKey);
}

function getHandoffSecret() {
  const s = process.env.TERMINAL_HANDOFF_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

// Rate limiter for handoff mints. Keyed on tech_user_id (NOT IP) so a tech
// switching networks doesn't reset their bucket and a shared NAT'd network
// (office wifi) doesn't share buckets across techs. adminAuthenticate runs
// first and populates req.technicianId; falling back to req.ip is a safety
// net for the (impossible) case where this limiter is mounted without auth.
// In-memory store matches every other rate-limited route in the portal —
// the real replay protection is the DB-backed jti burn at validate-handoff.
const handoffMintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tech:${req.technicianId || req.ip}`,
  message: { error: 'Too many handoff mints. Try again in an hour.' },
});

// POST /api/stripe/terminal/handoff
// Mints a 60-second HMAC-JWT that the PWA embeds in a wavespay:// deep link.
// The native iOS app POSTs the token to /validate-handoff, which atomically
// burns the jti — second use is rejected.
//
// Body: { invoice_id }
// Returns: { token, deep_link, jti, expires_at }
router.post('/handoff', adminAuthenticate, handoffMintLimiter, async (req, res) => {
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      logger.error('[stripe-terminal] handoff mint refused — TERMINAL_HANDOFF_SECRET unset or too short');
      return res.status(500).json({ error: 'Handoff signing not configured' });
    }

    const { invoice_id } = req.body || {};
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

    const invoice = await db('invoices').where({ id: invoice_id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

    const amount_cents = Math.round(Number(invoice.total) * 100);
    if (!amount_cents || amount_cents < 50) {
      return res.status(400).json({ error: 'Invalid invoice amount' });
    }

    // 16 random bytes = 128 bits of entropy, encoded as 32 hex chars. Avoids
    // the UUID v4 dependency and gives us a primary-key-safe string we can
    // atomically burn on /validate-handoff.
    const jti = crypto.randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + HANDOFF_TTL_SECONDS;
    const expires_at = new Date(exp * 1000);

    // Insert the replay-tracking row BEFORE signing, so the PK is reserved.
    // A jti collision is astronomically unlikely (~1 in 2^128), but if it
    // happens the unique-violation surfaces here and the signed token is
    // never returned.
    await db('terminal_handoff_tokens').insert({ jti, expires_at });

    const token = jwt.sign(
      {
        invoice_id: String(invoice.id),
        amount_cents,
        tech_user_id: req.technicianId,
        jti,
      },
      secret,
      {
        algorithm: 'HS256',
        issuer: HANDOFF_ISS,
        audience: HANDOFF_AUD,
        expiresIn: HANDOFF_TTL_SECONDS,
      },
    );

    // Fire-and-forget — the handoff_tokens row + Stripe PI are the primary
    // record. audit_log is secondary forensics.
    auditTerminalHandoffMint({
      tech_user_id: req.technicianId,
      invoice_id: invoice.id,
      amount_cents,
      jti,
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    res.json({
      token,
      deep_link: `wavespay://collect?t=${encodeURIComponent(token)}`,
      jti,
      expires_at: expires_at.toISOString(),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] handoff mint failed: ${err.message}`);
    res.status(500).json({ error: 'Handoff mint failed' });
  }
});

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
