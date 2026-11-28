const reference = require('../config/tree-shrub-field-guide.json');

const SPRAYER_EQUIPMENT = { bg: 'bg_1_gal', flowzone: 'flowzone_4_gal', soil: 'flowzone_4_gal', rig: 'rig_100_gal' };

function allowedSprayersForProduct(product) {
  const mapped = [...new Set((product?.equipment || []).map((k) => SPRAYER_EQUIPMENT[k]).filter(Boolean))];
  return mapped.length && mapped.length < 3 ? mapped : null;
}

// One reference for the admin month browser and the actual scheduled visit.
// The payload is descriptive; it does not authorize an application or write use.
function treeShrubFieldGuide(visit) {
  if (!visit?.fieldGuide) return null;
  const lines = [...visit.fieldGuide.routine.map(row => ({ ...row, section: 'routine' })), ...visit.fieldGuide.conditional.map(row => ({ ...row, section: 'conditional' }))];
  const keys = [...new Set(lines.map(row => row.key))];
  return {
    ...visit.fieldGuide,
    month: visit.month,
    products: Object.fromEntries(keys.map(key => [key, { ...reference.products[key] }])),
    // The month's Mix Amounts table (ProtocolMixTable): each visit line's product rows, routine first, each carrying that
    // line's own condition ("Routine when due: …" / "If you find: …", e.g. live finds only, before 9 AM). A per-gallon rate is
    // multiplied for each tank on screen; a granular or per-plant dose shows as written; no verified rate says so.
    mixRates: lines.flatMap((line) => {
      const product = reference.products[line.key];
      const allowedSprayers = allowedSprayersForProduct(product);
      return (product?.mixRates || []).map((row) => ({
        ...row,
        ...(allowedSprayers && !row.allowedSprayers ? { allowedSprayers } : {}),
        condition: `${line.section === 'routine' ? 'Routine when due' : 'If you find'}: ${line.where}`,
      }));
    }),
    equipment: reference.equipment,
    palmChart: visit.fieldGuide.palm ? reference.palmChart : [],
    // Palm-type table rides with the palm chart: same visits, same purpose.
    palmTypes: visit.fieldGuide.palm ? reference.palmTypes : null,
  };
}

module.exports = { treeShrubFieldGuide };
