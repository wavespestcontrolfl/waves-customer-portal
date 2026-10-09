// Validator for lawn_pricing_v2.costPlusList, shared by the pricer
// (service-pricing priceLawnCare) and the admin write boundary
// (admin-pricing-config validatePricingConfigData) so a knob object that
// saves is a knob object that prices. Strict numbers only, no unknown keys.
const { LAWN_TIERS } = require('./constants');

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const SCALAR_RULES = {
  listMargin: (v) => isNumber(v) && v > 0 && v < 0.9,
  minimumPerVisit: (v) => isNumber(v) && v >= 0,
  spotMinutesPerVisit: (v) => isNumber(v) && v >= 0,
};
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Returns an error message, or null when the knobs are usable.
function costPlusListKnobError(cfg) {
  if (!isPlainObject(cfg)) return 'costPlusList must be an object';
  const freqs = Object.values(LAWN_TIERS).map((tier) => tier.freq);
  const material = cfg.materialPer1000SqftPerYear;
  const unknown = Object.keys(cfg).find((k) => !(k in SCALAR_RULES) && k !== 'materialPer1000SqftPerYear');
  if (unknown) return `costPlusList.${unknown} is not a known knob`;
  const badScalar = Object.keys(SCALAR_RULES).find((k) => !SCALAR_RULES[k](cfg[k]));
  if (badScalar) return `costPlusList.${badScalar} is missing or out of range (listMargin must be in (0, 0.9); the others must be numbers of at least 0)`;
  if (!isPlainObject(material)) return 'costPlusList.materialPer1000SqftPerYear must be an object';
  const badCadence = Object.keys(material).find((k) => !freqs.includes(Number(k)))
    ?? freqs.find((f) => !(isNumber(material[f]) && material[f] > 0));
  if (badCadence !== undefined) return `costPlusList.materialPer1000SqftPerYear needs a positive number for each of ${freqs.join(', ')} visits (problem: ${badCadence})`;
  return null;
}

module.exports = { costPlusListKnobError };
