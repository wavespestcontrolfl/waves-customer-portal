// The LESCO 13-0-13 bed fertilizer is held to the county cap of 0.75 lb per 100 sq ft = 7.5 lb per 1,000 sq ft. Both Tree & Shrub
// completion forms (the full form in SchedulePage.jsx and Fast Complete) warn before submit with the same rule the server's
// closeout check uses (server/services/tree-shrub-ornamental-fertilizer-limits.js ratePer1000).
export const BED_FEED_CAP_LB_PER_1000 = 7.5;
const LB_PER_UNIT = { lb: 1, lbs: 1, oz: 1 / 16, g: 1 / 453.592, kg: 2.20462 };

// The 13-0-13 rate in lb per 1,000 sq ft: the entered lb rate and the total over the treated area (the protocol row starts with
// no rate, so a total plus area is the common entry); the higher reading wins, since an overridden total can exceed the entered
// rate. oz and g are converted to lb. null when neither can be read. Reads `rate`, `rateUnit`, `totalAmount`, `amountUnit`,
// `areaValue` and `areaUnit` (sq ft when absent).
export function bedFeedRatePer1000(product) {
  const rate = Number(product?.rate);
  const rateUnit = String(product?.rateUnit || 'lb').toLowerCase().replace(/\/.*$/, '');
  const fromRate = product?.rate !== '' && product?.rate != null && Number.isFinite(rate) && rate > 0 && LB_PER_UNIT[rateUnit]
    ? rate * LB_PER_UNIT[rateUnit] : null;
  const total = Number(product?.totalAmount);
  const area = Number(product?.areaValue);
  const amountUnit = String(product?.amountUnit || 'lb').toLowerCase();
  const fromTotal = Number.isFinite(total) && total > 0 && Number.isFinite(area) && area > 0 && LB_PER_UNIT[amountUnit]
    && (!product?.areaUnit || product.areaUnit === 'sqft')
    ? (total * LB_PER_UNIT[amountUnit] * 1000) / area : null;
  if (fromRate === null) return fromTotal;
  return fromTotal === null ? fromRate : Math.max(fromRate, fromTotal);
}

// The non-blocking pre-submit line, or null when the rate cannot be read or is at or under the county limit.
export function bedFeedCountyLimitLine(name, rate) {
  if (rate === null || rate === undefined || Math.round(rate * 100) / 100 <= BED_FEED_CAP_LB_PER_1000) return null;
  return `${name || 'Selected product'} rate ${Math.round(rate * 100) / 100} lb/1k is over the county limit of ${BED_FEED_CAP_LB_PER_1000} lb/1k (0.75 lb per 100 sq ft). It will be recorded and the office will review it.`;
}
