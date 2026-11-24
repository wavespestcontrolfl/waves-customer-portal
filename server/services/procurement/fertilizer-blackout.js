/**
 * procurement/fertilizer-blackout.js — the June 1 - Sept 30 nitrogen /
 * phosphorus fertilizer hold for automatic ordering (owner 2026-11-24
 * "YES"). Inside the window the 6:10 AM sweep raises no request for an N/P
 * fertilizer, re-rings no "order manually" bell for one already open, and
 * the dispatcher orders nothing for it. An open request waits; the first
 * run after Sept 30 picks it up again.
 *
 * "N/P fertilizer" is productHasNpFertilizer (tree-shrub-closeout.js), the
 * same test the suggested-limits report uses (reorder-limit-suggestions.js).
 * The date is the ET calendar date.
 */
const { etDateString } = require('../../utils/datetime-et');

// products_catalog columns productHasNpFertilizer reads besides the name.
const FERTILIZER_COLUMNS = ['category', 'product_type', 'fertilizer_analysis', 'analysis_n', 'analysis_p'];

function inFertilizerBlackout(now = new Date()) {
  const month = Number(etDateString(now).split('-')[1]);
  return month >= 6 && month <= 9;
}

// True when automatic ordering must hold this product today. `product` is a
// products_catalog row carrying name + FERTILIZER_COLUMNS.
function fertilizerBlackoutHold(product, now = new Date()) {
  if (!product || !inFertilizerBlackout(now)) return false;
  const { productHasNpFertilizer } = require('../tree-shrub-closeout');
  return productHasNpFertilizer(product) === true;
}

module.exports = { FERTILIZER_COLUMNS, inFertilizerBlackout, fertilizerBlackoutHold };
