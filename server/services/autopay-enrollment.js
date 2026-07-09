// Shared consent-gated autopay enrollment.
//
// One routine, three call sites (stripe-webhook save-card mirror, the pay
// page's /consent + /setup-complete endpoints, and the portal add-card
// route), so the enrollment semantics can't drift between save surfaces
// (Codex #2507): a saved method is enrolled in Auto Pay only when an
// immutable payment_method_consents row EXISTS for it — the consent row is
// the authorization artifact, never PI metadata alone.
//
// Semantics (extracted verbatim from the stripe-webhook mirror, rounds 2-11):
//  - The incumbent = the customer's default + autopay-enabled chargeable
//    Stripe row. An incumbent bank method (either alias: 'ach' /
//    'us_bank_account') does NOT count while customers.ach_status is
//    non-empty and not 'active' — collection refuses it, so deferring to it
//    would point the customer at a method that never charges.
//  - The target row gets autopay_enabled=true. It claims is_default only
//    when there is no healthy incumbent (unsetting other rows' is_default
//    first); a healthy incumbent keeps the default role.
//  - customers.autopay_enabled flips true and autopay_payment_method_id
//    points at whichever method is actually in charge (incumbent || target).
//  - Logged as autopay_enabled with the caller's source tag. Skipped when
//    the customer is already enrolled on the same method (idempotent — the
//    /consent endpoint and the webhook may both complete the same signup).
const db = require('../models/db');
const logger = require('./logger');

const BANK_ALIASES = ['ach', 'us_bank_account'];

/**
 * Enroll an already-saved payment method in autopay. The CALLER is
 * responsible for the consent gate (a payment_method_consents row must
 * exist / have just been recorded) and for ownership checks on how the
 * method row was resolved.
 *
 * @param {object} opts
 * @param {string} opts.customerId
 * @param {string} [opts.paymentMethodId]        payment_methods.id of the target row
 * @param {string} [opts.stripePaymentMethodId]  alternative lookup key
 * @param {string} opts.source                   autopay_log source tag
 * @param {object} [opts.details]                extra autopay_log details
 * @returns {{ enrolled: boolean, reason?: string, methodId?: string, inChargeMethodId?: string }}
 */
async function enrollConsentedMethod({ customerId, paymentMethodId, stripePaymentMethodId, source, details = {} }) {
  if (!customerId || (!paymentMethodId && !stripePaymentMethodId)) {
    return { enrolled: false, reason: 'missing_args' };
  }
  const targetQuery = db('payment_methods').where({ customer_id: customerId, processor: 'stripe' });
  if (paymentMethodId) targetQuery.where({ id: paymentMethodId });
  else targetQuery.where({ stripe_payment_method_id: stripePaymentMethodId });
  const target = await targetQuery.whereNotNull('stripe_payment_method_id').first();
  if (!target) return { enrolled: false, reason: 'method_not_found' };

  // The customer-level ACH block applies to the TARGET too, not just the
  // incumbent (Codex #2507 round-5 P2): while ach_status is
  // needs_verification/suspended, customerOnAutopay refuses every non-card
  // method, so enrolling a fresh bank account would flip the flags onto a
  // method collection keeps rejecting. The method stays saved
  // card-on-file; enrollment happens through the normal surfaces once the
  // bank state clears.
  const achUnhealthy = async () => {
    const achRow = await db('customers').where({ id: customerId }).first('ach_status');
    return !!(achRow?.ach_status && achRow.ach_status !== 'active');
  };
  if (BANK_ALIASES.includes(target.method_type) && (await achUnhealthy())) {
    return { enrolled: false, reason: 'ach_blocked', methodId: target.id };
  }

  let incumbent = await db('payment_methods')
    .where({
      customer_id: customerId,
      processor: 'stripe',
      is_default: true,
      autopay_enabled: true,
    })
    .whereNotNull('stripe_payment_method_id')
    .first('id', 'method_type');
  if (BANK_ALIASES.includes(incumbent?.method_type) && (await achUnhealthy())) {
    incumbent = null;
  }

  const alreadyInCharge = incumbent && incumbent.id === target.id;
  const custRow = await db('customers').where({ id: customerId }).first('autopay_enabled', 'autopay_payment_method_id');
  if (alreadyInCharge && custRow?.autopay_enabled && custRow?.autopay_payment_method_id === target.id) {
    return { enrolled: false, reason: 'already_enrolled', methodId: target.id, inChargeMethodId: target.id };
  }

  if (!incumbent) {
    // No healthy method in charge — the target takes the default slot.
    await db('payment_methods')
      .where({ customer_id: customerId })
      .whereNot({ id: target.id })
      .update({ is_default: false });
    await db('payment_methods')
      .where({ id: target.id })
      .update({ autopay_enabled: true, is_default: true });
  } else if (!alreadyInCharge) {
    // A healthy incumbent keeps the default role; the target is enrolled
    // but does not displace it.
    await db('payment_methods')
      .where({ id: target.id })
      .update({ autopay_enabled: true });
  }

  const inChargeMethodId = incumbent ? incumbent.id : target.id;
  await db('customers')
    .where({ id: customerId })
    .update({ autopay_enabled: true, autopay_payment_method_id: inChargeMethodId });
  try {
    await require('./autopay-log').logAutopay(customerId, 'autopay_enabled', {
      paymentMethodId: inChargeMethodId,
      details: { source, ...details },
    });
  } catch (logErr) {
    logger.warn(`[autopay-enrollment] log failed for customer ${customerId}: ${logErr.message}`);
  }
  logger.info(`[autopay-enrollment] customer ${customerId} enrolled (source=${source}, method=${inChargeMethodId})`);
  return { enrolled: true, methodId: target.id, inChargeMethodId };
}

module.exports = { enrollConsentedMethod };
