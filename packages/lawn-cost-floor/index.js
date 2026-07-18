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
  // Mirrors LAWN_PRICING_V2.targetCollectedMarginFloor (35% collected-margin
  // floor). Callers always pass their own targetGrossMargin; this default is a
  // documentation anchor, not a live knob. (A stale 0.55 sat here from the
  // retired 55%-floor-is-price model — never consumed, but regression bait.)
  targetCollectedMarginFloor: 0.35,
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
// 2026-07-16 (owner-approved): budgets now FUND the protocol spot-treatment
// reserves (protocols.json conditional_cost — ¼ of gated fungicide/
// insecticide apps, ⅛ of herbicide spot). Reserve deltas follow the same
// cadence conversion as the scheduled materials — average the flagged
// calendar slots of the sold cadence's protocol tier (standard→bronze,
// enhanced→enhanced, premium→premium, basic prorates bronze; the mapping
// pinned by waveguard-pricing-exposure PROTOCOL_TIER_BY_PRICING_TIER),
// multiply by the SOLD visit count (4/6/9/12), ceil so the funded floor
// always covers the audited reserve. OR-alternative branches fund the
// MAX-cost branch (e.g. zoysia Feb Medallion-or-Velista reserves the
// $67.50 Velista side). Reserve deltas per track at 4/6/9/12 visits:
// st_aug 11/16/15/20, bermuda 4/6/8/11, zoysia 16/23/31/41 (large-patch
// program dominates), bahia 7/10/12/16.
const LAWN_MATERIAL_BUDGETS = {
  st_augustine: { 4: 75, 6: 103, 9: 182, 12: 225 },
  bermuda: { 4: 61, 6: 93, 9: 172, 12: 226 },
  zoysia: { 4: 83, 6: 124, 9: 205, 12: 219 },
  bahia: { 4: 52, 6: 78, 9: 107, 12: 131 },
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

// The canonical collected-margin cost-floor arithmetic (the caller's
// targetGrossMargin — 35% today — sets the floor). All inputs are fully
// resolved numbers supplied by the caller. Returns the per-component annual
// breakdown plus minimumCollectedAnnualPrice (annual is the source of truth;
// callers derive perApp = ceil(that / visits) and monthly = round(annual/12)).
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
  const minimumCollectedAnnualPrice = Math.round((annualCost / (1 - targetGrossMargin)) * 100) / 100;

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
    minimumCollectedAnnualPrice,
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
