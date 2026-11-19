// client/src/lib/taurus-yearly-limit.js
//
// Taurus SC (EPA 53883-279) has a yearly label limit at each home: the 0.03%
// perimeter rate on up to 4 applications, fewer when a 0.06% application was
// used (owner ruling 2026-11-19, "A": the house mix is 1.6 fl oz per 4 gal,
// 0.03%). The server reads the compliance ledger
// (server/services/taurus-yearly-count.js) and sends
// `taurusYearly: { high, low, count, eligible, year }` with the close-out's
// product context, where `eligible` says whether another 0.03% application
// fits. This module turns that into: the house mix without Taurus when it does
// not fit, a plain line saying so, and a warning when Taurus is added back.
//
// It filters the selections pestDefaultMixSelections returns, by product name;
// pest-default-mix.js stays the one place that names the house mix.
// An UNKNOWN answer (null, a failed request, no home) leaves Taurus out too
// (Codex P1: never default an application whose label eligibility is not
// known); the line says so and the tech adds it by hand. Nothing here blocks
// a save.

const TAURUS_RE = /^taurus\s*sc\b/i;

export const isTaurusProduct = (product) => TAURUS_RE.test(String(product?.name || product?.product_name || product?.productName || '').trim());

// The server's `taurusYearly` object when it answers whether another application fits; null when unknown.
export function taurusYearlyOf(taurusYearly) {
  return typeof taurusYearly?.eligible === 'boolean' ? taurusYearly : null;
}

const known = (taurusYearly) => taurusYearlyOf(taurusYearly) !== null;
const exhausted = (taurusYearly) => known(taurusYearly) && taurusYearly.eligible === false;

// pestDefaultMixSelections(...) rows, minus Taurus SC unless the home is known to have room under the label.
export function applyTaurusYearlyLimit(selections, taurusYearly) {
  const list = Array.isArray(selections) ? selections : [];
  return known(taurusYearly) && taurusYearly.eligible ? list : list.filter(({ product }) => !isTaurusProduct(product));
}

const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home has had fewer than 4 this year.";

// The line under the house mix when Taurus was left out; null when the answer says it stays.
export function taurusLeftOutLine(taurusYearly) {
  if (!known(taurusYearly)) return UNKNOWN_LINE;
  return exhausted(taurusYearly)
    ? `Taurus left out: this home reached the label's yearly limit (${taurusYearly.count} this year).`
    : null;
}

// The warning when Taurus is on the list although the home has no room under the label; null otherwise.
// `products` are the selected product rows or catalog entries, in any shape isTaurusProduct reads.
export function taurusOverLimitWarning(taurusYearly, products) {
  if (!exhausted(taurusYearly)) return null;
  const list = Array.isArray(products) ? products : [];
  return list.some((p) => p && isTaurusProduct(p)) ? "Over the label's yearly Taurus limit at this home." : null;
}

// The one note a close-out shows: the warning when Taurus is selected over the limit, else, on a visit that
// opens on the house mix (`mixVisit`) with Taurus not selected, the left-out line; else null.
export function taurusYearlyNote(taurusYearly, selectedProducts, { mixVisit = false } = {}) {
  const warning = taurusOverLimitWarning(taurusYearly, selectedProducts);
  if (warning) return warning;
  const list = Array.isArray(selectedProducts) ? selectedProducts : [];
  return mixVisit && !list.some((p) => p && isTaurusProduct(p)) ? taurusLeftOutLine(taurusYearly) : null;
}
