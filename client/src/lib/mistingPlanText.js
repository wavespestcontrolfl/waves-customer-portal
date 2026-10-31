import { fmtMoney } from './money';

// The refill line the misting plan card and the estimate PDF both print (owner 2026-10-30, item D), from the section's
// customer-safe `refill` ({ label, perFill, refillsPerYear }): "Refills, Standard solution: $129.00 each. Billed when we
// refill the tank. We expect about 4 a year." The last sentence is left out when no yearly count is known (0 or missing).
// Null without a refill price, so nothing prints for an estimate with no misting plan.
export function mistingRefillLine(refill) {
  const perFill = Number(refill?.perFill);
  if (!(perFill > 0)) return null;
  const label = String(refill?.label || '').trim() || 'Standard solution';
  const perYear = Number(refill?.refillsPerYear);
  const expected = Number.isInteger(perYear) && perYear > 0 ? ` We expect about ${perYear} a year.` : '';
  return `Refills, ${label}: ${fmtMoney(perFill)} each. Billed when we refill the tank.${expected}`;
}
