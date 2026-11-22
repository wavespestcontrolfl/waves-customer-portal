/**
 * GATE_PEST_PRICE_PHOTO_FACTS (owner 2026-11-21, reply "1, 2").
 *
 * Behavior: when the property lookup's only doubt is the lawn AREA, an
 * automatic pest price keeps the photo's shrubs, complexity and near-water
 * facts. Every other line keeps the neutral defaults the flagged read leaves.
 *
 * Regression this guards: (1) the facts reach a line other than pest (a
 * mosquito price would move by a whole tier); (2) a photo that conflicts with
 * county records, a weak photo or a flagged feature read starts to price;
 * (3) the gate off changes any price.
 *
 * Gap in existing proof: customer-pricing-ai.test.js proves a flagged read
 * drops every feature; nothing covered a per-line exception.
 */
const fs = require('fs');
const path = require('path');

const { lookupLawnAreaIsTheOnlyFeatureDoubt } = require('../services/lookup-confidence');
const { buildCustomerPricingResponse, _private } = require('../services/customer-pricing-ai');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');

const GATE = 'GATE_PEST_PRICE_PHOTO_FACTS';
const LAWN_FLAG = { field: 'estimatedTurfSf', reason: 'AI turf estimate needs review', priority: 'HIGH' };

// A lookup the photo read in full: light shrubs, simple landscape, a canal.
const photoRead = (extra = {}) => ({
  homeSqFt: 2200,
  aiConfidence: 88,
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

const resolve = (enriched) => _private.resolvePropertyContext({
  customer, turfProfile: null, propertyLookup: async () => ({ enriched }),
});

afterEach(() => { delete process.env[GATE]; });

describe('lookupLawnAreaIsTheOnlyFeatureDoubt', () => {
  test('a lawn-area flag on an adequate read is a lawn-area doubt only', () => {
    expect(lookupLawnAreaIsTheOnlyFeatureDoubt(photoRead({ fieldVerifyFlags: [LAWN_FLAG] }))).toBe(true);
  });

  test.each([
    ['no flag at all (the read is trusted, nothing to except)', photoRead()],
    ['a weak photo (grade under 60)', photoRead({ aiConfidence: 52, fieldVerifyFlags: [LAWN_FLAG] })],
    ['a photo that conflicts with county records', photoRead({ turfObservation: 'unobservable', fieldVerifyFlags: [LAWN_FLAG] })],
    ['no lawn number from the photo (county prior)', photoRead({ countyTurfPriorSf: 4100, fieldVerifyFlags: [LAWN_FLAG] })],
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
      propertyLookup: async () => ({ enriched: photoRead({ fieldVerifyFlags: [LAWN_FLAG] }) }),
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
