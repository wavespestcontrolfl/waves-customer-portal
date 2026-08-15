process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial LAWN apps/year override (owner request 2026-08-15). The admin
// estimator's "Lawn cadence override" sells the commercial turf program at a
// direct applications-per-year count. Unlike the pest cadence override this
// never changes BILLING — commercial lawn bills monthly (annual/12) at every
// cadence — it changes the priced visit count. Unset/unrecognized → the
// pricer keeps COMMERCIAL_LAWN.programVisits (8), i.e. today's behavior.

const {
  resolveCommercialLawnCadenceOverride,
  COMMERCIAL_LAWN_CADENCE_APPS,
} = require('../services/pricing-engine/commercial-risk-type');
const { priceCommercialLawn } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine');

describe('resolveCommercialLawnCadenceOverride', () => {
  test('maps each whitelisted apps/year value (number or string form)', () => {
    for (const apps of COMMERCIAL_LAWN_CADENCE_APPS) {
      expect(resolveCommercialLawnCadenceOverride(apps)).toBe(apps);
      expect(resolveCommercialLawnCadenceOverride(String(apps))).toBe(apps);
    }
  });

  test('unset / unrecognized → null (pricer keeps the 8-visit program default)', () => {
    expect(resolveCommercialLawnCadenceOverride(undefined)).toBe(null);
    expect(resolveCommercialLawnCadenceOverride(null)).toBe(null);
    expect(resolveCommercialLawnCadenceOverride('')).toBe(null);
    expect(resolveCommercialLawnCadenceOverride(0)).toBe(null);
    expect(resolveCommercialLawnCadenceOverride(-4)).toBe(null);
    expect(resolveCommercialLawnCadenceOverride(7)).toBe(null); // not whitelisted
    expect(resolveCommercialLawnCadenceOverride('monthly')).toBe(null); // pest vocabulary, not apps/yr
    expect(resolveCommercialLawnCadenceOverride('4.5')).toBe(null);
  });
});

describe('priceCommercialLawn honors the visits override', () => {
  const PROPERTY = { turfSf: 40000, lotSqFt: 90000 };

  test('default is the 8-visit program', () => {
    const def = priceCommercialLawn(PROPERTY);
    expect(def.visitsPerYear).toBe(8);
    expect(def.frequency).toBe(8);
  });

  test('override scales visits (fewer → cheaper annual, monthly = annual/12 at any cadence)', () => {
    const def = priceCommercialLawn(PROPERTY);
    const quarterly = priceCommercialLawn(PROPERTY, { lawnVisits: 4 });
    const monthly12 = priceCommercialLawn(PROPERTY, { lawnVisits: 12 });
    expect(quarterly.visitsPerYear).toBe(4);
    expect(monthly12.visitsPerYear).toBe(12);
    expect(quarterly.annual).toBeLessThan(def.annual); // less labor/drive → cheaper
    expect(monthly12.annual).toBeGreaterThan(def.annual);
    for (const r of [def, quarterly, monthly12]) {
      expect(r.monthly).toBeCloseTo(Math.round((r.annual / 12) * 100) / 100, 2);
      expect(r.perApp).toBeCloseTo(Math.round((r.annual / r.visitsPerYear) * 100) / 100, 2);
    }
  });

  test('invalid/zero override falls back to the program default', () => {
    expect(priceCommercialLawn(PROPERTY, { lawnVisits: 0 }).visitsPerYear).toBe(8);
    expect(priceCommercialLawn(PROPERTY, { lawnVisits: null }).visitsPerYear).toBe(8);
    expect(priceCommercialLawn(PROPERTY, { lawnVisits: NaN }).visitsPerYear).toBe(8);
  });

  test('the commercial annual minimum still applies at low cadence on small turf', () => {
    const small = priceCommercialLawn({ turfSf: 1500 }, { lawnVisits: 4 });
    const defSmall = priceCommercialLawn({ turfSf: 1500 });
    // Both land on the same account minimum — cadence never prices below it.
    expect(small.annual).toBe(defSmall.annual);
    expect(small.minApplied).toBe(true);
  });

  test('the default app-mix breakdown is only claimed at the default cadence', () => {
    expect(priceCommercialLawn(PROPERTY).program).toEqual(
      { fertApps: 4, preEmergentApps: 2, postEmergentApps: 4, insectApps: 2 }
    );
    expect(priceCommercialLawn(PROPERTY, { lawnVisits: 6 }).program).toBeUndefined();
  });
});

describe('cadence threads through generateEstimate (input.commercialLawnCadence)', () => {
  const base = {
    propertyType: 'commercial',
    isCommercial: true,
    lotSqFt: 60000,
    lawnSqFt: 30000,
    services: { commercialLawn: true, lawn: { track: 'st_augustine' } },
  };
  const lawnLine = (extra = {}) => generateEstimate({ ...base, ...extra })
    .lineItems.find((l) => l.service === 'commercial_lawn');

  test('no override → 8-visit program (today\'s behavior — backward compatible)', () => {
    expect(lawnLine().visitsPerYear).toBe(8);
  });

  test('override reaches the pricer (string form, as the admin select posts it)', () => {
    expect(lawnLine({ commercialLawnCadence: '4' }).visitsPerYear).toBe(4);
    expect(lawnLine({ commercialLawnCadence: 12 }).visitsPerYear).toBe(12);
  });

  test('unrecognized override → program default, never a crash', () => {
    expect(lawnLine({ commercialLawnCadence: 'nonsense' }).visitsPerYear).toBe(8);
  });

  test('lawn override never touches commercial pest cadence (and vice versa)', () => {
    const result = generateEstimate({
      ...base,
      homeSqFt: 20000,
      buildingSqFt: 20000,
      services: { ...base.services, pest: true },
      commercialLawnCadence: '4',
      commercialPestCadence: 'monthly',
    });
    const lawn = result.lineItems.find((l) => l.service === 'commercial_lawn');
    const pest = result.lineItems.find((l) => l.service === 'commercial_pest');
    expect(lawn.visitsPerYear).toBe(4);
    expect(pest.visitsPerYear).toBe(12);
  });
});

describe('estimator adapter forwards commercialLawnCadence', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const commercialProfile = {
    address: '100 Adapter Test Blvd',
    propertyType: 'Commercial',
    isCommercial: true,
    homeSqFt: 3000,
    lotSqFt: 80000,
    lawnSqFt: 30000,
    stories: 1,
  };
  const lawnLine = (profile, options) => generateEstimate(
    translateV2CallToV1Input(profile, ['LAWN'], options)
  ).lineItems.find((l) => l.service === 'commercial_lawn');

  test('options-set override reaches the engine', () => {
    expect(lawnLine(commercialProfile, { commercialLawnCadence: '4' }).visitsPerYear).toBe(4);
  });

  test('profile-persisted override replays on re-price', () => {
    expect(lawnLine({ ...commercialProfile, commercialLawnCadence: '6' }, {}).visitsPerYear).toBe(6);
  });

  test('options beat the persisted profile value', () => {
    expect(lawnLine(
      { ...commercialProfile, commercialLawnCadence: '12' },
      { commercialLawnCadence: '4' }
    ).visitsPerYear).toBe(4);
  });

  test('residential profile clears the override (never leaks into residential lawn pricing)', () => {
    const input = translateV2CallToV1Input(
      { ...commercialProfile, propertyType: 'Single Family', isCommercial: false },
      ['LAWN'],
      { isCommercial: 'NO', commercialLawnCadence: '4' }
    );
    expect(input.commercialLawnCadence).toBe(null);
    expect(input.isCommercial).toBe(false);
  });
});
