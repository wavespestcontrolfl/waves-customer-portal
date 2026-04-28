// Mirror of server/services/stripe.js → computeChargeAmount.
//
// Why a helper: AGENTS.md flags ad-hoc `* 1.0399` math as a
// reconciliation hazard. Single-step rounding (amount × 1.0399, round
// once) drifts a cent vs the server's two-step rounding for some
// invoice totals (e.g. $450, $750) because `1.0399` and `0.0399` round
// differently in IEEE 754. Use this helper anywhere the client previews
// a card-surcharged total so it matches what Stripe will be charged.
//
// Returns { base, surcharge, total } in dollars, all already rounded to
// the cent — same shape as the server helper.

const DEFAULT_CARD_SURCHARGE_RATE = 0.0399;

export function computeCardTotal(amountDollars, rate = DEFAULT_CARD_SURCHARGE_RATE) {
  const base = Math.round(Number(amountDollars) * 100) / 100;
  const surcharge = Math.round(base * rate * 100) / 100;
  const total = Math.round((base + surcharge) * 100) / 100;
  return { base, surcharge, total };
}
