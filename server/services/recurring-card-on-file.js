/**
 * Recurring card-on-file: Auto Pay by default at accept.
 *
 * Owner decision 2026-07-12: the $49 recurring acceptance deposit under-protects
 * downside (exposure = every visit's invoice minus one first-visit credit), so
 * NEW recurring customers save a card at accept — ALONGSIDE the deposit, which
 * stays exactly as it is — and are enrolled in Auto Pay by default. Each
 * completed application then auto-charges the saved method through the existing
 * per-application completion collection (admin-dispatch) / monthly billing
 * rails; nothing here charges money itself.
 *
 * Deliberately mirrors the one-time card-hold pattern (estimate-card-holds.js):
 * a CUSTOMERLESS SetupIntent (the estimate may have no customer row until
 * acceptance creates one) captured in the accept UI, verified LIVE against
 * Stripe at accept — never trusted from the client — then attached post-commit.
 * Unlike the hold, there is no fee schedule and no hold row to freeze: the
 * saved card is a payment method, not a commitment device, so this module is
 * stateless — verification re-derives everything from the SetupIntent, and
 * enrollment runs the same save → consent → enroll sequence as the pay page's
 * /setup-complete (payment_method_consents row = the authorization artifact,
 * enrollConsentedMethod = the single enrollment semantics).
 *
 * DARK BY DEFAULT: enforced only when RECURRING_CARD_ON_FILE=true (rollout:
 * ship dark → land the capture UI → flip). Exemptions fail toward REQUIRING
 * the card (a card wrongly captured is harmless; a wrongly granted exemption
 * silently loses the protection) — EXCEPT the payer check, which fails toward
 * EXEMPT (Codex #2668 round-4 P1): a payer lookup outage must never conclude
 * "self-pay" and enroll the homeowner's card for invoices that route to a
 * third-party payer. A missed capture is a recoverable protection gap; a
 * wrong enrollment charges the wrong party.
 */

const db = require('../models/db');
const logger = require('./logger');
const StripeService = require('./stripe');

function isRecurringCardOnFileEnabled() {
  const flag = process.env.RECURRING_CARD_ON_FILE;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// What a recurring accept requires. Exempt lanes:
//  - one-time accepts (the card-hold lane owns those),
//  - invoice-mode (admin opted into manual/auto invoicing — its own billing
//    path, and commercial accepts live here),
//  - prepay-annual (the year is paid up front at accept; the pay page's
//    consent capture covers any later method-on-file need),
//  - existing plan customers (mirrors the deposit exemption: this protection
//    is for NEW recurring signups; members' billing behavior is established
//    — and many are already enrolled),
//  - payer-billed customers (invoices route to the third-party payer's AP
//    inbox; auto-charging the HOMEOWNER's card would collect from the wrong
//    party),
//  - customers already on Auto Pay with a chargeable method (nothing to add).
async function resolveRecurringCardPolicyForEstimate({
  estimate,
  membership = null,
  treatAsOneTime = false,
  billByInvoice = false,
  paymentMethodPreference = null,
  scheduledServiceId = null,
  useLinkedFallback = true,
} = {}) {
  if (!isRecurringCardOnFileEnabled()) {
    return { enforced: false, required: false, exemptReason: 'feature_disabled' };
  }
  if (treatAsOneTime) {
    return { enforced: true, required: false, exemptReason: 'one_time_card_hold_lane' };
  }
  if (billByInvoice) {
    return { enforced: true, required: false, exemptReason: 'invoice_mode' };
  }
  if (paymentMethodPreference === 'prepay_annual') {
    return { enforced: true, required: false, exemptReason: 'prepay_annual' };
  }

  // Existing plan customer — snapshot first, then the LIVE fallback the
  // deposit resolver uses (legacy customer-linked estimates have no
  // membershipSnapshot). A failed live check keeps the card required.
  let isPlanMember = !!membership?.isExistingCustomer;
  if (!isPlanMember && estimate?.customer_id) {
    try {
      const { loadExistingRecurringQualifyingRows } = require('./waveguard-existing-services');
      const rows = await loadExistingRecurringQualifyingRows(db, estimate.customer_id);
      isPlanMember = Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      logger.warn('[recurring-cof] live plan-customer check failed — card stays required', { error: err.message });
    }
  }
  if (isPlanMember) {
    return { enforced: true, required: false, exemptReason: 'existing_plan_customer' };
  }

  if (estimate?.customer_id) {
    // Payer-billed: match the eventual invoice's payer precedence
    // (scheduled_services.payer_id ?? customers.payer_id), scoped to the
    // appointment actually being accepted when the caller resolved one.
    // throwOnError — resolveForInvoice is fail-soft by default (returns
    // self-pay on a lookup outage), which would require + capture + enroll
    // the homeowner's card for a payer-billed account. An uncertain payer
    // state EXEMPTS the card instead (Codex #2668 round-4 P1).
    try {
      const PayerService = require('./payer');
      let linkedSsId = scheduledServiceId ? String(scheduledServiceId) : null;
      if (!linkedSsId && useLinkedFallback) {
        try {
          const gates = require('../routes/estimate-public');
          const appt = typeof gates.findLinkedUpcomingAppointment === 'function'
            ? await gates.findLinkedUpcomingAppointment(estimate)
            : null;
          linkedSsId = appt?.id ? String(appt.id) : null;
        } catch { /* scope narrowing only — customer-default still checked below */ }
      }
      const resolved = await PayerService.resolveForInvoice({ customerId: estimate.customer_id, scheduledServiceId: linkedSsId, throwOnError: true });
      if (resolved?.payerId) {
        return { enforced: true, required: false, exemptReason: 'payer_billed' };
      }
    } catch (err) {
      logger.warn('[recurring-cof] payer check failed — exempting card capture (never risk enrolling the wrong party)', { error: err.message });
      return { enforced: true, required: false, exemptReason: 'payer_check_uncertain' };
    }

    // Already protected: enrolled AND a chargeable method in charge.
    try {
      const { customerOnAutopay } = require('./autopay-eligibility');
      const customer = await db('customers').where({ id: estimate.customer_id }).first();
      if (customer && await customerOnAutopay(customer)) {
        return { enforced: true, required: false, exemptReason: 'autopay_already_active' };
      }
    } catch (err) {
      logger.warn('[recurring-cof] autopay-active check failed — card stays required', { error: err.message });
    }
  }

  return { enforced: true, required: true, exemptReason: null };
}

// Mint the SetupIntent that captures the Auto Pay card for a recurring accept.
// Deterministic idempotency key per (estimate, generation), so reopening the
// capture step within Stripe's idempotency window replays the SAME intent
// instead of stacking them; a succeeded replay short-circuits in the modal
// (retrieveSetupIntent → onSuccess). This module is stateless (no hold-row
// generation counter), so a TERMINAL-without-success replay (canceled — e.g.
// abandoned and swept) self-heals by walking the generation salt forward until
// Stripe returns a confirmable or succeeded intent (Codex #2668 P2: a fixed
// key would replay the dead intent for the whole idempotency window). Returns
// { clientSecret, setupIntentId } or null when Stripe isn't configured.
const MAX_SETUP_INTENT_GENERATIONS = 5;
async function createRecurringCardSetupIntentForEstimate(estimate) {
  for (let generation = 0; generation < MAX_SETUP_INTENT_GENERATIONS; generation += 1) {
    const setupIntent = await StripeService.createRecurringCardSetupIntent({ estimateId: estimate.id, generation });
    if (!setupIntent) return null;
    if (setupIntent.status === 'canceled') continue;
    return { clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id };
  }
  logger.error(`[recurring-cof] exhausted SetupIntent generations for estimate ${estimate.id} — all replays terminal`);
  return null;
}

// A live-retrieved SetupIntent counts only when Stripe says it succeeded, it
// carries a saved payment_method, AND its metadata pins it to THIS estimate
// as a recurring card-on-file capture (a one-time HOLD intent must never
// satisfy this gate — different consent, different semantics).
function recurringCardIntentMatchesEstimate(setupIntent, estimateId) {
  return !!setupIntent
    && setupIntent.status === 'succeeded'
    && setupIntent.metadata?.purpose === 'estimate_recurring_card'
    && String(setupIntent.metadata?.estimate_id) === String(estimateId)
    && !!setupIntent.payment_method;
}

// Accept GATE (pre-commit): live-verify the named SetupIntent WITHOUT writing.
// Trust is re-derived from Stripe, never the client. Stateless — the client
// echoes the id (or the 3DS redirect param restores it); there is no pending
// row to fall back on, and a lost id simply re-opens the capture modal, where
// the deterministic idempotency key replays the already-succeeded intent.
async function verifyRecurringCardIntent({ estimate, setupIntentId }) {
  if (!setupIntentId) return { ok: false, reason: 'no_setup_intent' };
  let setupIntent = null;
  try {
    setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
  } catch (err) {
    logger.warn('[recurring-cof] live SetupIntent verification failed', { error: err.message });
    return { ok: false, reason: 'verification_failed' };
  }
  if (!recurringCardIntentMatchesEstimate(setupIntent, estimate.id)) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  const pm = setupIntent.payment_method;
  return {
    ok: true,
    paymentMethodId: typeof pm === 'string' ? pm : pm.id,
    setupIntentId: setupIntent.id,
  };
}

// Post-commit: attach the captured card + record consent + enroll in Auto Pay.
// Runs the same idempotent save → consent → enrollment sequence as the pay
// page's /setup-complete, so the enrollment semantics can't drift between
// save surfaces. Best-effort by design: the accept (and its verified deposit)
// stands either way — a failure here parks an exception for the office
// (hands-off, exception-based) instead of blocking the booking.
async function completeRecurringCardEnrollment({
  customerId,
  stripePaymentMethodId,
  setupIntentId,
  estimateId,
  ip = null,
  userAgent = null,
}) {
  if (!customerId || !stripePaymentMethodId) return { enrolled: false, reason: 'missing_args' };
  try {
    // Idempotent save: stripe_payment_method_id is unique — a retry after a
    // partial first attempt must continue with the existing row.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePaymentMethodId }).first();
    if (saved && String(saved.customer_id) !== String(customerId)) {
      logger.warn(`[recurring-cof] pm ownership mismatch: pm ${stripePaymentMethodId} belongs to ${saved.customer_id}, accept customer ${customerId}`);
      await alertEnrollmentNeedsReview({ customerId, estimateId, reason: 'pm_ownership_mismatch' });
      return { enrolled: false, reason: 'pm_ownership_mismatch' };
    }
    if (!saved) {
      saved = await StripeService.savePaymentMethod(customerId, stripePaymentMethodId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision (claims it only
        // when no healthy method is already in charge).
        makeDefault: false,
      });
    }
    const ConsentService = require('./payment-method-consents');
    if (!(await ConsentService.hasConsentFor(customerId, stripePaymentMethodId))) {
      // The capture modal rendered the locked v8 card consent verbatim
      // (checkbox-gated) before confirmSetup — this row is the faithful
      // record of what the customer agreed to.
      await ConsentService.recordConsent({
        customerId,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId,
        source: 'estimate_accept',
        methodType: saved?.method_type || 'card',
        ip,
        userAgent,
      });
    }
    if (saved?.id) {
      await ConsentService.linkPaymentMethodId(stripePaymentMethodId, saved.id);
    }
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId,
      paymentMethodId: saved?.id,
      source: 'estimate_accept',
      details: { via: 'recurring_card_on_file', estimate_id: estimateId, setup_intent_id: setupIntentId },
    });
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      logger.warn(`[recurring-cof] enrollment refused (${enrollment.reason}) for customer ${customerId} pm ${saved?.id}`);
      await alertEnrollmentNeedsReview({ customerId, estimateId, reason: enrollment.reason });
      return { enrolled: false, reason: enrollment.reason };
    }
    logger.info(`[recurring-cof] customer ${customerId} card saved + Auto Pay enrolled at accept (estimate ${estimateId})`);
    return { enrolled: true, paymentMethodRowId: saved?.id || null };
  } catch (err) {
    logger.error(`[recurring-cof] enrollment failed post-accept for customer ${customerId}: ${err.message}`);
    await alertEnrollmentNeedsReview({ customerId, estimateId, reason: err.message });
    return { enrolled: false, reason: err.message };
  }
}

// Low-key office alert: the accept committed but the Auto Pay card didn't
// land — a human re-adds it (portal/admin) or calls the customer. Without
// this the gap would be silent until the first uncollected invoice.
async function alertEnrollmentNeedsReview({ customerId, estimateId, reason }) {
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      'Recurring accept: Auto Pay card not enrolled',
      `A recurring accept completed but the saved card could not be enrolled (${reason}) — re-add a payment method or the visits will invoice unprotected.`,
      { link: customerId ? `/admin/customers/${customerId}` : '/admin/dashboard', metadata: { customerId, estimateId, reason } },
    );
  } catch (e) { logger.warn('[recurring-cof] enrollment review alert failed', { error: e.message }); }
}

module.exports = {
  isRecurringCardOnFileEnabled,
  resolveRecurringCardPolicyForEstimate,
  createRecurringCardSetupIntentForEstimate,
  verifyRecurringCardIntent,
  completeRecurringCardEnrollment,
  _private: {
    recurringCardIntentMatchesEstimate,
  },
};
