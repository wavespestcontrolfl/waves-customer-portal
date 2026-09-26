// One address splitter for every suite-sizing caller (admin lookup, cache
// stamp key, estimator engine): {street, unit, city, zip}. Handles the
// unit-first form ("Unit 102, 4400 Main St, Bradenton, FL 34211") that
// parseRawAddress would otherwise read as line1 = "Unit 102".
function suiteAddressParts(rawAddress) {
  const { parseRawAddress, splitStreetLineUnitParts, splitUnitFirstLine } = require('../../utils/address-normalizer');
  const raw = String(rawAddress || '');
  const unitFirst = splitUnitFirstLine(raw);
  const parsed = parseRawAddress(unitFirst ? unitFirst.rest : raw) || {};
  const { street, unit } = splitStreetLineUnitParts(parsed.line1 || (unitFirst ? unitFirst.rest : raw) || '');
  return { street, unit: unitFirst ? unitFirst.unit : unit, city: parsed.city, zip: parsed.zip };
}

module.exports = { suiteAddressParts };
