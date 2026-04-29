/**
 * Stripe pricing helpers — pure, dependency-free, test-friendly.
 *
 * The 3.99% credit-card surcharge math lives here so it can be exercised
 * without loading the Stripe SDK or any DB. Both server/services/stripe.js
 * and the audit unit tests import from this module — there is one copy
 * of the surcharge logic in the codebase.
 *
 * If you change CARD_SURCHARGE_RATE you MUST also bump the consent
 * version (server/services/payment-method-consent-text.js) so old
 * "save card" rows stay anchored to the rate the customer agreed to.
 */

const CARD_SURCHARGE_RATE = 0.0399;

// Accepts a stored payment_methods.method_type ('card' | 'ach') OR a
// Stripe Payment Element type ('card' | 'us_bank_account' | 'apple_pay'
// | 'google_pay' | 'link'). Anything we don't explicitly recognize as
// ACH is treated as card-family and surcharged — we'd rather over-collect
// on a future Stripe method (Klarna, Affirm, Cash App) than silently lose
// 3.99% on every transaction until someone notices.
function isCardMethodType(methodType) {
  if (!methodType) return false;
  const m = String(methodType).toLowerCase();
  if (m === 'ach' || m === 'us_bank_account' || m === 'bank' || m === 'bank_account') return false;
  return true;
}

function computeChargeAmount(baseAmountDollars, methodType) {
  const base = Math.round(Number(baseAmountDollars) * 100) / 100;
  if (!isCardMethodType(methodType)) {
    return { base, surcharge: 0, total: base };
  }
  const surcharge = Math.round(base * CARD_SURCHARGE_RATE * 100) / 100;
  const total = Math.round((base + surcharge) * 100) / 100;
  return { base, surcharge, total };
}

module.exports = {
  CARD_SURCHARGE_RATE,
  isCardMethodType,
  computeChargeAmount,
};
