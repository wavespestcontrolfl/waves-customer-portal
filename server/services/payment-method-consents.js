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

const VALID_SOURCES = new Set(['pay_page', 'onboarding', 'portal_add_card', 'admin_tap_to_pay', 'backfill']);

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

/**
 * Sweep consents whose FK to payment_methods never got backfilled. The
 * webhook handler does the link in real time on setup_intent.succeeded,
 * but a missed webhook (Stripe outage, signature key rotation, app
 * downtime past Stripe's 72h retry window) leaves the row with
 * payment_method_id = NULL forever.
 *
 * Run nightly. For every orphan older than `olderThanHours`, look up
 * the matching payment_methods row by stripe_payment_method_id and
 * link it. Anything still unlinked past `staleAfterDays` is logged as
 * genuinely orphaned (the customer likely detached the PM before we
 * managed to mirror it, or the webhook never fired and the SetupIntent
 * was abandoned) — those don't get cleaned up automatically because
 * they're audit evidence the customer agreed to save a card.
 *
 * Returns { total, linked, stale } counts.
 */
async function sweepOrphanConsents({ olderThanHours = 24, staleAfterDays = 30 } = {}) {
  const skewCutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const staleCutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);

  const orphans = await db('payment_method_consents')
    .whereNull('payment_method_id')
    .where('created_at', '<', skewCutoff)
    .select('id', 'stripe_payment_method_id', 'created_at');

  let linked = 0;
  let stale = 0;
  for (const o of orphans) {
    const pm = await db('payment_methods')
      .where({ stripe_payment_method_id: o.stripe_payment_method_id })
      .first();
    if (pm) {
      await db('payment_method_consents')
        .where({ id: o.id })
        .update({ payment_method_id: pm.id });
      linked++;
    } else if (new Date(o.created_at) < staleCutoff) {
      stale++;
    }
  }
  return { total: orphans.length, linked, stale };
}

module.exports = {
  recordConsent,
  linkPaymentMethodId,
  sweepOrphanConsents,
  VALID_SOURCES: Array.from(VALID_SOURCES),
};
