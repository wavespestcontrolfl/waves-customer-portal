process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial RISK-TYPE cadence (owner-locked risk-type lane, decision 2). The
// business-type bucket drives commercial pest/rodent visits-per-year. NULL /
// unrecognized → the pricers keep their program defaults (pest 12 / rodent 4),
// i.e. today's behavior — fully backward compatible.

const {
  resolveCommercialCadence,
  COMMERCIAL_RISK_TYPE_CADENCE,
  isCommercialRiskType,
} = require('../services/pricing-engine/commercial-risk-type');
const {
  priceCommercialPest,
  priceCommercialRodentBait,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine');

describe('resolveCommercialCadence', () => {
  test('maps each of the 8 buckets to the locked pest/rodent cadence', () => {
    expect(resolveCommercialCadence('office_low')).toEqual({ pestVisits: 4, rodentVisits: 4 });
    expect(resolveCommercialCadence('retail_standard')).toEqual({ pestVisits: 4, rodentVisits: 4 });
    expect(resolveCommercialCadence('hoa_common_area')).toEqual({ pestVisits: 6, rodentVisits: 4 });
    expect(resolveCommercialCadence('warehouse_distribution')).toEqual({ pestVisits: 6, rodentVisits: 12 });
    expect(resolveCommercialCadence('restaurant_food')).toEqual({ pestVisits: 12, rodentVisits: 12 });
    expect(resolveCommercialCadence('healthcare_childcare')).toEqual({ pestVisits: 12, rodentVisits: 12 });
    expect(resolveCommercialCadence('hotel_resort')).toEqual({ pestVisits: 12, rodentVisits: 12 });
    expect(resolveCommercialCadence('multifamily')).toEqual({ pestVisits: 12, rodentVisits: 12 });
  });

  test('NULL / empty / unrecognized → nulls (pricers keep program defaults)', () => {
    expect(resolveCommercialCadence(undefined)).toEqual({ pestVisits: null, rodentVisits: null });
    expect(resolveCommercialCadence('')).toEqual({ pestVisits: null, rodentVisits: null });
    expect(resolveCommercialCadence('nonsense')).toEqual({ pestVisits: null, rodentVisits: null });
    expect(resolveCommercialCadence('OFFICE_LOW')).toEqual({ pestVisits: 4, rodentVisits: 4 }); // case-insensitive
    expect(isCommercialRiskType('office_low')).toBe(true);
    expect(isCommercialRiskType('nonsense')).toBe(false);
  });

  test('warehouse rodent is MONTHLY (12), not quarterly', () => {
    expect(COMMERCIAL_RISK_TYPE_CADENCE.warehouse_distribution.rodentVisits).toBe(12);
  });
});

describe('pricers honor the visits override', () => {
  const BUILD = { footprint: 20000, perimeter: 600 };

  test('priceCommercialPest scales visits (fewer → lower annual, floored at $900)', () => {
    const def = priceCommercialPest(BUILD); // 12 visits (program default)
    const office = priceCommercialPest(BUILD, { pestVisits: 4 });
    expect(def.visitsPerYear).toBe(12);
    expect(office.visitsPerYear).toBe(4);
    expect(office.annual).toBeLessThan(def.annual); // fewer visits → cheaper
    expect(office.annual).toBeGreaterThanOrEqual(900); // never below the commercial floor
  });

  test('priceCommercialRodentBait scales visits (monthly > quarterly)', () => {
    const def = priceCommercialRodentBait(BUILD); // 4 visits
    const monthly = priceCommercialRodentBait(BUILD, { rodentVisits: 12 });
    expect(def.visitsPerYear).toBe(4);
    expect(monthly.visitsPerYear).toBe(12);
    expect(monthly.annual).toBeGreaterThan(def.annual);
  });

  test('an invalid/zero override falls back to the program default', () => {
    expect(priceCommercialPest(BUILD, { pestVisits: 0 }).visitsPerYear).toBe(12);
    expect(priceCommercialPest(BUILD, { pestVisits: NaN }).visitsPerYear).toBe(12);
    expect(priceCommercialRodentBait(BUILD, { rodentVisits: undefined }).visitsPerYear).toBe(4);
  });

  test('rodent detail cadence word tracks the visit count (no monthly-described-as-quarterly)', () => {
    expect(priceCommercialRodentBait(BUILD).detail).toContain('(quarterly)'); // 4/yr default
    expect(priceCommercialRodentBait(BUILD, { rodentVisits: 12 }).detail).toContain('(monthly)');
    expect(priceCommercialRodentBait(BUILD, { rodentVisits: 12 }).detail).not.toContain('quarterly');
  });
});

describe('cadence threads through generateEstimate (input.commercialRiskType)', () => {
  const base = { propertyType: 'commercial', isCommercial: true, footprintSqFt: 20000 };
  const lineFor = (commercialRiskType, service) => generateEstimate({
    ...base, commercialRiskType, services: { pest: {}, rodentBait: {} },
  }).lineItems.find((l) => l.service === service);

  test('office_low → pest 4 / rodent 4', () => {
    expect(lineFor('office_low', 'commercial_pest').visitsPerYear).toBe(4);
    expect(lineFor('office_low', 'commercial_rodent_bait').visitsPerYear).toBe(4);
  });

  test('restaurant_food → pest 12 / rodent 12', () => {
    expect(lineFor('restaurant_food', 'commercial_pest').visitsPerYear).toBe(12);
    expect(lineFor('restaurant_food', 'commercial_rodent_bait').visitsPerYear).toBe(12);
  });

  test('warehouse_distribution → pest 6 / rodent 12 (monthly rodent)', () => {
    expect(lineFor('warehouse_distribution', 'commercial_pest').visitsPerYear).toBe(6);
    expect(lineFor('warehouse_distribution', 'commercial_rodent_bait').visitsPerYear).toBe(12);
  });

  test('no risk type → today\'s defaults (pest 12 / rodent 4) — backward compatible', () => {
    expect(lineFor(undefined, 'commercial_pest').visitsPerYear).toBe(12);
    expect(lineFor(undefined, 'commercial_rodent_bait').visitsPerYear).toBe(4);
  });
});
