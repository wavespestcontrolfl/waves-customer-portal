const { gateEnvValue } = require('../config/feature-gates');
const reference = require('../config/tree-shrub-field-guide.json');

// One reference for the admin month browser and the actual scheduled visit.
// The payload is descriptive; it does not authorize an application or write use.
function treeShrubFieldGuide(visit) {
  if (!gateEnvValue('GATE_TREE_SHRUB_FIELD_GUIDE') || !visit?.fieldGuide) return null;
  const keys = [...visit.fieldGuide.routine, ...visit.fieldGuide.conditional].map(row => row.key);
  return {
    ...visit.fieldGuide,
    month: visit.month,
    products: Object.fromEntries([...new Set(keys)].map(key => [key, { ...reference.products[key] }])),
    equipment: reference.equipment,
    palmChart: visit.fieldGuide.palm ? reference.palmChart : [],
  };
}

module.exports = { treeShrubFieldGuide };
