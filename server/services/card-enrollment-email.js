/**
 * Card-enrollment confirmation emails (owner directive 2026-07-13, from
 * the Auto Pay authorization-form question): give the customer a COPY of
 * the card authorization they just granted — card-network stored-
 * credential guidance recommends delivering the agreement at enrollment.
 *
 *   sendAutopayEnrollmentConfirmation — fired from enrollConsentedMethod
 *     on a FRESH enrollment (never already_enrolled): the exact locked
 *     consent text (per method type) rides as {{authorization_text}}.
 *   sendCardHoldConfirmation — fired post-commit from the one-time accept:
 *     visit-scoped terms with the fee line composed from the FROZEN
 *     hold-row values (no_show_fee_amount / cancel_window_hours), never
 *     live config — the email must match what the customer was shown.
 *
 * GATED OFF by default: nothing sends unless GATE_CARD_ENROLLMENT_EMAILS
 * === 'true' (owner flips — customer comms are owner-authorized only).
 * Best-effort by contract: callers fire-and-forget; a template/SendGrid
 * failure never affects enrollment or the accept. Idempotent per
 * (customer, method) / per estimate, so webhook-backstop re-runs and
 * accept retries can't double-send.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getConsentText } = require('./payment-method-consent-text');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const BILLING_EMAIL = 'billing@wavespestcontrol.com';

function emailsEnabled() {
  return process.env.GATE_CARD_ENROLLMENT_EMAILS === 'true';
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// "your Visa ending 4242" — degrades to a generic line when the mirror row
// hasn't landed yet (the Stripe attach is post-commit best-effort).
function cardLineFor(pm) {
  const brand = clean(pm?.card_brand);
  const last4 = clean(pm?.last_four);
  if (brand && last4) return `your ${brand.charAt(0).toUpperCase()}${brand.slice(1)} ending ${last4}`;
  if (last4) return `your card ending ${last4}`;
  return 'your card on file';
}

async function loadCustomerEmail(customerId) {
  const customer = await db('customers')
    .where({ id: customerId })
    .first('id', 'first_name', 'email');
  const email = clean(customer?.email);
  if (!email || !email.includes('@')) return { customer: null, email: null };
  return { customer, email };
}

async function sendAutopayEnrollmentConfirmation({ customerId, paymentMethodRowId } = {}) {
  try {
    if (!emailsEnabled() || !customerId || !paymentMethodRowId) return null;
    const { customer, email } = await loadCustomerEmail(customerId);
    if (!customer) {
      logger.info(`[card-enrollment-email] no usable email for customer ${customerId}; skipping autopay confirmation`);
      return null;
    }
    const pm = await db('payment_methods')
      .where({ id: paymentMethodRowId, customer_id: customerId })
      .first('id', 'stripe_payment_method_id', 'card_brand', 'last_four', 'method_type');
    // CARD-ONLY template (Codex #2698 r1): an ACH/bank enrollment reaching
    // this hook (pay-page saves already support us_bank_account) would get
    // "your card is charged" wording over the ACH debit authorization —
    // wrong on both counts. The bank variant ships with the scoped portal
    // ACH lane (its own owner-approved template); skip it here.
    const methodType = clean(pm?.method_type || 'card').toLowerCase();
    if (pm && methodType !== 'card') {
      logger.info(`[card-enrollment-email] non-card method (${methodType}) for customer ${customerId}; autopay confirmation skipped (card template only)`);
      return null;
    }
    // The customer's copy must be the EXACT text they agreed to — the
    // STORED ledger snapshot, not whatever copy is deployed at send time
    // (a consent-version wording bump must never rewrite history —
    // Codex #2698 r1). getConsentText is only the fallback for a missing
    // row (shouldn't happen: recordConsent precedes enrollment).
    let authorizationText = null;
    let consentRowId = null;
    if (pm?.stripe_payment_method_id) {
      const consentRow = await db('payment_method_consents')
        .where({ customer_id: customerId, stripe_payment_method_id: pm.stripe_payment_method_id })
        .orderBy('created_at', 'desc')
        .first('id', 'consent_text_snapshot');
      authorizationText = clean(consentRow?.consent_text_snapshot) || null;
      consentRowId = consentRow?.id || null;
    }
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'autopay.enrollment_confirmation',
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        card_line: cardLineFor(pm),
        authorization_text: authorizationText || getConsentText('card'),
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: BILLING_EMAIL,
      },
      recipientType: 'customer',
      recipientId: customerId,
      // Keyed on the CONSENT ROW, not just (customer, method) — Codex
      // #2698 r2: an opt-out keeps the payment_methods row, and a later
      // re-authorization of the SAME card is a NEW agreement that owes a
      // fresh copy (possibly with updated consent text). Backstop re-runs
      // of the SAME enrollment still read the same newest consent row →
      // same key → deduped.
      idempotencyKey: `autopay.enrollment_confirmation:${customerId}:${paymentMethodRowId}:${consentRowId || 'noconsent'}`,
      triggerEventId: `autopay.enrollment_confirmation:${customerId}:${paymentMethodRowId}:${consentRowId || 'noconsent'}`,
      categories: ['autopay_enrollment_confirmation'],
      suppressProviderErrorLog: true,
    });
    logger.info(`[card-enrollment-email] autopay confirmation sent for customer ${customerId}`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[card-enrollment-email] autopay confirmation failed for customer ${customerId}: ${reason}`);
    return null;
  }
}

async function sendCardHoldConfirmation({ estimateId, customerId } = {}) {
  try {
    if (!emailsEnabled() || !estimateId || !customerId) return null;
    const { customer, email } = await loadCustomerEmail(customerId);
    if (!customer) {
      logger.info(`[card-enrollment-email] no usable email for customer ${customerId}; skipping card-hold confirmation`);
      return null;
    }
    // FROZEN terms from the hold row — the same values the customer was
    // shown and recordCardHoldHeld persisted; live config must never move
    // the fee/window this email states.
    const hold = await db('estimate_card_holds')
      .where({ estimate_id: estimateId, status: 'held' })
      .orderBy('created_at', 'desc')
      .first('no_show_fee_amount', 'cancel_window_hours', 'stripe_payment_method_id');
    if (!hold) {
      logger.info(`[card-enrollment-email] no held row for estimate ${estimateId}; skipping card-hold confirmation`);
      return null;
    }
    const pm = hold.stripe_payment_method_id
      ? await db('payment_methods')
        .where({ customer_id: customerId, stripe_payment_method_id: hold.stripe_payment_method_id })
        .first('card_brand', 'last_four')
      : null;
    const fee = Number(hold.no_show_fee_amount);
    const windowHours = Number(hold.cancel_window_hours);
    const feeLine = Number.isFinite(fee) && fee > 0 && Number.isFinite(windowHours) && windowHours > 0
      ? `A $${fee.toFixed(2)} fee applies only if you cancel within ${windowHours} hours of your visit or we cannot get access.`
      : 'No fee applies unless we cannot complete your visit.';
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'cardhold.confirmation',
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        card_line: cardLineFor(pm),
        fee_line: feeLine,
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: BILLING_EMAIL,
      },
      recipientType: 'customer',
      recipientId: customerId,
      idempotencyKey: `cardhold.confirmation:${estimateId}`,
      triggerEventId: `cardhold.confirmation:${estimateId}`,
      categories: ['cardhold_confirmation'],
      suppressProviderErrorLog: true,
    });
    logger.info(`[card-enrollment-email] card-hold confirmation sent for estimate ${estimateId}`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[card-enrollment-email] card-hold confirmation failed for estimate ${estimateId}: ${reason}`);
    return null;
  }
}

module.exports = {
  sendAutopayEnrollmentConfirmation,
  sendCardHoldConfirmation,
  _private: { cardLineFor, emailsEnabled },
};
