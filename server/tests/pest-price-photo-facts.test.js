/**
 * GATE_PEST_PRICE_PHOTO_FACTS (owner 2026-11-21, reply "1, 2").
 *
 * Behavior: when the property lookup's only doubt is the lawn AREA, an
 * automatic pest price keeps the photo's shrubs, complexity and near-water
 * facts. Every other line keeps the neutral defaults the flagged read leaves.
 *
 * Regression this guards: (1) the facts reach a line other than pest (a
 * mosquito price would move by a whole tier); (2) a photo that conflicts with
 * county records, a weak or unscored photo, a photo with no lawn number of
 * its own, a flagged feature read, or a fact the vision providers disputed
 * starts to price; (3) the gate off changes any price; (4) the one-time pest
 * price beside a plan stops following the plan's quarterly rate, or a
 * one-time job priced alone starts to read the facts; (5) a "no water" word
 * the map does not know adds the near-water charge.
 *
 * Gap in existing proof: customer-pricing-ai.test.js proves a flagged read
 * drops every feature; nothing covered a per-line exception.
 */
const fs = require('fs');
const path = require('path');

const { lookupLawnAreaIsTheOnlyFeatureDoubt, lookupDisputedPhotoFields } = require('../services/lookup-confidence');
const { buildCustomerPricingResponse, _private } = require('../services/customer-pricing-ai');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');

const GATE = 'GATE_PEST_PRICE_PHOTO_FACTS';
const LAWN_FLAG = { field: 'estimatedTurfSf', reason: 'AI turf estimate needs review', priority: 'HIGH' };

// A lookup the photo read in full: its own lawn number, light shrubs, simple
// landscape, a canal.
const photoRead = (extra = {}) => ({
  homeSqFt: 2200,
  aiConfidence: 88,
  estimatedTurfSf: 4200,
  turfSource: 'vision',
  shrubDensity: 'LIGHT',
  treeDensity: 'LIGHT',
  landscapeComplexity: 'SIMPLE',
  nearWater: 'CANAL_ADJACENT',
  _observed: { shrubDensity: true, treeDensity: true, landscapeComplexity: true, nearWater: true },
  ...extra,
});

const customer = {
  id: 'cust-photo-facts',
  lot_sqft: 9000,
  address_line1: '100 Sample Way',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
};

// The lookup hands back the merged vision analysis beside the profile; its
// aiDivergences list names the fields the providers disagreed on.
const AGREED = { confidenceScore: 88 };
const resolve = (enriched, aiAnalysis = AGREED) => _private.resolvePropertyContext({
  customer, turfProfile: null, propertyLookup: async () => ({ enriched, aiAnalysis }),
});

afterEach(() => { delete process.env[GATE]; });

describe('lookupLawnAreaIsTheOnlyFeatureDoubt', () => {
  test('a lawn-area flag on an adequate read is a lawn-area doubt only', () => {
    expect(lookupLawnAreaIsTheOnlyFeatureDoubt(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }))).toBe(true);
  });

  test.each([
    ['no flag at all (the read is trusted, nothing to except)', photoRead()],
    ['a weak photo (grade under 60)', photoRead({ aiConfidence: 52, fieldVerifyFlags: [LAWN_FLAG] })],
    ['a photo with no grade', photoRead({ aiConfidence: undefined, fieldVerifyFlags: [LAWN_FLAG] })],
    ['a photo that conflicts with county records', photoRead({ turfObservation: 'unobservable', fieldVerifyFlags: [LAWN_FLAG] })],
    ['a lawn number seeded from the county, not the photo', photoRead({
      turfSource: 'county_prior', countyTurfPriorSf: 4100, fieldVerifyFlags: [LAWN_FLAG],
    })],
    ['no lawn number at all', photoRead({ turfSource: 'none', estimatedTurfSf: 0, fieldVerifyFlags: [LAWN_FLAG] })],
    ['a profile that does not say where its lawn number came from', photoRead({
      turfSource: undefined, fieldVerifyFlags: [LAWN_FLAG],
    })],
    ['a wrong-premise flag', photoRead({ fieldVerifyFlags: [LAWN_FLAG, { field: 'address', reason: 'x' }] })],
    ['a flag on the shrub read', photoRead({ fieldVerifyFlags: [LAWN_FLAG, { field: 'shrubDensity', reason: 'x' }] })],
    ['a flag on the pool read', photoRead({ fieldVerifyFlags: [LAWN_FLAG, { field: 'poolCage', reason: 'x' }] })],
    ['a flag on the landscape read', photoRead({ fieldVerifyFlags: [{ field: 'landscapeComplexity', reason: 'x' }] })],
    ['no lookup', null],
  ])('refuses %s', (_label, enriched) => {
    expect(lookupLawnAreaIsTheOnlyFeatureDoubt(enriched)).toBe(false);
  });

  // The rule sorts every flag the lookup raises on estimatedTurfSf by a
  // machine field, never by its prose. A new kind of flag on that field would
  // pass as "lawn area only" by default, so adding one must be a decision.
  test('the lookup raises exactly the five estimatedTurfSf flags the rule sorts', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/property-lookup-v2.js'), 'utf8');
    expect(source.match(/field: 'estimatedTurfSf'/g)).toHaveLength(5);
  });
});

describe('resolvePropertyContext: pestPhotoFacts', () => {
  test('gate off: a lawn-area flag drops the three facts for every line, as before', async () => {
    const ctx = await resolve(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }));
    expect(ctx.propertyInput.pestPhotoFacts).toBeUndefined();
    expect(ctx.propertyInput.features).toMatchObject({ shrubs: 'moderate', complexity: 'moderate', nearWater: false });
  });

  test('gate on: the pest facts ride beside features, and features keep the defaults', async () => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }));
    expect(ctx.propertyInput.pestPhotoFacts).toEqual({ shrubs: 'light', complexity: 'simple', nearWater: true });
    expect(ctx.propertyInput.features).toMatchObject({ shrubs: 'moderate', complexity: 'moderate', nearWater: false });
  });

  test('gate on: an observed "no water" is a fact; a filled-in value is not', async () => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({
      nearWater: 'NONE',
      shrubDensity: 'MODERATE',
      _observed: { shrubDensity: false, landscapeComplexity: true, nearWater: true },
      fieldVerifyFlags: [LAWN_FLAG],
    }));
    expect(ctx.propertyInput.pestPhotoFacts).toEqual({ complexity: 'simple', nearWater: false });
  });

  test('gate on: a fact the vision providers disputed is not kept; the agreed ones are', async () => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }), {
      confidenceScore: 88,
      aiDivergences: [{ field: 'shrubDensity', primary: 'a', a: 'LIGHT', b: 'HEAVY' }],
    });
    expect(ctx.propertyInput.pestPhotoFacts).toEqual({ complexity: 'simple', nearWater: true });
  });

  test('gate on: all three disputed keeps nothing', async () => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }), {
      aiDivergences: ['shrubDensity', 'landscapeComplexity', 'nearWater'].map((field) => ({ field })),
    });
    expect(ctx.propertyInput.pestPhotoFacts).toBeUndefined();
  });

  test.each([
    ['no vision analysis to check for a dispute', photoRead({ fieldVerifyFlags: [LAWN_FLAG] }), null],
    ['a profile with no record of what the photo read', photoRead({ _observed: undefined, fieldVerifyFlags: [LAWN_FLAG] }), AGREED],
  ])('gate on: no pest facts for %s', async (_label, enriched, aiAnalysis) => {
    process.env[GATE] = 'true';
    const ctx = await resolve(enriched, aiAnalysis);
    expect(ctx.propertyInput.pestPhotoFacts).toBeUndefined();
  });

  test.each([
    ['NONE', false],
    ['NO', false],
    ['CANAL_ADJACENT', true],
    ['retention_nearby', true],
  ])('gate on: a near-water reading of %s is the fact %s', async (word, expected) => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({ nearWater: word, fieldVerifyFlags: [LAWN_FLAG] }));
    expect(ctx.propertyInput.pestPhotoFacts).toEqual({ shrubs: 'light', complexity: 'simple', nearWater: expected });
  });

  // A word outside the lookup's own list is not a read: it must not add the
  // near-water charge, and it must not stand for "no water" either.
  test.each(['YES', 'UNKNOWN', 'POSSIBLE'])('gate on: a near-water reading of %s is no fact', async (word) => {
    process.env[GATE] = 'true';
    const ctx = await resolve(photoRead({ nearWater: word, shrubDensity: 'UNKNOWN', fieldVerifyFlags: [LAWN_FLAG] }));
    expect(ctx.propertyInput.pestPhotoFacts).toEqual({ complexity: 'simple' });
  });

  // A new value in the lookup must be sorted into a fact map, or it is
  // silently never a fact. 'NO' is the one legacy word the maps add.
  test('the fact maps cover exactly the values the lookup allows', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/property-lookup-v2.js'), 'utf8');
    for (const [, field, known] of _private.PEST_PHOTO_FACT_READS) {
      const allowed = source.match(new RegExp(`\\n    ${field}: \\[([^\\]]+)\\],`))[1]
        .split(',').map((value) => value.trim().replace(/'/g, ''));
      expect(Object.keys(known).filter((word) => word !== 'NO').sort()).toEqual(allowed.sort());
    }
  });

  // The dispute list is read by field name. The lookup must keep recording
  // these three under the names the profile uses.
  test('the lookup records a dispute on each of the three facts by these names', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/property-lookup-v2.js'), 'utf8');
    const tracked = source.match(/const fieldsToValidate = \[([^\]]+)\]/)[1];
    for (const field of ['shrubDensity', 'landscapeComplexity', 'nearWater']) {
      expect(tracked).toContain(`'${field}'`);
    }
    expect([...lookupDisputedPhotoFields({ aiDivergences: [{ field: 'nearWater' }, null, {}] })]).toEqual(['nearWater']);
    expect(lookupDisputedPhotoFields(null).size).toBe(0);
  });

  test.each([
    ['a trusted read (features already carry the facts)', photoRead()],
    ['a photo that conflicts with county records', photoRead({ turfObservation: 'unobservable', fieldVerifyFlags: [LAWN_FLAG] })],
    ['a weak photo', photoRead({ aiConfidence: 40, fieldVerifyFlags: [LAWN_FLAG] })],
    ['a flag on the shrub read', photoRead({ fieldVerifyFlags: [LAWN_FLAG, { field: 'shrubDensity', reason: 'x' }] })],
  ])('gate on: no pest facts for %s', async (_label, enriched) => {
    process.env[GATE] = 'true';
    const ctx = await resolve(enriched);
    expect(ctx.propertyInput.pestPhotoFacts).toBeUndefined();
  });
});

describe('pricing engine: input.pestPhotoFacts', () => {
  const input = {
    homeSqFt: 2000,
    lotSqFt: 9000,
    stories: 1,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', complexity: 'moderate', nearWater: false },
    services: { pest: { frequency: 'quarterly' }, mosquito: {} },
  };
  const line = (estimate, service) => estimate.lineItems.find((item) => item.service === service);
  const facts = { shrubs: 'light', complexity: 'simple', nearWater: true };

  test('the recurring pest line prices on the photo facts, exactly as if features carried them', () => {
    const base = generateEstimate(input);
    const withFacts = generateEstimate({ ...input, pestPhotoFacts: facts });
    const viaFeatures = generateEstimate({ ...input, features: facts, services: { pest: { frequency: 'quarterly' } } });
    expect(line(withFacts, 'pest_control').perApp).toBe(line(viaFeatures, 'pest_control').perApp);
    expect(line(withFacts, 'pest_control').perApp).not.toBe(line(base, 'pest_control').perApp);
  });

  test('no other line moves', () => {
    const base = generateEstimate(input);
    const withFacts = generateEstimate({ ...input, pestPhotoFacts: facts });
    expect(line(withFacts, 'mosquito')).toEqual(line(base, 'mosquito'));
  });

  // A one-time pest price is the recurring quarterly rate times a multiplier.
  // Beside a recurring pest line it is computed from that line's rate, so it
  // follows the photo facts exactly as it follows the same facts in
  // `features` (a staff estimate). One rate for the plan and the one-time
  // price beside it.
  test.each(['quarterly', 'monthly'])('a one-time pest line beside the %s plan follows the plan rate, as with features', (frequency) => {
    const mixed = { ...input, services: { pest: { frequency }, oneTimePest: {} } };
    const withFacts = generateEstimate({ ...mixed, pestPhotoFacts: facts });
    const viaFeatures = generateEstimate({ ...mixed, features: facts });
    expect(line(withFacts, 'one_time_pest').price).toBe(line(viaFeatures, 'one_time_pest').price);
    expect(line(withFacts, 'pest_control').perApp).toBe(line(viaFeatures, 'pest_control').perApp);
  });

  test('a one-time pest job priced alone never reads the key', () => {
    const alone = { ...input, services: { oneTimePest: {} } };
    expect(line(generateEstimate({ ...alone, pestPhotoFacts: facts }), 'one_time_pest'))
      .toEqual(line(generateEstimate(alone), 'one_time_pest'));
  });

  test('an unknown value leaves the feature as it was', () => {
    const base = generateEstimate(input);
    const junk = generateEstimate({ ...input, pestPhotoFacts: { shrubs: 'JUNK', complexity: 7, nearWater: 'yes' } });
    expect(line(junk, 'pest_control')).toEqual(line(base, 'pest_control'));
  });
});

describe('the customer price path, end to end', () => {
  const pestPerVisit = async () => {
    const result = await buildCustomerPricingResponse({
      db: null,
      customer,
      prompt: 'pest control',
      propertyLookup: async () => ({ enriched: photoRead({ fieldVerifyFlags: [LAWN_FLAG] }), aiAnalysis: AGREED }),
    });
    return result.options.find((option) => option.id === 'pest-quarterly').perVisit;
  };

  test('gate on moves the quoted pest price by the three facts; gate off is the price of today', async () => {
    const off = await pestPerVisit();
    process.env[GATE] = 'true';
    const on = await pestPerVisit();
    // Live defaults: light shrubs -5, simple landscape -5, near water +3.
    expect(on).toBe(off - 7);
  });
});
