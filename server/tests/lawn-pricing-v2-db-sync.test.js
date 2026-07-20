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

  test('DB-loaded constants price the dense route off the market table (floors disarmed 2026-07-17)', () => {
    const lawn = PricingEngine.priceLawnCare(property(), {
      track: 'st_augustine',
      lawnFreq: 9,
    });

    expect(constants.LAWN_PRICING_V2).toMatchObject({
      pricingVersion: 'LAWN_PRICING_V2_SPOT_RESERVE',
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
    // Floors disarmed (owner ruling 2026-07-17, migration 20260717120000
    // sets programMinimumMonthly 0 on the row this suite loads): the market
    // table is the price. The cost-floor math still reports — with spot
    // reserves folded in (#2812) the reporting floor (~$593.72
    // minimum-collected, costs ~$385.92) sits ABOVE the $576/yr quote,
    // and nothing lifts the price.
    expect(lawn.perApp).toBe(64);
    expect(lawn.annual).toBe(576);
    expect(lawn.monthly).toBe(48);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(385);
    expect(lawn.costs.total).toBeLessThan(386);
    expect(lawn.minimumCollectedAnnualPrice).toBeGreaterThanOrEqual(593);
    expect(lawn.minimumCollectedAnnualPrice).toBeLessThan(594);
    expect(lawn.pricingVersion).toBe('LAWN_PRICING_V2_SPOT_RESERVE');
    expect(lawn.pricingSource).toBe('MARKET_TABLE');
    expect(lawn.pricingBasis).toBe('TABLE_INTERPOLATION');
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
    // WaveGuard Silver takes the full 10% off the $576 market price — the
    // program minimum that used to re-clamp after discounts is disarmed
    // (owner ruling 2026-07-17): final $518.40/yr = $43.20/mo.
    expect(lawn.annual).toBe(576);
    expect(lawn.annualAfterDiscount).toBe(518.4);
    expect(lawn.monthlyAfterDiscount).toBe(43.2);
    expect(lawn.discount).toMatchObject({
      discountable: true,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0.10,
      effectiveDiscount: 0.10,
    });
  });
});
