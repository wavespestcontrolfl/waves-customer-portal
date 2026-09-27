'use strict';

// The server copy resolver, Ask Waves, and the browser's saved-copy filter
// must use the same purchase evidence. Read the existing authored JSON pack
// for its exact bullet instead of maintaining a second customer-facing string.
const { warrantyBullet: PURCHASED_TRENCHING_WARRANTY_BULLET } = require('../server/services/estimate-one-time-copy.json').termite_trenching;

// Zero is valid for the included one-year tier. Labels and detail prose
// cannot establish purchased coverage.
function hasPurchasedTrenchingWarranty(item = {}) {
  const service = String(item.service || '').toLowerCase().trim();
  const tier = String(item.warrantyTier || '').toLowerCase().trim();
  const adderPresent = item.warrantyAdder !== '' && item.warrantyAdder != null;
  const adder = Number(item.warrantyAdder);
  return ['trenching', 'termite_trenching'].includes(service)
    && tier !== '' && tier !== 'none'
    && adderPresent && Number.isFinite(adder) && adder >= 0;
}

module.exports = { hasPurchasedTrenchingWarranty, PURCHASED_TRENCHING_WARRANTY_BULLET };
