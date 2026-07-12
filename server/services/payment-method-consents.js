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
const { CONSENT_VERSION, getConsentText } = require('./payment-method-consent-text');

const VALID_SOURCES = new Set(['pay_page', 'onboarding', 'portal_add_card', 'admin_tap_to_pay', 'contract_signing', 'backfill', 'estimate_card_hold', 'estimate_accept']);

// methodType selects which authorization copy to snapshot. Omitted/
// unknown values default to the card variant via getConsentText().
// Card and ACH consents diverge in content (NACHA/Reg E adds ACH-specific
// requirements) so snapshotting the wrong variant would mis-record what
// the customer actually saw.
async function recordConsent({
  customerId,
  paymentMethodId = null,
  stripePaymentMethodId,
  source,
  methodType = 'card',
  ip = null,
  userAgent = null,
}) {
  if (!customerId) throw new Error('recordConsent: customerId required');
  if (!stripePaymentMethodId) throw new Error('recordConsent: stripePaymentMethodId required');
  if (!VALID_SOURCES.has(source)) throw new Error(`recordConsent: invalid source "${source}"`);

  const consentText = getConsentText(methodType);

  const [row] = await db('payment_method_consents').insert({
    customer_id: customerId,
    payment_method_id: paymentMethodId,
    stripe_payment_method_id: stripePaymentMethodId,
    source,
    consent_text_version: CONSENT_VERSION,
    consent_text_snapshot: consentText,
    ip,
    user_agent: userAgent,
  }).returning('*');

  logger.info(`[consent] Recorded ${source} consent for customer ${customerId}, pm ${stripePaymentMethodId} (${CONSENT_VERSION}, methodType=${methodType})`);
  return row;
}

// Only consent copy from v8 on authorizes charging the method "for future
// service visits and invoices as agreed" — earlier versions were plain
// card-on-file copy and the backfill's v0_implicit_pre_consent rows are
// explicitly NOT evidence of informed authorization (Codex #2507 P1
// round-3). Version strings are 'v<major>_<date>'.
const MIN_ENROLLMENT_CONSENT_MAJOR = 8;
function consentVersionQualifiesForEnrollment(version) {
  const m = /^v(\d+)(?:[_-]|$)/.exec(String(version || ''));
  return !!m && Number(m[1]) >= MIN_ENROLLMENT_CONSENT_MAJOR;
}

/**
 * Does an ENROLLMENT-QUALIFYING consent row exist for this customer +
 * Stripe pm? The autopay-enrollment gate (Codex #2507 P1): enrollment
 * happens only when the audit artifact exists — PI metadata alone is a
 * signal that the box was ticked, but the snapshot row is the
 * authorization of record — and only when that row's copy version
 * actually authorizes recurring charges (v8+; legacy/implicit rows are
 * audit anchors, not authority).
 */
async function hasConsentFor(customerId, stripePaymentMethodId) {
  if (!customerId || !stripePaymentMethodId) return false;
  const rows = await db('payment_method_consents')
    .where({ customer_id: customerId, stripe_payment_method_id: stripePaymentMethodId })
    .select('consent_text_version');
  return rows.some((r) => consentVersionQualifiesForEnrollment(r.consent_text_version));
}

/**
 * The customer's best already-saved CARD carrying an enrollment-qualifying
 * (v8+) consent — the auto-satisfy source for card-on-file bookings (spec
 * §3.2: existing customers with a saved card are never re-asked). Card-only
 * by design (booking is card-only; ACH stays a portal action), default
 * first, newest first. Returns the payment_methods row or null; lookup
 * errors bubble so callers keep their own fail direction.
 */
async function findConsentedChargeableCard(customerId) {
  if (!customerId) return null;
  const rows = await db('payment_methods')
    .where({ customer_id: customerId, processor: 'stripe', method_type: 'card' })
    .whereNotNull('stripe_payment_method_id')
    .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'desc' }]);
  for (const pm of rows) {
     
    if (await hasConsentFor(customerId, pm.stripe_payment_method_id)) return pm;
  }
  return null;
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
  hasConsentFor,
  consentVersionQualifiesForEnrollment,
  findConsentedChargeableCard,
  linkPaymentMethodId,
  sweepOrphanConsents,
  VALID_SOURCES: Array.from(VALID_SOURCES),
};
