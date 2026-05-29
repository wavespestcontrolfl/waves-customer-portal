const db = require('../models/db');
const PricingEngine = require('../services/pricing-engine');
const constants = require('../services/pricing-engine/constants');

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

describe('Lawn Pricing V2 DB sync', () => {
  beforeAll(async () => {
    const synced = await PricingEngine.syncConstantsFromDB(db);
    if (!synced) throw new Error('Expected syncConstantsFromDB to load pricing_config');
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
  });

  test('DB-loaded constants preserve dense-route 55% floor pricing', () => {
    const lawn = PricingEngine.priceLawnCare(property(), {
      track: 'st_augustine',
      lawnFreq: 9,
    });

    expect(constants.LAWN_PRICING_V2).toMatchObject({
      pricingVersion: 'LAWN_PRICING_V2_DENSE_55_FLOOR',
      pricingMode: 'FIFTY_FIVE_MARGIN_FLOOR',
      targetCollectedMarginFloor: 0.55,
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
    expect(lawn.perApp).toBe(92);
    expect(lawn.annual).toBe(828);
    expect(lawn.monthly).toBe(69);
    expect(lawn.costs.total).toBeGreaterThanOrEqual(371);
    expect(lawn.costs.total).toBeLessThan(372);
    expect(lawn.minimumCollectedAnnualPriceFor55).toBeGreaterThanOrEqual(826);
    expect(lawn.minimumCollectedAnnualPriceFor55).toBeLessThan(827);
    expect(lawn.pricingVersion).toBe('LAWN_PRICING_V2_DENSE_55_FLOOR');
    expect(lawn.pricingSource).toBe('COST_FLOOR');
    expect(lawn.pricingBasis).toBe('FIFTY_FIVE_MARGIN_FLOOR');
    expect(lawn.marketAnnual).toBeGreaterThan(lawn.annual);
    expect(lawn.tiers.map((tier) => tier.tier)).toEqual(['standard', 'enhanced', 'premium']);
  });

  test('DB-loaded estimate keeps Lawn V2 net floor non-discountable while qualifying for WaveGuard', () => {
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
    expect(lawn.annual).toBe(828);
    expect(lawn.annualAfterDiscount).toBe(828);
    expect(lawn.discount).toMatchObject({
      discountable: false,
      requestedDiscountPercent: 0.10,
      appliedDiscountPercent: 0,
      policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
    });
  });
});
