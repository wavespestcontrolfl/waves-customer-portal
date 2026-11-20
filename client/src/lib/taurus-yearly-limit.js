// client/src/lib/taurus-yearly-limit.js
//
// Taurus SC (EPA 53883-279) has a yearly label limit at each home: the 0.03%
// perimeter rate on up to 4 applications, fewer when a 0.06% application was
// used (owner ruling 2026-11-19, "A": the house mix is 1.6 fl oz per 4 gal,
// 0.03%). The server reads the compliance ledger
// (server/services/taurus-yearly-count.js) and sends
// `taurusYearly: { high, low, count, eligible, eligibleHigh, year, beforeRuling }` with the
// close-out's product context, where `eligible` says whether another 0.03%
// application fits and `eligibleHigh` whether another 0.06% one does. This module turns that into: the house mix without Taurus when it does
// not fit, a plain line saying so, and a warning when Taurus is added back.
//
// It filters the selections pestDefaultMixSelections returns, by product name;
// pest-default-mix.js stays the one place that names the house mix.
// An UNKNOWN answer (null, a failed request, no home) leaves Taurus out too
// (Codex P1: never default an application whose label eligibility is not
// known); the line says so and the tech adds it by hand. Nothing here blocks
// a save.

import {
  LOW_RATE_MAX_FL_OZ_PER_GAL, TAURUS_LOW_RATE_SINCE, flOzAmount, isFlOzPerGalUnit, isHouseTaurusFlOz, taurusConcentration,
} from '@taurus-concentration';
const TAURUS_RE = /^taurus\s*sc\b/i;

export const isTaurusProduct = (product) => TAURUS_RE.test(String(product?.name || product?.product_name || product?.productName || '').trim());

// The server's `taurusYearly` object when it answers whether another application fits; null when unknown.
export function taurusYearlyOf(taurusYearly) {
  return typeof taurusYearly?.eligible === 'boolean' ? taurusYearly : null;
}

const known = (taurusYearly) => taurusYearlyOf(taurusYearly) !== null;
const exhausted = (taurusYearly) => known(taurusYearly) && taurusYearly.eligible === false;

// The house mix's Taurus concentration: 1.6 fl oz in the 4-gal FlowZone = 0.4 fl oz/gal (0.03%).
export const HOUSE_FL_OZ_PER_GAL = LOW_RATE_MAX_FL_OZ_PER_GAL;
// A per-gallon fl oz unit (the house Taurus row's seed applies only in "fl_oz/gal" / "oz/gal").
export const isFlOzPerGal = isFlOzPerGalUnit;
// Whether a row's amount is the house mix's 1.6 fl oz (tsp, gal and mL converted; a unitless amount reads as fl oz).
export const isHouseTaurusAmount = (totalAmount, amountUnit) => isHouseTaurusFlOz(flOzAmount(totalAmount, amountUnit, { nullUnitIsFlOz: true }));
// A selected row that is a 0.06% application, by the rule the yearly count applies to the saved ledger row
// (shared/taurus-concentration.cjs): its dilution, else its per-gallon rate, else its amount against the
// 1.6 fl oz house mix. A reopened recap's recorded row carries the ledger's dilution and application date; a row
// being entered is dated by `beforeRuling` (the server's `taurusYearly.beforeRuling`: the visit may be dated before
// the 0.03% ruling).
export const isHighTaurusRate = (row, { beforeRuling = false } = {}) => taurusConcentration({
  dilution: row?.dilution,
  rate: row?.rate,
  rateUnit: row?.rateUnit,
  amount: row?.totalAmount,
  amountUnit: row?.amountUnit,
  beforeRuling: typeof row?.applicationDate === 'string' ? row.applicationDate < TAURUS_LOW_RATE_SINCE : beforeRuling,
  nullAmountUnitIsFlOz: true,
}) === 'high';

// pestDefaultMixSelections(...) rows, minus Taurus SC unless the home is known to have room under the label.
export function applyTaurusYearlyLimit(selections, taurusYearly) {
  const list = Array.isArray(selections) ? selections : [];
  return known(taurusYearly) && taurusYearly.eligible ? list : list.filter(({ product }) => !isTaurusProduct(product));
}

const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home is still within the label's yearly limit.";

// The line under the house mix when Taurus was left out; null when the answer says it stays.
export function taurusLeftOutLine(taurusYearly) {
  if (!known(taurusYearly)) return UNKNOWN_LINE;
  return exhausted(taurusYearly)
    ? `Taurus left out: this home reached the label's yearly limit (${taurusYearly.count} this year).`
    : null;
}

// The warning when a Taurus row is on the list although the label has no room for it at this home; null otherwise.
// A row mixed above 0.4 fl_oz/gal is a 0.06% application and is judged by `eligibleHigh`, any other by `eligible`.
// `products` are the selected rows ({ name, rate, rateUnit, totalAmount, amountUnit }) or catalog entries; warns only, never blocks.
export function taurusOverLimitWarning(taurusYearly, products) {
  if (!known(taurusYearly)) return null;
  const list = Array.isArray(products) ? products : [];
  const over = list.some((p) => {
    if (!p || !isTaurusProduct(p)) return false;
    const high = isHighTaurusRate(p, { beforeRuling: taurusYearly.beforeRuling === true });
    const fits = high && typeof taurusYearly.eligibleHigh === 'boolean' ? taurusYearly.eligibleHigh : taurusYearly.eligible;
    return fits === false;
  });
  return over ? "Over the label's yearly Taurus limit at this home." : null;
}

// The one note a close-out shows: the warning when Taurus is selected over the limit, else, on a visit that
// opens on the house mix (`mixVisit`) with Taurus not selected, the left-out line; else null.
export function taurusYearlyNote(taurusYearly, selectedProducts, { mixVisit = false } = {}) {
  const warning = taurusOverLimitWarning(taurusYearly, selectedProducts);
  if (warning) return warning;
  const list = Array.isArray(selectedProducts) ? selectedProducts : [];
  return mixVisit && !list.some((p) => p && isTaurusProduct(p)) ? taurusLeftOutLine(taurusYearly) : null;
}
