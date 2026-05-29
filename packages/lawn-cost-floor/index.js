/**
 * @waves/lawn-cost-floor — single source of truth for the Lawn V2 cost floor.
 *
 * The server pricing engine (server/services/pricing-engine/service-pricing.js,
 * authoritative on save) AND the client estimate preview
 * (client/src/lib/estimateEngine.js) both import this module, so the cost-floor
 * math can no longer drift between the price a customer is shown and the price
 * the system bills. (PRs #1328 server-authoritative, #1335 client parity moved
 * the two into agreement; this module makes them structurally identical.)
 *
 * Pure CommonJS, zero dependencies — consumable by the CJS server via require()
 * and by the ESM/Vite client via import (esbuild handles the CJS interop). The
 * caller resolves all knobs (the server passes its DB-tunable LAWN_PRICING_V2;
 * the client passes its static copy), so this module owns the ARITHMETIC and the
 * static material budgets, not the runtime configuration.
 */

// Default knobs — mirror server constants.js LAWN_PRICING_V2 (+ GLOBAL admin/labor).
// The server overrides these at runtime from DB config; the client uses them as-is.
const LAWN_COST_FLOOR_DEFAULTS = {
  targetCollectedMarginFloor: 0.55,
  laborRateLoaded: 35,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: { DENSE: 5, NORMAL: 10, LOOSE: 15, SPARSE: 20 },
};

// Visits per sold/hidden tier.
const LAWN_TIER_VISITS = { basic: 4, standard: 6, enhanced: 9, premium: 12 };

// Annual material budgets at the 4,500 sqft reference, by track → visits.
// Sun/shade is NOT a pricing input — every lawn prices on its track's budget.
const LAWN_MATERIAL_BUDGETS = {
  st_augustine: { 4: 64, 6: 87, 9: 141, 12: 205 },
  bermuda: { 4: 57, 6: 87, 9: 140, 12: 215 },
  zoysia: { 4: 67, 6: 101, 9: 148, 12: 178 },
  bahia: { 4: 45, 6: 68, 9: 95, 12: 115 },
};

const MATERIAL_REFERENCE_SQFT = 4500;

// Annual material budget (at the reference sqft) for a track/visits combo.
function lawnMaterialBudget(track, visits) {
  const trackBudgets = LAWN_MATERIAL_BUDGETS[track] || LAWN_MATERIAL_BUDGETS.st_augustine;
  return trackBudgets[visits] || 100;
}

// Per-visit material cost: the annual budget scaled linearly by turf size,
// UNCLAMPED. (A clamp here was the historical client/server drift source.)
function lawnMaterialCostPerVisit(annualMaterialBudget, lawnSqFt, visits) {
  const sf = Number(lawnSqFt) || 0;
  return (annualMaterialBudget * (sf / MATERIAL_REFERENCE_SQFT)) / visits;
}

// Extra labor minutes/visit from landscape complexity. The privacy-fence term
// falls back to the large-driveway flag when fence isn't known (matches how the
// server defaults when property.fenceType is absent).
function lawnComplexityMinutes({ landscapeComplexity, shrubDensity, hasLargeDriveway, hasPrivacyFence } = {}) {
  const complexity = String(landscapeComplexity || '').toLowerCase();
  const shrubs = String(shrubDensity || '').toLowerCase();
  return (
    (complexity === 'moderate' ? 5 : 0) +
    (complexity === 'complex' ? 10 : 0) +
    (shrubs === 'heavy' ? 5 : 0) +
    ((hasPrivacyFence || hasLargeDriveway) ? 5 : 0)
  );
}

// The canonical 55% cost-floor arithmetic. All inputs are fully resolved numbers
// supplied by the caller. Returns the per-component annual breakdown plus
// minimumCollectedAnnualPriceFor55 (annual is the source of truth; callers derive
// perApp = ceil(that / visits) and monthly = round(annual/12)).
function computeLawnCostFloor({
  lawnSqFt,
  visits,
  materialCostPerVisit,
  laborMinutesBase,
  laborMinutesPer1000Sqft,
  complexityMinutes = 0,
  laborRate,
  routeDriveMinutes,
  callbackReservePerVisit,
  equipmentReservePerVisit = 0,
  adminAnnual,
  targetGrossMargin,
}) {
  const turfK = (Number(lawnSqFt) || 0) / 1000;
  const laborMinutesPerVisit = laborMinutesBase + turfK * laborMinutesPer1000Sqft + complexityMinutes;
  const laborCostPerVisit = laborRate * laborMinutesPerVisit / 60;
  const driveCostPerVisit = laborRate * routeDriveMinutes / 60;

  const annualMaterial = materialCostPerVisit * visits;
  const annualLabor = laborCostPerVisit * visits;
  const annualDrive = driveCostPerVisit * visits;
  const annualEquipment = equipmentReservePerVisit * visits;
  const annualCallbackReserve = callbackReservePerVisit * visits;
  const annualCost = annualMaterial + annualLabor + annualDrive + annualEquipment + annualCallbackReserve + adminAnnual;
  const minimumCollectedAnnualPriceFor55 = Math.round((annualCost / (1 - targetGrossMargin)) * 100) / 100;

  return {
    materialCostPerVisit,
    laborMinutesPerVisit,
    annualMaterial,
    annualLabor,
    annualDrive,
    annualEquipment,
    annualCallbackReserve,
    annualAdmin: adminAnnual,
    annualCost,
    minimumCollectedAnnualPriceFor55,
  };
}

module.exports = {
  LAWN_COST_FLOOR_DEFAULTS,
  LAWN_TIER_VISITS,
  LAWN_MATERIAL_BUDGETS,
  MATERIAL_REFERENCE_SQFT,
  lawnMaterialBudget,
  lawnMaterialCostPerVisit,
  lawnComplexityMinutes,
  computeLawnCostFloor,
};
