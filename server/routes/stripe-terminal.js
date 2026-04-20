const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const { adminAuthenticate } = require('../middleware/admin-auth');
const {
  auditTerminalHandoffMint,
  auditTerminalHandoffRateLimited,
  ipFromReq,
  uaFromReq,
} = require('../services/audit-log');

const TERMINAL_LOCATION_ID = process.env.STRIPE_TERMINAL_LOCATION_ID || null;

// Handoff JWT lifetime. Short enough that a leaked token from a logged
// screenshot or sniffed link is useless within minutes.
const HANDOFF_TTL_SECONDS = 60;
const HANDOFF_ISS = 'waves-portal';
const HANDOFF_AUD = 'waves-pay-ios';

// Per-tech mint ceiling. The limiter is a security control (handoff tokens
// authorize real-money charges) — it MUST survive deploys and be accurate
// across replicas. Enforced in Postgres, not in-memory.
//
// Baseline reasoning for 20/hr: a normal field day is 8–12 stops. 20 mints
// gives 8–12 legitimate taps plus generous headroom for retries (tech
// fumbles the flow, customer says "wait let me grab a different card",
// reader disconnects and has to reconnect). Any tech hitting 20 in a
// rolling hour is either in trouble or the token is leaked — either way
// we want a 429 + audit row, not silent passage.
//
// Env-overridable so dev can use 100 for easier testing and so the number
// can be tuned in production without a deploy.
const HANDOFF_MINTS_PER_HOUR = (() => {
  const raw = parseInt(process.env.HANDOFF_MINT_RATE_LIMIT_PER_HOUR, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();

function getStripe() {
  return new Stripe(stripeConfig.secretKey);
}

function getHandoffSecret() {
  const s = process.env.TERMINAL_HANDOFF_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

// POST /api/stripe/terminal/handoff
// Mints a 60-second HMAC-JWT that the PWA embeds in a wavespay:// deep link.
// The native iOS app POSTs the token to /validate-handoff, which atomically
// burns the jti — second use is rejected.
//
// Body: { invoice_id }
// Returns: { token, deep_link, jti, expires_at }
//
// Rate limit: HANDOFF_MINTS_PER_HOUR per tech_user_id, enforced by counting
// rows in terminal_handoff_tokens inside the same transaction that reserves
// the jti. An advisory lock keyed on tech_user_id serializes concurrent
// mints for the same tech so two near-simultaneous requests can't both
// pass the count check (READ COMMITTED isolation otherwise allows it).
// adminAuthenticate guarantees req.technicianId is set — if that ever
// changes the transaction aborts (advisory lock call throws on NULL).
router.post('/handoff', adminAuthenticate, async (req, res) => {
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

    let rateLimited = false;
    let rateLimitedCount = 0;
    let rateLimitedRetryAfter = 3600;
    let mintedJti = null;
    let mintedExpiresAt = null;

    await db.transaction(async (trx) => {
      // Serialize concurrent mints for this tech. Two int4 args give us a
      // namespace + key pair; the lock is held until the transaction ends.
      // Different techs get different keys and proceed in parallel.
      //
      // Explicit ::text cast on tech_user_id: hashtext() accepts text and
      // uuid has no implicit cast to text in all postgres versions. The
      // cast is free and makes the call safe if Knex ever hands us the
      // uuid as something other than a JS string.
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['terminal.handoff.mint', String(req.technicianId)],
      );

      // Single query for both the count AND the oldest qualifying row.
      // oldest.created_at + 1 hour is the moment the bucket frees up a
      // slot — we return that delta as Retry-After so iOS can render
      // "try again in N minutes" instead of a generic error.
      const [row] = await trx('terminal_handoff_tokens')
        .where('tech_user_id', req.technicianId)
        .where('created_at', '>', trx.raw("NOW() - INTERVAL '1 hour'"))
        .select(
          trx.raw('COUNT(*)::int AS count'),
          trx.raw('MIN(created_at) AS oldest'),
        );

      const recent = Number(row?.count || 0);

      if (recent >= HANDOFF_MINTS_PER_HOUR) {
        rateLimited = true;
        rateLimitedCount = recent;
        const oldestMs = row?.oldest ? new Date(row.oldest).getTime() : Date.now();
        const retryAtMs = oldestMs + 60 * 60 * 1000;
        rateLimitedRetryAfter = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
        return; // commit with no writes — lock releases, count is unchanged
      }

      // 16 random bytes = 128 bits of entropy, 32 hex chars. Avoids the
      // UUID v4 dependency and gives us a primary-key-safe string we can
      // atomically burn on /validate-handoff.
      const jti = crypto.randomBytes(16).toString('hex');
      const expires_at = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);

      // Insert the replay-tracking row BEFORE signing, so the PK is
      // reserved and the row is visible to the next rate-limit count. A
      // jti collision is ~1 in 2^128 — if it ever happens, the unique
      // violation surfaces here and no token is returned.
      await trx('terminal_handoff_tokens').insert({
        jti,
        tech_user_id: req.technicianId,
        expires_at,
      });

      mintedJti = jti;
      mintedExpiresAt = expires_at;
    });

    if (rateLimited) {
      auditTerminalHandoffRateLimited({
        tech_user_id: req.technicianId,
        invoice_id: invoice.id,
        recent_count: rateLimitedCount,
        retry_after_seconds: rateLimitedRetryAfter,
        ip_address: ipFromReq(req),
        user_agent: uaFromReq(req),
      });
      res.setHeader('Retry-After', String(rateLimitedRetryAfter));
      return res.status(429).json({
        error: 'Too many handoff mints. Try again in an hour.',
        retry_after_seconds: rateLimitedRetryAfter,
      });
    }

    const token = jwt.sign(
      {
        invoice_id: String(invoice.id),
        amount_cents,
        tech_user_id: req.technicianId,
        jti: mintedJti,
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
      jti: mintedJti,
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    res.json({
      token,
      deep_link: `wavespay://collect?t=${encodeURIComponent(token)}`,
      jti: mintedJti,
      expires_at: mintedExpiresAt.toISOString(),
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
