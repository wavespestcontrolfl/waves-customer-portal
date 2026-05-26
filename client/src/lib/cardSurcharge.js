// Mirror of server/services/stripe-pricing.js surcharge helpers.
//
// Phase 1: 3% surcharge on confirmed credit cards only.
// Debit, prepaid, unknown-funding, and ACH = no surcharge.

const DEFAULT_CARD_SURCHARGE_RATE = 0.03;

export function shouldSurcharge(funding) {
  return funding === 'credit';
}

export function computeCardTotal(amountDollars, rate = DEFAULT_CARD_SURCHARGE_RATE) {
  const base = Math.round(Number(amountDollars) * 100) / 100;
  const surcharge = Math.round(base * rate * 100) / 100;
  const total = Math.round((base + surcharge) * 100) / 100;
  return { base, surcharge, total };
}
