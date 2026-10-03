/**
 * Business identity → scope wiring in the property lookup (address-match
 * PR 5, GATE_LOOKUP_BUSINESS_IDENTITY). Synthetic fixtures only: no real
 * business, address, place id, parcel id or coordinate.
 *
 * The trigger case: a storefront with its own street number inside a plaza
 * parcel whose situs is a different address. No suite typed, no county
 * record (the situs guard dropped the point parcel).
 */

process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';
process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getVerifiedOverrides: jest.fn(async () => null),
  getCachedLookup: jest.fn(async () => null),
  applyVerifiedOverrides: jest.fn((record) => record),
  saveLookup: jest.fn(async () => {}),
  attachCommercialSuiteSizeToCachedLookup: jest.fn(async () => {}),
  attachBusinessIdentityToCachedLookup: jest.fn(async () => {}),
  addressKey: jest.fn((address) => ({ hash: `hash:${String(address).length}` })),
}));
jest.mock('../services/property-lookup/fema-nfhl', () => ({ lookupFloodZoneByPoint: jest.fn(async () => null) }));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  ...jest.requireActual('../services/property-lookup/ai-property-lookup'),
  lookupPropertyFromAITrio: jest.fn(),
  lookupStoriesEvidenceFromAI: jest.fn(async () => null),
}));
jest.mock('../services/commercial-suite-size', () => {
  const { defaultSuiteSizeBasis } = jest.requireActual('../services/commercial-suite-size/type-defaults');
  return {
    resolveCommercialSuiteSize: jest.fn(async ({ commercialRiskType = null, commercialSubtype = null } = {}) => {
      const { sqft, basis } = defaultSuiteSizeBasis({ commercialRiskType, commercialSubtype });
      return {
        value: sqft, source: 'suite_type_default', confidence: 'low', businessName: null, businessType: null, defaultBasis: basis || null, evidence: [],
      };
    }),
  };
});

const { performPropertyLookup, _private } = require('../routes/property-lookup-v2');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const { saveLookup, attachBusinessIdentityToCachedLookup } = require('../services/property-lookup/lookup-cache');

const ADDRESS = '100 Example Plaza Dr, Examplecity, FL 00000';
const savedFetch = global.fetch;
const savedKey = process.env.GOOGLE_MAPS_API_KEY;

function placeAt({ id = 'places/EXAMPLE1', name = 'Example Nail Bar', primaryType = 'nail_salon', number = '100', subpremise = null } = {}) {
  const components = [
    { longText: number, shortText: number, types: ['street_number'] },
    { longText: 'Example Plaza Drive', shortText: 'Example Plaza Dr', types: ['route'] },
  ];
  if (subpremise) components.push({ longText: subpremise, shortText: subpremise, types: ['subpremise'] });
  return {
    id, displayName: { text: name }, primaryType, types: [primaryType, 'establishment'], businessStatus: 'OPERATIONAL', addressComponents: components,
  };
}

let placesReply;
let placesFetch;

function installFetch() {
  placesFetch = jest.fn();
  global.fetch = jest.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('places.googleapis.com')) {
      placesFetch(u, init);
      return placesReply();
    }
    if (u.includes('/geocode/')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{ formatted_address: ADDRESS, types: ['street_address'], geometry: { location: { lat: 27.4, lng: -82.5 }, location_type: 'ROOFTOP' } }],
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from('test-image'), headers: { get: () => 'image/png' } };
  });
}

// The satellite-only record the AI trio returns when the county point parcel
// was dropped by the situs guard: no county evidence, a guessed size.
const noCountyRecord = () => ({
  formattedAddress: ADDRESS, squareFootage: 9000, stories: 1, unitCount: 1, _source: 'ai',
});
const freestandingCountyRecord = () => ({
  formattedAddress: ADDRESS, propertyType: 'Commercial', squareFootage: 4000, stories: 1, unitCount: 1, _source: 'county',
  _parcel: { parcelId: 'EXAMPLE-PARCEL', landUseDescription: 'Restaurant (2100)' },
});
const residentialCountyRecord = () => ({
  formattedAddress: ADDRESS, propertyType: 'Single Family', squareFootage: 2000, stories: 1, unitCount: 1, _source: 'county',
  _parcel: { parcelId: 'EXAMPLE-PARCEL', landUseDescription: 'Single Family (0100)' },
});

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY;
  placesReply = () => ({ ok: true, status: 200, json: async () => ({ places: [placeAt()] }) });
  lookupPropertyFromAITrio.mockImplementation(async () => noCountyRecord());
  installFetch();
});

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = savedFetch;
  delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY;
  if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = savedKey;
});

const run = (options = {}) => performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true, ...options });
const NEW_KEYS = ['serviceScopeDecision', 'serviceScopeQuestion', 'businessIdentity'];

describe('gate off (the default)', () => {
  test('no Places request, no new profile field, nothing about a business on the profile', async () => {
    const result = await run();
    expect(placesFetch).not.toHaveBeenCalled();
    for (const key of NEW_KEYS) expect(result.enriched).not.toHaveProperty(key);
    expect(result.propertyRecord._businessIdentity).toBeUndefined();
    expect(result.enriched.commercialDetectionSource).not.toBe('google_places_business');
  });

  test('the CSR occupancy answer changes nothing while the gate is off', async () => {
    const baseline = await run();
    const answered = await run({ occupancyAnswer: 'suite' });
    expect(placesFetch).not.toHaveBeenCalled();
    expect(answered.enriched).toEqual(baseline.enriched);
  });

  test('gate on but the lookup did not opt in to suite sizing (public routes): no Places request', async () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    const result = await performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true });
    expect(placesFetch).not.toHaveBeenCalled();
    for (const key of NEW_KEYS) expect(result.enriched).not.toHaveProperty(key);
  });

  test('only exactly "true" turns the gate on', async () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = '1';
    await run();
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'TRUE';
    await run();
    expect(placesFetch).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

  test('trigger case: scope_unresolved, the question, and NO priced size', async () => {
    const result = await run();
    const p = result.enriched;
    expect(placesFetch).toHaveBeenCalledTimes(1);
    // The request centers on the geocode point.
    expect(JSON.parse(placesFetch.mock.calls[0][1].body).locationRestriction.circle).toEqual({
      center: { latitude: 27.4, longitude: -82.5 }, radius: 60,
    });
    expect(p.serviceScopeDecision).toBe('scope_unresolved');
    expect(p.serviceScopeQuestion).toBe('Are we treating just your space or the whole building?');
    // Not the whole building's, not the satellite-guessed 9,000 sq ft.
    expect(p.homeSqFt).toBe(0);
    expect(p.footprint).toBe(0);
    expect(p.suiteSize).toBeUndefined();
    expect(p.unitScopedLookup).toBe(true);
    // Classified commercial by the business verdict, flagged.
    expect(p.category).toBe('COMMERCIAL');
    expect(p.isCommercial).toBe(true);
    expect(p.commercialDetectionSource).toBe('google_places_business');
    expect(p.commercialSubtype).toBe('salon_spa');
    const high = p.fieldVerifyFlags.find((f) => f.priority === 'HIGH' && /whole building/.test(f.reason));
    expect(high).toMatchObject({ field: 'squareFootage' });
    const medium = p.fieldVerifyFlags.find((f) => f.field === 'propertyType' && f.priority === 'MEDIUM');
    expect(medium.reason).toBe('Commercial: Google lists a salon or spa at this address — confirm');
  });

  test('the business NAME stays out of every flag; it rides only the admin businessIdentity field', async () => {
    const p = (await run()).enriched;
    expect(JSON.stringify(p.fieldVerifyFlags)).not.toMatch(/Example Nail Bar/);
    expect(p.businessIdentity).toMatchObject({
      name: 'Example Nail Bar', type: 'salon_spa', matchedBy: 'street_number', tenantsAtNumber: 1,
    });
  });

  test('occupancy "suite": the suite path, sized by the business type default (salon 1,200)', async () => {
    const p = (await run({ occupancyAnswer: 'suite' })).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.serviceScopeQuestion).toBeNull();
    expect(p.homeSqFt).toBe(1200);
    expect(p.footprint).toBe(1200);
    expect(p.suiteSize).toMatchObject({ value: 1200, source: 'suite_type_default' });
    expect(p.fieldVerifyFlags.some((f) => f.field === 'squareFootage' && f.priority === 'MEDIUM')).toBe(true);
    expect(p.fieldVerifyFlags.some((f) => f.priority === 'HIGH' && /whole building/.test(f.reason))).toBe(false);
  });

  test('occupancy "building": building scope, the building size is the size, no suite sizing', async () => {
    const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
    const p = (await run({ occupancyAnswer: 'building' })).enriched;
    expect(p.serviceScopeDecision).toBe('entire_commercial_building');
    expect(p.homeSqFt).toBe(9000);
    expect(p.suiteSize).toBeUndefined();
    expect(p.unitScopedLookup).toBe(false);
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
  });

  test('a typed "Ste 3" plus a matched business is a suite with no question', async () => {
    const result = await performPropertyLookup('100 Example Plaza Dr Ste 3, Examplecity, FL 00000', {
      persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true,
    });
    const p = result.enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.serviceScopeQuestion).toBeNull();
    expect(p.homeSqFt).toBe(1200);
  });

  test('a typed Ste 999 with tenants only in other suites: still a shared-building suite, sized by the generic bucket, never the neighbors\' type', async () => {
    placesReply = () => ({
      ok: true,
      json: async () => ({
        places: [
          placeAt({ id: 'places/EXAMPLE1', subpremise: '101' }),
          placeAt({ id: 'places/EXAMPLE2', name: 'Example Hair', primaryType: 'hair_salon', subpremise: '102' }),
        ],
      }),
    });
    const result = await performPropertyLookup('100 Example Plaza Dr Ste 999, Examplecity, FL 00000', {
      persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true,
    });
    const p = result.enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.commercialSubtype).toBe('office_retail');
    expect(p.homeSqFt).toBe(1500);
    expect(p.businessIdentity.type).toBe('office_retail');
  });

  test('a matched place that carries its own subpremise is a suite with nothing typed', async () => {
    placesReply = () => ({ ok: true, json: async () => ({ places: [placeAt({ subpremise: '103' })] }) });
    const p = (await run()).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.businessIdentity.matchedBy).toBe('subpremise');
  });

  test('a multi-tenant street number is a suite (tenants at the number), typed by their shared type', async () => {
    placesReply = () => ({
      ok: true,
      json: async () => ({ places: [placeAt({ id: 'places/EXAMPLE1' }), placeAt({ id: 'places/EXAMPLE2', name: 'Example Hair', primaryType: 'hair_salon' })] }),
    });
    const p = (await run()).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.businessIdentity).toMatchObject({ matchedBy: 'ambiguous_tenants', tenantsAtNumber: 2, type: 'salon_spa' });
    expect(p.homeSqFt).toBe(1200);
  });

  test('a freestanding business with a county record and no part-building evidence is building scope: the county size stands', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => freestandingCountyRecord());
    const p = (await run()).enriched;
    expect(p.serviceScopeDecision).toBe('entire_commercial_building');
    expect(p.homeSqFt).toBe(4000);
    expect(p.suiteSize).toBeUndefined();
    expect(p.fieldVerifyFlags.some((f) => /whole building/.test(f.reason))).toBe(false);
  });

  test('a freestanding business with neighbors around it is still asked, never silently a suite', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => freestandingCountyRecord());
    placesReply = () => ({
      ok: true,
      json: async () => ({ places: [placeAt(), placeAt({ id: 'places/EXAMPLE2', name: 'Example Deli', primaryType: 'restaurant', number: '110' })] }),
    });
    const p = (await run()).enriched;
    expect(p.serviceScopeDecision).toBe('scope_unresolved');
    expect(p.homeSqFt).toBe(0);
  });

  test('a residential county lookup never calls Places and gains no business field', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => residentialCountyRecord());
    const p = (await run()).enriched;
    expect(placesFetch).not.toHaveBeenCalled();
    expect(p.category).toBe('RESIDENTIAL');
    for (const key of NEW_KEYS) expect(p).not.toHaveProperty(key);
  });

  test('no match at the street number: the profile is untouched apart from the admin field', async () => {
    placesReply = () => ({ ok: true, json: async () => ({ places: [placeAt({ number: '120' })] }) });
    const baseline = await (async () => { delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY; const r = await run(); process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; return r.enriched; })();
    const p = (await run()).enriched;
    expect(p).toEqual(baseline);
  });

  test('Places down (fail-open): the lookup is exactly the gate-off lookup', async () => {
    delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY;
    const baseline = (await run()).enriched;
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    placesReply = () => ({ ok: false, status: 503, json: async () => ({}) });
    const p = (await run()).enriched;
    expect(placesFetch).toHaveBeenCalledTimes(1);
    expect(p).toEqual(baseline);
  });

  test('an operating home business at a house with a residential record does not flip it commercial', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => ({
      formattedAddress: ADDRESS, propertyType: 'Single Family', squareFootage: 2000, stories: 1, unitCount: 1, _source: 'ai',
    }));
    const p = (await run()).enriched;
    expect(p.category).toBe('RESIDENTIAL');
    expect(p.serviceScopeDecision).toBeNull();
    expect(p.fieldVerifyFlags.some((f) => /Google lists/.test(f.reason))).toBe(false);
  });
});

describe('the cache', () => {
  beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

  test('a fresh lookup stamps the identity on the record saveLookup serializes', async () => {
    await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
    expect(saveLookup).toHaveBeenCalledTimes(1);
    const [, saved] = saveLookup.mock.calls[0];
    expect(saved.propertyRecord._businessIdentity).toMatchObject({
      source: 'google_places', tenantsAtNumber: 1, matched: expect.objectContaining({ placeId: 'places/EXAMPLE1' }),
    });
    expect(Date.parse(saved.propertyRecord._businessIdentity.fetchedAt)).not.toBeNaN();
  });

  describe('a cache hit', () => {
    const { buildResultFromCachedLookup } = _private;
    const row = (record) => ({ property_record: record, ai_analysis: null, lat: 27.4, lng: -82.5 });
    const stamp = (ageMs) => ({
      source: 'google_places', fetchedAt: new Date(Date.now() - ageMs).toISOString(), radiusM: 60,
      matched: { placeId: 'places/EXAMPLE1', name: 'Example Nail Bar', primaryType: 'nail_salon', type: 'salon_spa', subpremise: null },
      matchedCount: 1, ambiguous: false, tenantsAtNumber: 1, neighbors: 3,
    });

    test('reuses a fresh stamp with zero network', async () => {
      const result = await buildResultFromCachedLookup(ADDRESS, row({ ...noCountyRecord(), _businessIdentity: stamp(1000) }), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).not.toHaveBeenCalled();
      expect(result.enriched.serviceScopeDecision).toBe('scope_unresolved');
    });

    test('re-asks Places for a stamp older than 30 days and persists the new answer', async () => {
      const old = stamp(31 * 24 * 60 * 60 * 1000);
      const record = { ...noCountyRecord(), _businessIdentity: old };
      await buildResultFromCachedLookup(ADDRESS, row(record), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).toHaveBeenCalledTimes(1);
      expect(attachBusinessIdentityToCachedLookup).toHaveBeenCalledTimes(1);
      expect(record._businessIdentity.fetchedAt).not.toBe(old.fetchedAt);
    });

    test('a row with no stamp is asked once and backfilled', async () => {
      await buildResultFromCachedLookup(ADDRESS, row(noCountyRecord()), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).toHaveBeenCalledTimes(1);
      expect(attachBusinessIdentityToCachedLookup).toHaveBeenCalledWith(ADDRESS, expect.objectContaining({ source: 'google_places' }));
    });

    test('persist:false never writes the backfill, and cacheOnly never asks', async () => {
      await buildResultFromCachedLookup(ADDRESS, row(noCountyRecord()), null, Date.now(), { commercialSuiteSizing: true, persist: false });
      expect(attachBusinessIdentityToCachedLookup).not.toHaveBeenCalled();
      placesFetch.mockClear();
      await buildResultFromCachedLookup(ADDRESS, row(noCountyRecord()), null, Date.now(), { commercialSuiteSizing: true, cacheOnly: true });
      expect(placesFetch).not.toHaveBeenCalled();
    });

    test('the CSR\'s occupancy answer re-runs the decision on the cached identity', async () => {
      const record = { ...noCountyRecord(), _businessIdentity: stamp(1000) };
      const asked = await buildResultFromCachedLookup(ADDRESS, row(record), null, Date.now(), { commercialSuiteSizing: true });
      expect(asked.enriched.serviceScopeDecision).toBe('scope_unresolved');
      const answered = await buildResultFromCachedLookup(ADDRESS, row({ ...noCountyRecord(), _businessIdentity: stamp(1000) }), null, Date.now(), {
        commercialSuiteSizing: true, occupancyAnswer: 'suite',
      });
      expect(answered.enriched.serviceScopeDecision).toBe('commercial_suite');
      expect(answered.enriched.homeSqFt).toBe(1200);
      expect(placesFetch).not.toHaveBeenCalled();
    });

    test('a stamp on a residential county record is ignored', async () => {
      const result = await buildResultFromCachedLookup(ADDRESS, row({ ...residentialCountyRecord(), _businessIdentity: stamp(1000) }), null, Date.now(), { commercialSuiteSizing: true });
      expect(result.enriched.category).toBe('RESIDENTIAL');
      for (const key of NEW_KEYS) expect(result.enriched).not.toHaveProperty(key);
    });
  });
});

describe('suite stamp unit key', () => {
  test('a business-identified suite keys on the matched place; a typed unit keeps its own key', () => {
    const { suiteUnitKeyForProfile } = _private;
    expect(suiteUnitKeyForProfile(ADDRESS, { serviceScopeDecision: 'commercial_suite', businessIdentity: { unitKey: 'business:places/EXAMPLE1' } }))
      .toBe('business:places/EXAMPLE1');
    expect(suiteUnitKeyForProfile('100 Example Plaza Dr Ste 3, Examplecity, FL', { serviceScopeDecision: 'commercial_suite', businessIdentity: { unitKey: 'business:places/EXAMPLE1' } }))
      .toBe('3');
    expect(suiteUnitKeyForProfile(ADDRESS, {})).toBeNull();
  });

  test('a persisted stamp is reused only for the same business', () => {
    const { resolveCommercialSuiteScope } = _private;
    const rc = { propertyType: 'Commercial', squareFootage: 9000, _source: 'ai' };
    const stamp = (unitKey) => ({ value: 1100, source: 'license_seats', unitKey, resolvedAt: new Date().toISOString() });
    const scope = (unitKey) => resolveCommercialSuiteScope({ ...rc, _commercialSuiteSize: stamp(unitKey) }, ADDRESS, 'salon_spa', {
      commercialSuiteSizing: true, businessScope: { decision: 'commercial_suite', unitKey: 'business:places/EXAMPLE1' },
    });
    expect(scope('business:places/EXAMPLE1')).toMatchObject({ applies: true, sizeSource: 'stamp' });
    expect(scope('business:places/EXAMPLE2')).toMatchObject({ applies: true, sizeSource: 'candidate' });
  });
});

describe('the admin route body and the coalescing key', () => {
  test('the occupancy body field becomes a lookup option only when it is one of the two answers', () => {
    const { occupancyOption } = _private;
    expect(occupancyOption('suite')).toEqual({ occupancyAnswer: 'suite' });
    expect(occupancyOption(' Building ')).toEqual({ occupancyAnswer: 'building' });
    expect(occupancyOption('maybe')).toEqual({});
    expect(occupancyOption(undefined)).toEqual({});
    expect(occupancyOption({ x: 1 })).toEqual({});
  });

  test('gate off: keys are exactly what they were; gate on: the CSR answer joins the key so answers never share a run', () => {
    const { lookupCoalesceKey } = _private;
    const base = { prioritizeAccuracy: true, commercialSuiteSizing: true };
    const off = lookupCoalesceKey(ADDRESS, base);
    expect(off).toMatch(/:full-analysis:suite-sizing$/);
    expect(lookupCoalesceKey(ADDRESS, { ...base, occupancyAnswer: 'suite' })).toBe(off);
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    const asked = lookupCoalesceKey(ADDRESS, base);
    const suite = lookupCoalesceKey(ADDRESS, { ...base, occupancyAnswer: 'suite' });
    const building = lookupCoalesceKey(ADDRESS, { ...base, occupancyAnswer: 'building' });
    expect(new Set([off, asked, suite, building]).size).toBe(4);
    // Public callers never opt in, so their key never moves.
    expect(lookupCoalesceKey(ADDRESS, { prioritizeAccuracy: true })).toBe(lookupCoalesceKey(ADDRESS, { prioritizeAccuracy: true }));
    expect(lookupCoalesceKey(ADDRESS, { prioritizeAccuracy: true })).not.toMatch(/business-identity/);
  });
});
