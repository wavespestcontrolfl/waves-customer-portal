/**
 * Federal Form 1099-NEC / 1099-MISC reporting threshold for referral payouts.
 *
 * $600 for payments made through 2025. $2,000 for payments made in 2026
 * (One Big Beautiful Bill Act, section 70433, amending IRC 6041(a) for
 * payments after Dec 31, 2025). The $2,000 figure is inflation-indexed for
 * years after 2026: when the IRS publishes the 2027 amount, add a range here.
 * Until then 2027 and later use the 2026 amount.
 */

const FORM_1099_THRESHOLD_THROUGH_2025_CENTS = 60000;
const FORM_1099_THRESHOLD_FROM_2026_CENTS = 200000;

function form1099ThresholdCents(taxYear) {
  const year = taxYear == null || taxYear === '' ? NaN : Number(taxYear);
  if (!Number.isFinite(year)) {
    throw new Error(`form1099ThresholdCents needs a tax year, got ${taxYear}`);
  }
  return year >= 2026 ? FORM_1099_THRESHOLD_FROM_2026_CENTS : FORM_1099_THRESHOLD_THROUGH_2025_CENTS;
}

module.exports = {
  form1099ThresholdCents,
  FORM_1099_THRESHOLD_THROUGH_2025_CENTS,
  FORM_1099_THRESHOLD_FROM_2026_CENTS,
};
