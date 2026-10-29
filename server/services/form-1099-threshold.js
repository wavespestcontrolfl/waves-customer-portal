/**
 * Federal Form 1099-NEC / 1099-MISC reporting threshold: the one rule behind
 * the tax worksheets (necThreshold) and the referral payout flag
 * (requires_1099).
 *
 * $600 for payments made through 2025. $2,000 for payments made in 2026
 * (One Big Beautiful Bill Act, section 70433, P.L. 119-21, amending IRC
 * 6041(a) for payments after Dec 31, 2025). The $2,000 figure is
 * inflation-indexed for years after 2026: when the IRS publishes the 2027
 * amount, add a range here. Until then 2027 and later use the 2026 amount.
 */

const THRESHOLD_THROUGH_2025_DOLLARS = 600;
const THRESHOLD_FROM_2026_DOLLARS = 2000;

const form1099ThresholdDollars = (taxYear) => (taxYear >= 2026 ? THRESHOLD_FROM_2026_DOLLARS : THRESHOLD_THROUGH_2025_DOLLARS);

// Same rule in cents, for money columns. A missing year throws instead of
// silently falling back to the old $600.
function form1099ThresholdCents(taxYear) {
  const year = taxYear == null || taxYear === '' ? NaN : Number(taxYear);
  if (!Number.isFinite(year)) {
    throw new Error(`form1099ThresholdCents needs a tax year, got ${taxYear}`);
  }
  return form1099ThresholdDollars(year) * 100;
}

module.exports = { form1099ThresholdDollars, form1099ThresholdCents };
