/**
 * Unit coverage for @waves/lawn-cost-floor — the single source of truth the
 * server pricing engine and the client estimate preview both import.
 * Behavioral parity with each consumer is covered by lawn-client-server-parity
 * and lawn-pricing-golden-master; this pins the pure functions directly.
 */
const {
  LAWN_MATERIAL_BUDGETS,
  lawnMaterialBudget,
  lawnMaterialCostPerVisit,
  lawnComplexityMinutes,
  computeLawnCostFloor,
} = require('@waves/lawn-cost-floor');

describe('lawnMaterialBudget', () => {
  it('returns track/shade/visits budget; St. Augustine has shade variants', () => {
    expect(lawnMaterialBudget('st_augustine', 'FULL_SUN', 9)).toBe(141);
    expect(lawnMaterialBudget('st_augustine', 'MODERATE_SHADE', 9)).toBe(110);
    expect(lawnMaterialBudget('st_augustine', 'HEAVY_SHADE', 9)).toBe(100);
  });
  it('falls back to FULL_SUN for tracks without shade variants', () => {
    expect(lawnMaterialBudget('bermuda', 'HEAVY_SHADE', 9)).toBe(LAWN_MATERIAL_BUDGETS.bermuda.FULL_SUN[9]);
  });
  it('defaults shade and unknown track sanely', () => {
    expect(lawnMaterialBudget('zoysia', undefined, 12)).toBe(178);
    expect(lawnMaterialBudget('made_up', 'FULL_SUN', 6)).toBe(LAWN_MATERIAL_BUDGETS.st_augustine.FULL_SUN[6]);
  });
});

describe('lawnMaterialCostPerVisit', () => {
  it('scales the annual budget by sf/4500 UNCLAMPED (the old drift source)', () => {
    // 0.556× at 2,500 sqft — below the removed 0.6 clamp floor.
    expect(lawnMaterialCostPerVisit(141, 2500, 9)).toBeCloseTo((141 * (2500 / 4500)) / 9, 9);
    // 4.0× at 18,000 sqft — above the removed 2.5 clamp ceiling.
    expect(lawnMaterialCostPerVisit(141, 18000, 9)).toBeCloseTo((141 * (18000 / 4500)) / 9, 9);
  });
});

describe('lawnComplexityMinutes', () => {
  it('sums landscape/shrub/driveway terms like the server', () => {
    expect(lawnComplexityMinutes({})).toBe(0);
    expect(lawnComplexityMinutes({ landscapeComplexity: 'MODERATE' })).toBe(5);
    expect(lawnComplexityMinutes({ landscapeComplexity: 'COMPLEX' })).toBe(10);
    expect(lawnComplexityMinutes({ shrubDensity: 'HEAVY' })).toBe(5);
    expect(lawnComplexityMinutes({ hasLargeDriveway: true })).toBe(5);
    expect(lawnComplexityMinutes({ hasPrivacyFence: true })).toBe(5);
    expect(lawnComplexityMinutes({ landscapeComplexity: 'complex', shrubDensity: 'heavy', hasLargeDriveway: true })).toBe(20);
  });
});

describe('computeLawnCostFloor', () => {
  it('reproduces the canonical 4,250 St-Aug Enhanced/9 DENSE FULL_SUN floor ($774/yr → $86/app)', () => {
    const floor = computeLawnCostFloor({
      lawnSqFt: 4250,
      visits: 9,
      materialCostPerVisit: lawnMaterialCostPerVisit(141, 4250, 9),
      laborMinutesBase: 12,
      laborMinutesPer1000Sqft: 2.5,
      complexityMinutes: 0,
      laborRate: 35,
      routeDriveMinutes: 5,
      callbackReservePerVisit: 2,
      equipmentReservePerVisit: 0,
      adminAnnual: 51,
      targetGrossMargin: 0.55,
    });
    const perApp = Math.ceil(floor.minimumCollectedAnnualPriceFor55 / 9);
    expect(perApp).toBe(86);
    expect(perApp * 9).toBe(774);
  });
});
