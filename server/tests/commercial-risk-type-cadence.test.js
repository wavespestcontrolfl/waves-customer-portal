process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial RISK-TYPE cadence (owner-locked risk-type lane, decision 2). The
// business-type bucket drives commercial pest/rodent visits-per-year. NULL /
// unrecognized → the pricers keep their program defaults (pest 12 / rodent 4),
// i.e. today's behavior — fully backward compatible.

const {
  resolveCommercialCadence,
  resolveCommercialPestCadenceOverride,
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

describe('direct pest-cadence override (input.commercialPestCadence)', () => {
  test('resolveCommercialPestCadenceOverride maps cadences to visits, else null', () => {
    expect(resolveCommercialPestCadenceOverride('quarterly')).toBe(4);
    expect(resolveCommercialPestCadenceOverride('bimonthly')).toBe(6);
    expect(resolveCommercialPestCadenceOverride('bi_monthly')).toBe(6);
    expect(resolveCommercialPestCadenceOverride('monthly')).toBe(12);
    expect(resolveCommercialPestCadenceOverride('MONTHLY')).toBe(12); // case-insensitive
    expect(resolveCommercialPestCadenceOverride('')).toBe(null);
    expect(resolveCommercialPestCadenceOverride(undefined)).toBe(null);
    expect(resolveCommercialPestCadenceOverride('nonsense')).toBe(null);
  });

  const base = { propertyType: 'commercial', isCommercial: true, footprintSqFt: 20000 };
  const lineFor = (input, service) => generateEstimate({
    ...base, ...input, services: { pest: {}, rodentBait: {} },
  }).lineItems.find((l) => l.service === service);

  test('override beats the risk-type bucket for PEST only — rodent stays on the bucket', () => {
    const pest = lineFor({ commercialRiskType: 'multifamily', commercialPestCadence: 'quarterly' }, 'commercial_pest');
    const rodent = lineFor({ commercialRiskType: 'multifamily', commercialPestCadence: 'quarterly' }, 'commercial_rodent_bait');
    expect(pest.visitsPerYear).toBe(4); // multifamily bucket says 12; override wins
    expect(rodent.visitsPerYear).toBe(12); // bucket cadence untouched
  });

  test('override works with no risk type set (beats the program default)', () => {
    expect(lineFor({ commercialPestCadence: 'bimonthly' }, 'commercial_pest').visitsPerYear).toBe(6);
  });

  test('unset/unrecognized override → risk-type bucket, then program default', () => {
    expect(lineFor({ commercialRiskType: 'office_low', commercialPestCadence: '' }, 'commercial_pest').visitsPerYear).toBe(4);
    expect(lineFor({ commercialRiskType: 'office_low', commercialPestCadence: 'nonsense' }, 'commercial_pest').visitsPerYear).toBe(4);
    expect(lineFor({ commercialPestCadence: 'nonsense' }, 'commercial_pest').visitsPerYear).toBe(12);
  });
});

// The V2 estimator (and the public re-price path) reach the engine through
// translateV2CallToV1Input, which whitelists fields — a field it drops is
// silently discarded before pricing (codex #3240 P1: the override was inert
// on the real estimator route without this forwarding).
describe('estimator adapter forwards commercialPestCadence', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const commercialProfile = {
    address: '100 Adapter Test Blvd',
    propertyType: 'Commercial',
    isCommercial: true,
    homeSqFt: 3000,
    lotSqFt: 8000,
    stories: 1,
  };
  const pestLine = (profile, options) => generateEstimate(
    translateV2CallToV1Input(profile, ['PEST'], options)
  ).lineItems.find((l) => l.service === 'commercial_pest');

  test('options-set override reaches the engine', () => {
    expect(pestLine(commercialProfile, { commercialPestCadence: 'quarterly' }).visitsPerYear).toBe(4);
  });

  test('profile-persisted override replays on re-price', () => {
    expect(pestLine({ ...commercialProfile, commercialPestCadence: 'bimonthly' }, {}).visitsPerYear).toBe(6);
  });

  test('options beat the persisted profile value', () => {
    expect(pestLine(
      { ...commercialProfile, commercialPestCadence: 'monthly' },
      { commercialPestCadence: 'quarterly' }
    ).visitsPerYear).toBe(4);
  });

  test('residential profile clears the override (never leaks into residential pricing)', () => {
    const input = translateV2CallToV1Input(
      { ...commercialProfile, propertyType: 'Single Family', isCommercial: false },
      ['PEST'],
      { isCommercial: 'NO', commercialPestCadence: 'quarterly' }
    );
    expect(input.commercialPestCadence).toBe(null);
    expect(input.isCommercial).toBe(false);
  });
});

// Public estimate page: solo commercial pest has no residential pestTiers, so
// the pricing bundle used to fall back to the first V1 frequency entry —
// always "Quarterly" — regardless of the sold cadence (codex #3240 r2 P1).
describe('public frequency entry tracks the commercial pest cadence', () => {
  const { commercialPestFrequenciesFromV1Services } = require('../routes/estimate-public');
  const row = (visitsPerYear) => ({
    service: 'commercial_pest',
    name: 'Commercial Pest Control',
    visitsPerYear,
    monthly: 100,
    annual: 1200,
    perApp: Math.round((1200 / visitsPerYear) * 100) / 100,
  });

  test('maps 4/6/12 visits to canonical V1 frequency keys (accept exact-matches these)', () => {
    expect(commercialPestFrequenciesFromV1Services([row(4)])[0]).toMatchObject({ key: 'quarterly', label: 'Quarterly', visitsPerYear: 4 });
    // 'bi_monthly', NOT foam-style 'bimonthly' — the public page's pest-cadence
    // normalization posts 'bi_monthly' and the accept handler exact-matches it.
    expect(commercialPestFrequenciesFromV1Services([row(6)])[0]).toMatchObject({ key: 'bi_monthly', label: 'Bi-monthly', visitsPerYear: 6 });
    expect(commercialPestFrequenciesFromV1Services([row(12)])[0]).toMatchObject({ key: 'monthly', label: 'Monthly', visitsPerYear: 12 });
  });

  test('carries the sold annual/monthly/per-visit and stays non-discountable', () => {
    const [freq] = commercialPestFrequenciesFromV1Services([row(6)]);
    expect(freq.annual).toBe(1200);
    expect(freq.monthly).toBe(100);
    expect(freq.perTreatment).toBe(200);
    expect(freq.manualDiscount).toBe(null);
    expect(freq.perServiceTreatments[0].waveGuardDiscountEligible).toBe(false);
  });

  test('no visit count defaults to the commercial program monthly (12), not quarterly', () => {
    const bare = { service: 'commercial_pest', name: 'Commercial Pest Control', monthly: 100, annual: 1200 };
    expect(commercialPestFrequenciesFromV1Services([bare])[0]).toMatchObject({ key: 'monthly', visitsPerYear: 12 });
  });

  test('no commercial pest row → empty (other services unaffected)', () => {
    expect(commercialPestFrequenciesFromV1Services([{ service: 'pest_control', visitsPerYear: 4 }])).toEqual([]);
    expect(commercialPestFrequenciesFromV1Services([])).toEqual([]);
  });
});

// Mixed commercial bundle (codex #3240 r4): the split-section path used to
// mirror the generic pest-shaped Quarterly key onto the commercial pest card,
// so a bi-monthly/monthly program still read "Quarterly" in a bundle.
describe('mixed commercial bundle keeps the pest cadence on its section', () => {
  const { buildPricingServices } = require('../routes/estimate-public');
  const pestRow = { service: 'commercial_pest', name: 'Commercial Pest Control', visitsPerYear: 6, monthly: 100, annual: 1200, perApp: 200 };
  const rodentRow = { service: 'commercial_rodent_bait', name: 'Commercial Rodent Bait Monitoring', visitsPerYear: 4, monthly: 80, annual: 960, perApp: 240 };
  const payload = {
    frequencies: [{
      key: 'quarterly',
      label: 'Quarterly',
      monthly: 180,
      annual: 2160,
      perServiceTreatments: [
        { service: 'commercial_pest', label: 'Commercial Pest Control', perTreatment: 200, displayPrice: 200, visitsPerYear: 6 },
        { service: 'commercial_rodent_bait', label: 'Commercial Rodent Bait Monitoring', perTreatment: 240, displayPrice: 240, visitsPerYear: 4 },
      ],
    }],
  };
  const estData = { result: { recurring: { services: [pestRow, rodentRow] } } };

  test('commercial pest section carries its own sold cadence, not the mirrored quarterly', () => {
    const sections = buildPricingServices(payload, {}, estData);
    const pestSection = sections.find((s) => s.key === 'commercial_pest');
    expect(pestSection).toBeTruthy();
    expect(pestSection.frequencies[0]).toMatchObject({ key: 'bi_monthly', label: 'Bi-monthly', visitsPerYear: 6 });
    expect(pestSection.frequencies[0].annual).toBe(1200);
  });

  test('the other commercial service still gets its own section', () => {
    const sections = buildPricingServices(payload, {}, estData);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.some((s) => s.key === 'commercial_rodent_bait')).toBe(true);
  });
});
