const reference = require('../config/tree-shrub-field-guide.json');

// One reference for the admin month browser and the actual scheduled visit.
// The payload is descriptive; it does not authorize an application or write use.
function treeShrubFieldGuide(visit) {
  if (!visit?.fieldGuide) return null;
  const keys = [...new Set([...visit.fieldGuide.routine, ...visit.fieldGuide.conditional].map(row => row.key))];
  return {
    ...visit.fieldGuide,
    month: visit.month,
    products: Object.fromEntries(keys.map(key => [key, { ...reference.products[key] }])),
    // The month's Mix Amounts table (ProtocolMixTable): each product's label-rate rows, routine first. A per-gallon rate is
    // multiplied for each sprayer on screen; a granular or per-plant dose shows as written; no verified rate says so.
    mixRates: keys.flatMap(key => reference.products[key]?.mixRates || []),
    equipment: reference.equipment,
    palmChart: visit.fieldGuide.palm ? reference.palmChart : [],
    // Palm-type table rides with the palm chart: same visits, same purpose.
    palmTypes: visit.fieldGuide.palm ? reference.palmTypes : null,
  };
}

module.exports = { treeShrubFieldGuide };
