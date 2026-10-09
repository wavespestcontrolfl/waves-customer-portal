// The COST BASIS for the lawn cost-plus list price (GATE_LAWN_COST_PLUS_LIST):
// one resolved, validated, server-only object holding every number that feeds
// the annual cost, the list price and the discount floor and is not derived
// from the property. In cost-plus mode priceLawnCare takes its tuning numbers
// ONLY from this object (caller overrides are ignored), the engine stamps it
// into pricingMetadata.lawnCostPlusListBasis, and a saved-estimate replay hands
// the stamped copy back, so neither a request nor a later config edit moves a
// saved quote. Property-derived terms (lawn sq ft, complexity minutes, the
// maintenance and pest-pressure callback adders, the property's route density)
// stay live and are computed from the property.
//
// One validator serves the pricer, the replay snapshot and (the costPlusList
// part) the admin write boundary, so a save that passes there prices.
const { LAWN_TIERS, LAWN_PRICING_V2, GLOBAL } = require('./constants');

const BASIS_VERSION = 1;
// [min, max, decimals (null = any), minExclusive]
const LIMITS = {
  listMargin: [0.05, 0.75, null, false],
  collectedMarginFloor: [0.05, 0.75, null, false],
  minimumPerVisit: [0, 500, 2, false],
  spotMinutesPerVisit: [0, 120, null, false],
  materialPerK: [0, 500, 2, true],
  laborRateLoaded: [0, 500, null, true],
  minutes: [0, 240, null, false],
  dollars: [0, 1000, null, false],
};
const KNOB_RULES = {
  listMargin: 'listMargin', minimumPerVisit: 'minimumPerVisit', spotMinutesPerVisit: 'spotMinutesPerVisit',
};
const BASIS_RULES = {
  collectedMarginFloor: 'collectedMarginFloor',
  laborMinutesBase: 'minutes',
  laborMinutesPer1000Sqft: 'minutes',
  laborRateLoaded: 'laborRateLoaded',
  callbackReservePerVisitDefault: 'dollars',
  equipmentReservePerVisit: 'dollars',
  adminAnnual: 'dollars',
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function inLimits(v, ruleName) {
  const [min, max, decimals, minExclusive] = LIMITS[ruleName];
  if (typeof v !== 'number' || !Number.isFinite(v) || v > max || (minExclusive ? v <= min : v < min)) return false;
  return decimals === null || Math.abs(v * 10 ** decimals - Math.round(v * 10 ** decimals)) < 1e-6;
}
const badKey = (obj, rules) => Object.keys(rules).find((k) => !inLimits(obj[k], rules[k]));
const cadences = () => Object.values(LAWN_TIERS).map((tier) => tier.freq);

// The admin-editable part (lawn_pricing_v2.costPlusList). Returns an error
// message, or null when usable. Strict numbers, bounded, no unknown keys.
function costPlusListKnobError(cfg) {
  if (!isPlainObject(cfg)) return 'costPlusList must be an object';
  const material = cfg.materialPer1000SqftPerYear;
  const unknown = Object.keys(cfg).find((k) => !(k in KNOB_RULES) && k !== 'materialPer1000SqftPerYear');
  if (unknown) return `costPlusList.${unknown} is not a known knob`;
  const bad = badKey(cfg, KNOB_RULES);
  if (bad) {
    const [min, max, decimals] = LIMITS[KNOB_RULES[bad]];
    return `costPlusList.${bad} must be a number from ${min} to ${max}${decimals === null ? '' : ` with at most ${decimals} decimals`}`;
  }
  if (!isPlainObject(material)) return 'costPlusList.materialPer1000SqftPerYear must be an object';
  const freqs = cadences();
  const badCadence = Object.keys(material).find((k) => !freqs.includes(Number(k)))
    ?? freqs.find((f) => !inLimits(material[f], 'materialPerK'));
  if (badCadence !== undefined) {
    return `costPlusList.materialPer1000SqftPerYear needs a number above 0 and up to ${LIMITS.materialPerK[1]} with at most 2 decimals for each of ${freqs.join(', ')} visits (problem: ${badCadence})`;
  }
  return null;
}

// The whole basis (live or a replay snapshot).
function costPlusBasisError(basis) {
  if (!isPlainObject(basis) || basis.version !== BASIS_VERSION) return `cost basis must be an object with version ${BASIS_VERSION}`;
  const allowed = new Set(['version', 'costPlusList', 'routeDensityMinutes', 'defaultRouteDensity', ...Object.keys(BASIS_RULES)]);
  const unknown = Object.keys(basis).find((k) => !allowed.has(k));
  if (unknown) return `cost basis has an unknown field: ${unknown}`;
  const bad = badKey(basis, BASIS_RULES);
  if (bad) return `cost basis field ${bad} is missing or out of range`;
  const density = basis.routeDensityMinutes;
  if (!isPlainObject(density) || !Object.keys(density).length || Object.values(density).some((v) => !inLimits(v, 'minutes'))) {
    return 'cost basis routeDensityMinutes must map each density to minutes from 0 to 240';
  }
  if (!(basis.defaultRouteDensity in density)) return 'cost basis defaultRouteDensity must be a key of routeDensityMinutes';
  return costPlusListKnobError(basis.costPlusList);
}

function liveCostPlusBasis() {
  return JSON.parse(JSON.stringify({
    version: BASIS_VERSION,
    costPlusList: LAWN_PRICING_V2.costPlusList,
    collectedMarginFloor: LAWN_PRICING_V2.targetCollectedMarginFloor,
    laborMinutesBase: LAWN_PRICING_V2.laborMinutesBase,
    laborMinutesPer1000Sqft: LAWN_PRICING_V2.laborMinutesPer1000Sqft,
    laborRateLoaded: LAWN_PRICING_V2.laborRateLoaded || GLOBAL.LABOR_RATE,
    routeDensityMinutes: LAWN_PRICING_V2.routeDensityMinutes,
    defaultRouteDensity: LAWN_PRICING_V2.defaultRouteDensity,
    callbackReservePerVisitDefault: LAWN_PRICING_V2.callbackReservePerVisitDefault,
    equipmentReservePerVisit: LAWN_PRICING_V2.equipmentReservePerVisit,
    adminAnnual: LAWN_PRICING_V2.adminAnnualDefault,
  }));
}

// snapshot (server-only, from a saved estimate's stamp) or live server config.
// Returns { basis, error }; an unusable basis is never repaired or defaulted.
function resolveLawnCostPlusBasis(snapshot) {
  const basis = snapshot == null ? liveCostPlusBasis() : JSON.parse(JSON.stringify(snapshot));
  return { basis, error: costPlusBasisError(basis) };
}

// The floor-calculation tuning for one cadence, built from the basis alone:
// no caller option reaches the calculation in this mode. Only the property's
// own route density (a property fact, not a price knob) picks the drive row.
function costPlusFloorTuning(basis, freq, property = {}) {
  const asked = String(property.routeDensity || '').toUpperCase();
  const routeDensity = asked in basis.routeDensityMinutes ? asked : basis.defaultRouteDensity;
  return {
    materialCostPerK: basis.costPlusList.materialPer1000SqftPerYear[freq] / freq,
    annualMaterialBudget: null,
    laborMinutesBase: basis.laborMinutesBase + basis.costPlusList.spotMinutesPerVisit,
    laborMinutesPerK: basis.laborMinutesPer1000Sqft,
    routeDensity,
    routeDriveMinutes: basis.routeDensityMinutes[routeDensity],
    targetGrossMargin: basis.collectedMarginFloor,
    annualAdmin: basis.adminAnnual,
    laborRate: basis.laborRateLoaded,
    callbackReserveDefault: basis.callbackReservePerVisitDefault,
    equipmentReserve: basis.equipmentReservePerVisit,
  };
}

module.exports = { costPlusListKnobError, costPlusBasisError, resolveLawnCostPlusBasis, costPlusFloorTuning };
