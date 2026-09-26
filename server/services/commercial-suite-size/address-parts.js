// One address splitter for every suite-sizing caller (admin lookup, cache
// stamp key, estimator engine): {street, unit, city, zip}. Handles the
// unit-first form ("Unit 102, 4400 Main St, Bradenton, FL 34211") that
// parseRawAddress would otherwise read as line1 = "Unit 102".
// A plaza "Bay 12" is a tenant unit, but the shared parser has no Bay
// designator; it is spelled Suite so the unit splits out. Only a number or a
// lone letter counts as the unit value ("Bay St", "Tampa Bay" stay street text).
const PLAZA_BAY_RE = /\bbay\s*#?\s*(?=(?:\d[A-Za-z0-9-]*|[A-Za-z](?:-?\d+)?)(?:$|[\s,]))/gi;

function suiteAddressParts(rawAddress) {
  const { parseRawAddress, splitStreetLineUnitParts, splitUnitFirstLine } = require('../../utils/address-normalizer');
  const raw = String(rawAddress || '').replace(PLAZA_BAY_RE, 'Suite ');
  const unitFirst = splitUnitFirstLine(raw);
  const parsed = parseRawAddress(unitFirst ? unitFirst.rest : raw) || {};
  const { street, unit } = splitStreetLineUnitParts(parsed.line1 || (unitFirst ? unitFirst.rest : raw) || '');
  // "…, Suite 101, Parrish FL 34219" (city, state and ZIP in one segment)
  // parses with the whole tail as the city and no ZIP; the license match
  // needs the ZIP, so recover a trailing one and trim it off the city.
  let { city, zip } = parsed;
  if (!zip) {
    const tail = raw.match(/\b(\d{5})(?:-\d{4})?\s*(?:,\s*USA)?\s*$/i);
    if (tail) {
      zip = tail[1];
      if (city) city = String(city).replace(/\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/, '').trim() || city;
    }
  }
  return { street, unit: unitFirst ? unitFirst.unit : unit, city, zip };
}

module.exports = { suiteAddressParts, PLAZA_BAY_RE };
