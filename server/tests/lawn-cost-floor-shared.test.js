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
const protocols = require('../config/protocols.json');

function protocolMaterialBudgetAtReferenceSqft(track, protocolTier, expectedVisits) {
  const visits = protocols.lawn[track].visits.filter((visit) => visit.tiers?.[protocolTier]);
  const totalAtTenK = visits.reduce((sum, visit) => sum + Number(visit.material_cost || 0), 0);
  return Math.round((totalAtTenK / visits.length) * expectedVisits * (4500 / 10000));
}

describe('lawnMaterialBudget', () => {
  it('returns the track/visits budget (sun/shade is not a pricing input)', () => {
    expect(lawnMaterialBudget('st_augustine', 9)).toBe(141);
    expect(lawnMaterialBudget('bermuda', 9)).toBe(140);
    expect(lawnMaterialBudget('zoysia', 12)).toBe(178);
    expect(lawnMaterialBudget('st_augustine', 6)).toBe(87);
    expect(lawnMaterialBudget('bermuda', 6)).toBe(87);
    expect(lawnMaterialBudget('zoysia', 6)).toBe(101);
  });
  it('falls back to st_augustine for an unknown track', () => {
    expect(lawnMaterialBudget('made_up', 6)).toBe(LAWN_MATERIAL_BUDGETS.st_augustine[6]);
  });

  it('keeps Standard material guardrails at or above the inventory-backed protocol baseline', () => {
    expect(lawnMaterialBudget('st_augustine', 6)).toBeGreaterThanOrEqual(
      protocolMaterialBudgetAtReferenceSqft('st_augustine', 'bronze', 6)
    );
    expect(lawnMaterialBudget('bermuda', 6)).toBeGreaterThanOrEqual(
      protocolMaterialBudgetAtReferenceSqft('bermuda', 'bronze', 6)
    );
    expect(lawnMaterialBudget('zoysia', 6)).toBeGreaterThanOrEqual(
      protocolMaterialBudgetAtReferenceSqft('zoysia', 'bronze', 6)
    );
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
  it('reproduces the canonical 4,250 St-Aug Enhanced/9 DENSE floor ($774/yr → $86/app)', () => {
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
