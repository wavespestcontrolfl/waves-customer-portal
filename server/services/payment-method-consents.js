/**
 * Card-on-file consent ledger.
 *
 * Records one immutable row per "save this card" opt-in with a verbatim
 * snapshot of the copy the customer saw. Consumed by /pay/:token,
 * onboarding, portal add-card modal, and admin tap-to-pay.
 *
 * The copy text and version live in ./payment-method-consent-text.js so
 * both client and server read from the same source — if you bump the copy
 * you MUST bump the version string so old rows remain interpretable.
 */

const db = require('../models/db');
const logger = require('./logger');
const { CONSENT_TEXT, CONSENT_VERSION } = require('./payment-method-consent-text');

const VALID_SOURCES = new Set(['pay_page', 'onboarding', 'portal_add_card', 'admin_tap_to_pay']);

async function recordConsent({
  customerId,
  paymentMethodId = null,
  stripePaymentMethodId,
  source,
  ip = null,
  userAgent = null,
}) {
  if (!customerId) throw new Error('recordConsent: customerId required');
  if (!stripePaymentMethodId) throw new Error('recordConsent: stripePaymentMethodId required');
  if (!VALID_SOURCES.has(source)) throw new Error(`recordConsent: invalid source "${source}"`);

  const [row] = await db('payment_method_consents').insert({
    customer_id: customerId,
    payment_method_id: paymentMethodId,
    stripe_payment_method_id: stripePaymentMethodId,
    source,
    consent_text_version: CONSENT_VERSION,
    consent_text_snapshot: CONSENT_TEXT,
    ip,
    user_agent: userAgent,
  }).returning('*');

  logger.info(`[consent] Recorded ${source} consent for customer ${customerId}, pm ${stripePaymentMethodId} (${CONSENT_VERSION})`);
  return row;
}

/**
 * Backfill the FK to payment_methods when the webhook finally writes the
 * row. Called from stripe-webhook.js handleSetupIntentSucceeded.
 */
async function linkPaymentMethodId(stripePaymentMethodId, paymentMethodId) {
  await db('payment_method_consents')
    .where({ stripe_payment_method_id: stripePaymentMethodId })
    .whereNull('payment_method_id')
    .update({ payment_method_id: paymentMethodId });
}

module.exports = {
  recordConsent,
  linkPaymentMethodId,
  VALID_SOURCES: Array.from(VALID_SOURCES),
};
