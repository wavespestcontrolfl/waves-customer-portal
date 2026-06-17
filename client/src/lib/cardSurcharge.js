// Mirror of server/services/stripe-pricing.js surcharge helpers.
//
// Phase 1: 2.9% surcharge on confirmed credit cards only.
// Debit, prepaid, unknown-funding, and ACH = no surcharge.
// Mirror of stripe-pricing.js CONFIGURED_COST_BPS (290 bps) — keep in sync.

export const DEFAULT_CARD_SURCHARGE_RATE = 0.029;

export function shouldSurcharge(funding) {
  return funding === 'credit';
}

export function computeCardTotal(amountDollars, options = {}) {
  const opts = typeof options === 'number' ? { rate: options, funding: 'credit' } : options;
  const rate = opts.rate ?? DEFAULT_CARD_SURCHARGE_RATE;
  const baseCents = Math.round(Number(amountDollars || 0) * 100);
  const surchargeCents = shouldSurcharge(opts.funding)
    ? Math.floor(baseCents * rate)
    : 0;
  const totalCents = baseCents + surchargeCents;

  return {
    base: baseCents / 100,
    surcharge: surchargeCents / 100,
    total: totalCents / 100,
  };
}
