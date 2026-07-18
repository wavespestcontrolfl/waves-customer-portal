/**
 * Estimate checkout events — the local record that a customer reached the
 * save-a-card step of accepting an estimate.
 *
 * The two card intent endpoints (/recurring-card-intent, /card-hold-intent)
 * mint Stripe SetupIntents but persist nothing locally, so an abandoned
 * payment step left no evidence. This module stamps one row per
 * (estimate, kind), bumping updated_at on every re-reach — the same
 * "last time the customer touched the payment step" semantics the retired
 * deposit-intent endpoint had via PaymentIntent reuse. The follow-up
 * engine's payment-step stage keys its 2–72h abandonment window on it.
 */

const db = require('../models/db');
const logger = require('./logger');

const CHECKOUT_KIND = {
  RECURRING_CARD: 'recurring_card',
  CARD_HOLD: 'card_hold',
};

// Guaranteed non-throwing: this is ancillary logging on a customer-facing
// payment endpoint — it must never fail, delay, or alter the intent
// response. Callers may await it (deterministic for tests) without risk.
async function recordCheckoutStepReached(estimateId, kind, setupIntentId) {
  if (!estimateId || !kind) return false;
  try {
    await db('estimate_checkout_events')
      .insert({
        estimate_id: estimateId,
        kind,
        setup_intent_id: setupIntentId || null,
      })
      .onConflict(['estimate_id', 'kind'])
      .merge({
        setup_intent_id: setupIntentId || null,
        updated_at: db.fn.now(),
      });
    return true;
  } catch (err) {
    logger.warn(`[estimate-checkout-events] log skipped for estimate ${estimateId}: ${err.message}`);
    return false;
  }
}

module.exports = { recordCheckoutStepReached, CHECKOUT_KIND };
