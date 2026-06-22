/**
 * Third-party Payer Phase 2 — P3 (pay + settle): self-serve statement pay.
 *
 * Mounted at /api/pay/statement (BEFORE /api/pay so the two-segment statement
 * paths aren't shadowed by the invoice router's `/:token`). The statement's own
 * `payer_statements.token` resolves the statement and charges the PAYER's Stripe
 * customer — never the homeowner. Mirrors the invoice pay surface (setup → quote
 * → finalize), but on the statement status state machine. Settlement to `paid`
 * (cascade) happens via the Stripe webhook, not here.
 *
 * Gated behind GATE_PAYER_STATEMENTS — a 404 when off, so no public surface
 * exists until the lane is enabled.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const StripeService = require('../services/stripe');
const { isEnabled } = require('../config/feature-gates');
const { loadStatementLines } = require('../services/payer-statements');
const { markStatementViewed, isPayableStatementStatus } = require('../services/payer-statement-settle');
const { CONFIGURED_COST_BPS } = require('../services/stripe-pricing');

// Public-route rate limit (per IP) — this is an unauthenticated by-token surface.
const statementPayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

// Gate FIRST — off ⇒ the public statement-pay surface does not exist (always
// 404, before the limiter, so a disabled gate can't be probed via a 429 once an
// IP exceeds the rate). Then rate-limit the enabled surface. A 64-hex token
// format gate lives in loadStatementByToken.
router.use((req, res, next) => {
  if (!isEnabled('payerStatements')) return res.status(404).json({ error: 'Not found' });
  next();
}, statementPayLimiter);

const TOKEN_RE = /^[0-9a-f]{64}$/i; // payer_statements.token = randomBytes(32).hex

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function loadStatementByToken(token) {
  if (!token || !TOKEN_RE.test(token)) return null; // format gate → generic 404
  return db('payer_statements').where({ token }).first();
}

// GET /api/pay/statement/:token — statement summary + visit lines for the AP pay
// page. Stamps `viewed` (sent→viewed) on first open. Never exposes homeowner data
// beyond the serviced address already on the consolidated statement.
router.get('/:token', async (req, res, next) => {
  try {
    const statement = await loadStatementByToken(req.params.token);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    // First open: sent → viewed (a fact, not a dunning exit). Best-effort.
    try { await markStatementViewed(statement.id); } catch (e) { logger.warn(`[pay-statement] view stamp failed S-${statement.id}: ${e.message}`); }

    // Public payload: serviced ADDRESS + visit metadata only — NEVER the
    // homeowner name (AGENTS public-route contract). loadStatementLines is the
    // admin/PDF shape; whitelist fields here.
    const lines = (await loadStatementLines(statement.id)).map((l) => ({
      invoice_number: l.invoice_number,
      service_date: l.service_date,
      service_type: l.service_type,
      service_address: l.service_address,
      subtotal: l.subtotal,
      tax_amount: l.tax_amount,
      total: l.total,
    }));
    const snap = parseSnapshot(statement.payer_snapshot) || {};
    res.json({
      statement: {
        id: statement.id,
        number: `S-${statement.id}`,
        status: statement.status,
        payable: isPayableStatementStatus(statement.status),
        period_start: statement.period_start,
        period_end: statement.period_end,
        due_date: statement.due_date,
        terms: statement.terms_snapshot,
        subtotal: statement.subtotal,
        tax_amount: statement.tax_amount,
        total: statement.total,
        invoice_count: statement.invoice_count,
        paid_at: statement.paid_at,
        // The statement's CURRENT active PaymentIntent — lets the pay page bind a
        // Stripe redirect return to THIS statement's live attempt (a stale PI from
        // a since-refunded statement, or a copied client-secret from another
        // statement, won't match and so can't fake a "submitted" state). Not
        // sensitive: the AP already holds this PI's client secret from /setup.
        active_payment_intent_id: statement.stripe_payment_intent_id || null,
      },
      billTo: { company: snap.company_name || snap.display_name || null, ap_email: snap.ap_email || null },
      lines,
      surchargeRateBps: CONFIGURED_COST_BPS,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/pay/statement/:token/setup — create (or reuse) the PaymentIntent on
// the payer's Stripe customer, at the BASE total. 409 if already in flight/paid.
router.post('/:token/setup', async (req, res, next) => {
  try {
    const statement = await loadStatementByToken(req.params.token);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const result = await StripeService.createStatementPaymentIntent(statement.id, { saveCard: !!req.body?.saveCard });
    res.json({
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      amount: result.amount,
      baseAmount: result.baseAmount,
      cardSurchargeRate: result.cardSurchargeRate,
      publishableKey: stripeConfig.publishableKey,
    });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    logger.error(`[pay-statement] setup error: ${err.message}`);
    next(err);
  }
});

// POST /api/pay/statement/:token/quote — surcharge quote for the chosen PM.
router.post('/:token/quote', async (req, res, next) => {
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });
    const statement = await loadStatementByToken(req.params.token);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const result = await StripeService.quoteStatementSurcharge(statement.id, paymentMethodId);
    res.json(result);
  } catch (err) {
    logger.error(`[pay-statement] quote error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/pay/statement/:token/finalize — apply surcharge + confirm the PI.
// The statement settles to `paid` via the webhook, not here.
router.post('/:token/finalize', async (req, res, next) => {
  try {
    const { quoteToken, saveCard } = req.body || {};
    if (!quoteToken) return res.status(400).json({ error: 'quoteToken required' });
    const statement = await loadStatementByToken(req.params.token);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const result = await StripeService.finalizeStatementPayment(statement.id, quoteToken, { saveCard: !!saveCard });
    res.json(result);
  } catch (err) {
    logger.error(`[pay-statement] finalize error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
