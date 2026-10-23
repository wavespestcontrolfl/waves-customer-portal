// The LESCO 13-0-13 bed fertilizer is held to the county cap of 0.75 lb per 100 sq ft = 7.5 lb per 1,000 sq ft. Both Tree & Shrub
// completion forms (the full form in SchedulePage.jsx and Fast Complete) warn before submit with the same rule the server's
// closeout check uses (server/services/tree-shrub-ornamental-fertilizer-limits.js ratePer1000).
export const BED_FEED_CAP_LB_PER_1000 = 7.5;
const LB_PER_UNIT = { lb: 1, lbs: 1, oz: 1 / 16, g: 1 / 453.592, kg: 2.20462 };

// A finite number above zero, else null ('' and null are not zero-ish numbers here, they are missing).
const positive = (value) => {
  const number = value === '' || value === null ? NaN : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
// The pounds in one unit of a weight unit ('lb' when unset); a per-basis suffix ('lb/1000sf') is dropped. undefined for a non-weight unit.
const poundsPer = (unit) => LB_PER_UNIT[String(unit || 'lb').toLowerCase().replace(/\/.*$/, '')];

// The 13-0-13 rate in lb per 1,000 sq ft: the entered rate and the total over the treated area (the protocol row starts with
// no rate, so a total plus area is the common entry); the higher reading wins, since an overridden total can exceed the entered
// rate. oz and g are converted to lb. null when neither can be read. Reads `rate`, `rateUnit`, `totalAmount`, `amountUnit`,
// `areaValue` and `areaUnit` (sq ft when absent).
export function bedFeedRatePer1000(product = {}) {
  const rate = positive(product.rate);
  const total = positive(product.totalAmount);
  const area = positive(product.areaValue);
  const rateFactor = poundsPer(product.rateUnit);
  const totalFactor = poundsPer(product.amountUnit);
  const inSqft = !product.areaUnit || product.areaUnit === 'sqft';
  const readings = [
    rate && rateFactor ? rate * rateFactor : null,
    total && area && totalFactor && inSqft ? (total * totalFactor * 1000) / area : null,
  ].filter((reading) => reading !== null);
  return readings.length ? Math.max(...readings) : null;
}

// The non-blocking pre-submit line, or null when the rate cannot be read or is at or under the county limit.
export function bedFeedCountyLimitLine(name, rate) {
  if (rate === null || rate === undefined || Math.round(rate * 100) / 100 <= BED_FEED_CAP_LB_PER_1000) return null;
  return `${name || 'Selected product'} rate ${Math.round(rate * 100) / 100} lb/1k is over the county limit of ${BED_FEED_CAP_LB_PER_1000} lb/1k (0.75 lb per 100 sq ft). It will be recorded and the office will review it.`;
}
