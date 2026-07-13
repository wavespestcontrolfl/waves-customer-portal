const db = require('../models/db');
const PricingEngine = require('../services/pricing-engine');
const constants = require('../services/pricing-engine/constants');

// DB-backed integration suite: syncConstantsFromDB loads pricing_config from
// Postgres. Self-skips without DATABASE_URL (same pattern as the other
// DB-backed suites, e.g. auto-dispatch-schema).
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

function property(overrides = {}) {
  return PricingEngine.calculatePropertyProfile({
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    measuredTurfSf: 4250,
    ...overrides,
  });
}

describeOrSkip('Lawn Pricing V2 DB sync', () => {
  beforeAll(async () => {
    const synced = await PricingEngine.syncConstantsFromDB(db);
    if (!synced) throw new Error('Expected syncConstantsFromDB to load pricing_config');
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
  });

  test('DB-loaded constants apply the dense-route 35% floor pricing', () => {
    const lawn = PricingEngine.priceLawnCare(property(), {
      track: 'st_augustine',
      lawnFreq: 9,
    });

    expect(constants.LAWN_PRICING_V2).toMatchObject({
      pricingVersion: 'LAWN_PRICING_V2_DENSE_35_FLOOR',
      pricingMode: 'THIRTY_FIVE_MARGIN_FLOOR',
      targetCollectedMarginFloor: 0.35,
      laborRateLoaded: 35,
      equipmentReservePerVisit: 0,
      adminAnnualDefault: 51,
      callbackReservePerVisitDefault: 2,
      defaultRouteDensity: 'DENSE',
      routeDensityMinutes: {
        DENSE: 5,
        NORMAL: 10,
        LOOSE: 15,
        SPARSE: 20,
      },
    });
    // Under the 35% floor the cost floor (~$572/yr) drops below the market
    // table (~$576/yr = $48/mo) — but the $50/mo program minimum (owner
    // directive 2026-07-09, #2540) clamps this property up to $603/yr, so the
    // program minimum is the final price, not the market table.
    expect(lawn.perApp).toBe(67);
    expect(lawn.annual).toBe(603);
    expect(lawn.monthly).toBe(50.25);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(371);
    expect(lawn.costs.total).toBeLessThan(372);
    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThanOrEqual(571);
    expect(lawn.minimumCollectedAnnualPrice).toBeLessThan(572);
    expect(lawn.pricingVersion).toBe('LAWN_PRICING_V2_DENSE_35_FLOOR');
    expect(lawn.pricingSource).toBe('PROGRAM_MINIMUM');
    expect(lawn.pricingBasis).toBe('PROGRAM_MINIMUM_MONTHLY');
    expect(lawn.marketAnnual).toBe(576);
    // 6/9/12-visit ladder — the 4-visit 'basic' tier is no longer sold.
    expect(lawn.tiers.map((tier) => tier.tier)).toEqual(['standard', 'enhanced', 'premium']);
  });

  test('DB-loaded estimate applies WaveGuard discounts to Lawn V2 while qualifying for WaveGuard', () => {
    const estimate = PricingEngine.generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
      measuredTurfSf: 4250,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', lawnFreq: 9 },
      },
    });
    const lawn = estimate.lineItems.find((line) => line.service === 'lawn_care');

    expect(estimate.waveGuard).toMatchObject({
      tier: 'silver',
      qualifyingCount: 2,
      activeServices: ['pest_control', 'lawn_care'],
    });
    // WaveGuard silver takes 10% off $603 → $542.70, but the $50/mo program
    // minimum re-clamps AFTER discounts (discounts are NOT exempt from the
    // floor, owner directive 2026-07-09): final $600/yr = $50/mo exactly.
    expect(lawn.annual).toBe(603);
    expect(lawn.annualAfterDiscount).toBe(600);
    expect(lawn.monthlyAfterDiscount).toBe(50);
    expect(lawn.discount).toMatchObject({
      discountable: true,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0.10,
      effectiveDiscount: 0.10,
    });
  });
});
