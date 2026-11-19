// client/src/lib/taurus-yearly-limit.js
//
// Taurus SC (EPA 53883-279) allows the 0.03% perimeter pest rate on up to 4
// applications per home per calendar year (owner ruling 2026-11-19, "A").
// The server counts this home's Taurus visits so far this year
// (server/services/taurus-yearly-count.js) and sends `taurusYearly:
// { count, limit, year }` with the close-out's product context. This module
// turns that count into: the house mix without Taurus once a home is at the
// limit, a plain line saying so, and a warning when Taurus is added back.
//
// It filters the selections pestDefaultMixSelections returns, by product name;
// pest-default-mix.js stays the one place that names the house mix.
// An unknown count (null, a failed request, no home) changes nothing, and
// nothing here blocks a save.

export const TAURUS_YEARLY_LIMIT = 4;

const TAURUS_RE = /^taurus\s*sc\b/i;

export const isTaurusProduct = (product) => TAURUS_RE.test(String(product?.name || product?.product_name || product?.productName || '').trim());

// The count from the server's `taurusYearly` object; null when unknown.
export function taurusYearlyCountOf(taurusYearly) {
  const count = taurusYearly?.count;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

const atLimit = (count) => Number.isInteger(count) && count >= TAURUS_YEARLY_LIMIT;

// pestDefaultMixSelections(...) rows, minus Taurus SC once the home is at the limit.
export function applyTaurusYearlyLimit(selections, count) {
  const list = Array.isArray(selections) ? selections : [];
  return atLimit(count) ? list.filter(({ product }) => !isTaurusProduct(product)) : list;
}

// The line under the house mix when Taurus was left out; null otherwise.
export function taurusLeftOutLine(count) {
  return atLimit(count)
    ? `Taurus left out: ${count} of ${TAURUS_YEARLY_LIMIT} this year at this home (label limit).`
    : null;
}

// The warning when Taurus is on the list although the home is at the limit; null otherwise.
// `products` are the selected product rows or catalog entries, in any shape isTaurusProduct reads.
export function taurusOverLimitWarning(count, products) {
  if (!atLimit(count)) return null;
  const list = Array.isArray(products) ? products : [];
  if (!list.some((p) => p && isTaurusProduct(p))) return null;
  return `${count + 1}${ordinalSuffix(count + 1)} Taurus this year at this home: over the label's ${TAURUS_YEARLY_LIMIT}.`;
}

function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
}

// The one note a close-out shows: the warning when Taurus is selected, else the
// left-out line, else null (count under the limit or unknown).
export function taurusYearlyNote(count, selectedProducts) {
  return taurusOverLimitWarning(count, selectedProducts) || taurusLeftOutLine(count);
}
