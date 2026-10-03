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

const { performPropertyLookup, translateV2CallToV1Input, _private } = require('../routes/property-lookup-v2');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const { saveLookup } = require('../services/property-lookup/lookup-cache');

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
const NEW_KEYS = ['serviceScopeDecision', 'serviceScopeQuestion', 'serviceScopeSuggestion', 'occupancyAnswer', 'businessIdentity'];
const QUESTION = 'Are we treating just your space or the whole building?';
const withoutNewKeys = (profile) => {
  const rest = { ...profile, fieldVerifyFlags: (profile.fieldVerifyFlags || []).filter((f) => f.source !== 'google_places') };
  for (const key of NEW_KEYS) delete rest[key];
  return rest;
};
const gateOffBaseline = async (options) => {
  delete process.env.GATE_LOOKUP_BUSINESS_IDENTITY;
  const profile = (await run(options)).enriched;
  process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
  return profile;
};

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

  test('trigger case, unanswered: Places only suggests. The profile is the gate-off profile plus the open question, and pricing is refused', async () => {
    const baseline = await gateOffBaseline();
    const p = (await run()).enriched;
    expect(placesFetch).toHaveBeenCalledTimes(1);
    // The request centers on the geocode point.
    expect(JSON.parse(placesFetch.mock.calls[0][1].body).locationRestriction.circle).toEqual({
      center: { latitude: 27.4, longitude: -82.5 }, radius: 60,
    });
    expect(p.serviceScopeDecision).toBe('scope_unresolved');
    expect(p.serviceScopeQuestion).toBe(QUESTION);
    expect(p.serviceScopeSuggestion).toBeNull();
    expect(p.occupancyAnswer).toBeNull();
    // Nothing the listing says is applied: classification and sizes are the gate-off ones.
    expect(withoutNewKeys(p)).toEqual(baseline);
    expect(String(p.commercialDetectionSource)).not.toMatch(/business/);
    const asks = p.fieldVerifyFlags.filter((f) => f.source === 'google_places');
    expect(asks).toEqual([expect.objectContaining({ field: 'squareFootage', priority: 'HIGH' })]);
    expect(asks[0].reason).toContain(QUESTION);
    expect(() => translateV2CallToV1Input(p, ['PEST'], {})).toThrow(expect.objectContaining({ code: 'COMMERCIAL_SCOPE_UNRESOLVED', statusCode: 409 }));
  });

  test('the business NAME and type stay out of every flag; they ride only the admin businessIdentity field', async () => {
    const p = (await run()).enriched;
    expect(JSON.stringify(p.fieldVerifyFlags)).not.toMatch(/Example Nail Bar|salon/i);
    expect(p.businessIdentity).toMatchObject({
      name: 'Example Nail Bar', type: 'salon_spa', matchedBy: 'street_number', tenantsAtNumber: 1,
    });
  });

  test('staff answer "suite": commercial, the business type, the suite path sized by the type default (salon 1,200)', async () => {
    const p = (await run({ occupancyAnswer: 'suite' })).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.serviceScopeQuestion).toBeNull();
    expect(p.occupancyAnswer).toBe('suite');
    expect(p.category).toBe('COMMERCIAL');
    expect(p.isCommercial).toBe(true);
    expect(p.commercialSubtype).toBe('salon_spa');
    expect(p.commercialDetectionSource).toBe('staff_confirmed_business');
    expect(p.homeSqFt).toBe(1200);
    expect(p.footprint).toBe(1200);
    expect(p.suiteSize).toMatchObject({ value: 1200, source: 'suite_type_default' });
    expect(p.fieldVerifyFlags.some((f) => f.field === 'squareFootage' && f.priority === 'MEDIUM')).toBe(true);
    expect(p.fieldVerifyFlags.some((f) => f.source === 'google_places')).toBe(false);
    const { unresolvedScopeError } = require('../services/property-lookup/business-scope');
    expect(unresolvedScopeError(p)).toBeNull();
  });

  test('staff answer "building": building scope, the building size is the size, no suite sizing', async () => {
    const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
    const p = (await run({ occupancyAnswer: 'building' })).enriched;
    expect(p.serviceScopeDecision).toBe('entire_commercial_building');
    expect(p.category).toBe('COMMERCIAL');
    expect(p.homeSqFt).toBe(9000);
    expect(p.suiteSize).toBeUndefined();
    expect(p.unitScopedLookup).toBe(false);
    expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
  });

  test('staff answer "none" (not this business): the gate-off profile, nothing asked, pricing allowed, the listing still shown', async () => {
    const baseline = await gateOffBaseline();
    const p = (await run({ occupancyAnswer: 'none' })).enriched;
    expect(p.occupancyAnswer).toBe('none');
    expect(p.serviceScopeDecision).toBeNull();
    expect(p.serviceScopeQuestion).toBeNull();
    expect(p.businessIdentity).toMatchObject({ name: 'Example Nail Bar' });
    expect(withoutNewKeys(p)).toEqual(baseline);
    const { unresolvedScopeError } = require('../services/property-lookup/business-scope');
    expect(unresolvedScopeError(p)).toBeNull();
  });

  test('a typed "Ste 3" plus a matched business only suggests a suite; staff answering makes it one', async () => {
    const typed = (options = {}) => performPropertyLookup('100 Example Plaza Dr Ste 3, Examplecity, FL 00000', {
      persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true, ...options,
    });
    const asked = (await typed()).enriched;
    expect(asked).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'suite' });
    const p = (await typed({ occupancyAnswer: 'suite' })).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.homeSqFt).toBe(1200);
  });

  test('a typed Ste 999 with tenants only in other suites: a suggested suite; answered, sized by the generic bucket, never the neighbors\' type', async () => {
    placesReply = () => ({
      ok: true,
      json: async () => ({
        places: [
          placeAt({ id: 'places/EXAMPLE1', subpremise: '101' }),
          placeAt({ id: 'places/EXAMPLE2', name: 'Example Hair', primaryType: 'hair_salon', subpremise: '102' }),
        ],
      }),
    });
    const typed = (options = {}) => performPropertyLookup('100 Example Plaza Dr Ste 999, Examplecity, FL 00000', {
      persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true, ...options,
    });
    expect((await typed()).enriched).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'suite' });
    const p = (await typed({ occupancyAnswer: 'suite' })).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.commercialSubtype).toBe('office_retail');
    expect(p.homeSqFt).toBe(1500);
    expect(p.businessIdentity.type).toBe('office_retail');
  });

  test('a matched place that carries its own subpremise suggests a suite with nothing typed', async () => {
    placesReply = () => ({ ok: true, json: async () => ({ places: [placeAt({ subpremise: '103' })] }) });
    const p = (await run()).enriched;
    expect(p).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'suite' });
    expect(p.businessIdentity.matchedBy).toBe('subpremise');
  });

  test('a multi-tenant street number suggests a suite; answered, it is typed by the tenants\' shared type', async () => {
    placesReply = () => ({
      ok: true,
      json: async () => ({ places: [placeAt({ id: 'places/EXAMPLE1' }), placeAt({ id: 'places/EXAMPLE2', name: 'Example Hair', primaryType: 'hair_salon' })] }),
    });
    const asked = (await run()).enriched;
    expect(asked).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'suite' });
    expect(asked.businessIdentity).toMatchObject({ matchedBy: 'ambiguous_tenants', tenantsAtNumber: 2, type: 'salon_spa' });
    const p = (await run({ occupancyAnswer: 'suite' })).enriched;
    expect(p.serviceScopeDecision).toBe('commercial_suite');
    expect(p.commercialSubtype).toBe('salon_spa');
    expect(p.homeSqFt).toBe(1200);
  });

  test('a freestanding business with a county record suggests the building and still asks; answered, the county size stands', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => freestandingCountyRecord());
    const asked = (await run()).enriched;
    expect(asked).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'building' });
    // An open question on a commercial lookup prices no size.
    expect(asked.homeSqFt).toBe(0);
    const p = (await run({ occupancyAnswer: 'building' })).enriched;
    expect(p.serviceScopeDecision).toBe('entire_commercial_building');
    expect(p.homeSqFt).toBe(4000);
    expect(p.suiteSize).toBeUndefined();
    expect(p.fieldVerifyFlags.some((f) => /whole building/.test(f.reason))).toBe(false);
  });

  test('a freestanding business with neighbors around it is asked with no suggestion, never silently a suite', async () => {
    lookupPropertyFromAITrio.mockImplementation(async () => freestandingCountyRecord());
    placesReply = () => ({
      ok: true,
      json: async () => ({ places: [placeAt(), placeAt({ id: 'places/EXAMPLE2', name: 'Example Deli', primaryType: 'restaurant', number: '110' })] }),
    });
    const p = (await run()).enriched;
    expect(p).toMatchObject({ serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: null });
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
    for (const key of NEW_KEYS) expect(p).not.toHaveProperty(key);
    expect(p.fieldVerifyFlags.some((f) => f.source === 'google_places')).toBe(false);
  });
});

describe('nothing from Places is stored', () => {
  beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

  test('a fresh lookup saves a record with no identity on it', async () => {
    const result = await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
    expect(result.enriched.serviceScopeDecision).toBe('scope_unresolved');
    expect(saveLookup).toHaveBeenCalledTimes(1);
    const [, saved] = saveLookup.mock.calls[0];
    expect(saved.propertyRecord).not.toHaveProperty('_businessIdentity');
    expect(JSON.stringify(saved.propertyRecord)).not.toMatch(/Example Nail Bar|nail_salon/);
  });

  describe('a cache hit', () => {
    const { buildResultFromCachedLookup } = _private;
    const row = (record) => ({ property_record: record, ai_analysis: null, lat: 27.4, lng: -82.5 });

    test('asks Places again every time and leaves the cached record untouched', async () => {
      const record = noCountyRecord();
      const first = await buildResultFromCachedLookup(ADDRESS, row(record), null, Date.now(), { commercialSuiteSizing: true });
      await buildResultFromCachedLookup(ADDRESS, row(record), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).toHaveBeenCalledTimes(2);
      expect(first.enriched.serviceScopeDecision).toBe('scope_unresolved');
      expect(record).not.toHaveProperty('_businessIdentity');
    });

    test('an identity left on an old cached record is never read', async () => {
      placesReply = () => ({ ok: true, status: 200, json: async () => ({ places: [] }) });
      const leftover = {
        source: 'google_places', fetchedAt: new Date().toISOString(), radiusM: 60,
        matched: { placeId: 'places/EXAMPLE1', name: 'Example Nail Bar', primaryType: 'nail_salon', type: 'salon_spa', subpremise: null },
        matchedCount: 1, ambiguous: false, tenantsAtNumber: 1, neighbors: 3,
      };
      const result = await buildResultFromCachedLookup(ADDRESS, row({ ...noCountyRecord(), _businessIdentity: leftover }), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).toHaveBeenCalledTimes(1);
      for (const key of NEW_KEYS) expect(result.enriched).not.toHaveProperty(key);
    });

    test('cacheOnly never asks', async () => {
      await buildResultFromCachedLookup(ADDRESS, row(noCountyRecord()), null, Date.now(), { commercialSuiteSizing: true, cacheOnly: true });
      expect(placesFetch).not.toHaveBeenCalled();
    });

    test('the CSR\'s occupancy answer decides the scope', async () => {
      const answered = await buildResultFromCachedLookup(ADDRESS, row(noCountyRecord()), null, Date.now(), {
        commercialSuiteSizing: true, occupancyAnswer: 'suite',
      });
      expect(answered.enriched.serviceScopeDecision).toBe('commercial_suite');
      expect(answered.enriched.homeSqFt).toBe(1200);
    });

    test('a residential county record is never asked about', async () => {
      const result = await buildResultFromCachedLookup(ADDRESS, row(residentialCountyRecord()), null, Date.now(), { commercialSuiteSizing: true });
      expect(placesFetch).not.toHaveBeenCalled();
      expect(result.enriched.category).toBe('RESIDENTIAL');
      for (const key of NEW_KEYS) expect(result.enriched).not.toHaveProperty(key);
    });
  });
});

describe('the stored lookup snapshot', () => {
  const { enrichedSnapshotForStorage } = jest.requireActual('../services/property-lookup/lookup-cache');
  beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

  test('unanswered: the stored snapshot carries no listing, no suggestion, no open question and no flag resting on the listing', async () => {
    const result = await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
    expect(result.enriched.businessIdentity).toMatchObject({ name: 'Example Nail Bar' });
    const [, saved] = saveLookup.mock.calls[0];
    const stored = enrichedSnapshotForStorage(saved.enriched);
    for (const key of NEW_KEYS) expect(stored).not.toHaveProperty(key);
    expect(stored.fieldVerifyFlags.some((f) => f.source === 'google_places')).toBe(false);
    expect(JSON.stringify(stored)).not.toMatch(/Example Nail Bar|nail_salon|salon_spa|places\/EXAMPLE1|whole building/);
    expect(stored).toEqual(withoutNewKeys(saved.enriched));
    // The live response is not mutated by storing it.
    expect(saved.enriched.businessIdentity).toMatchObject({ name: 'Example Nail Bar' });
    expect(saved.enriched.serviceScopeDecision).toBe('scope_unresolved');
  });

  test('answered: the snapshot keeps what staff confirmed (decision, answer, type) and still not the listing', async () => {
    await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true, occupancyAnswer: 'suite' });
    const [, saved] = saveLookup.mock.calls[0];
    const stored = enrichedSnapshotForStorage(saved.enriched);
    expect(stored).toMatchObject({ serviceScopeDecision: 'commercial_suite', occupancyAnswer: 'suite', commercialDetectionSource: 'staff_confirmed_business' });
    expect(stored).not.toHaveProperty('businessIdentity');
    expect(stored).not.toHaveProperty('serviceScopeSuggestion');
    expect(JSON.stringify(stored)).not.toMatch(/Example Nail Bar|nail_salon/);
  });

  test('a profile with no business identity is stored as it is', () => {
    const profile = { category: 'RESIDENTIAL', homeSqFt: 2000 };
    expect(enrichedSnapshotForStorage(profile)).toBe(profile);
    expect(enrichedSnapshotForStorage(null)).toBeNull();
  });
});

describe('an answered lookup whose Places re-check fails', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  beforeEach(() => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    placesReply = () => ({ ok: false, status: 503, json: async () => ({}) });
  });

  test('the answer is not dropped into whole-building pricing: the question stays open and pricing is refused', async () => {
    const p = (await run({ occupancyAnswer: 'suite' })).enriched;
    expect(placesFetch).toHaveBeenCalledTimes(1);
    expect(p.serviceScopeDecision).toBe('scope_unresolved');
    expect(p.serviceScopeQuestion).toBe('Are we treating just your space or the whole building?');
    expect(p.occupancyAnswer).toBeNull();
    expect(p).not.toHaveProperty('businessIdentity');
    expect(p.fieldVerifyFlags.some((f) => f.priority === 'HIGH' && /Could not confirm the business/.test(f.reason))).toBe(true);
    expect(() => translateV2CallToV1Input(p, ['PEST'], {})).toThrow(expect.objectContaining({ code: 'COMMERCIAL_SCOPE_UNRESOLVED', statusCode: 409 }));
  });

  test('a reply that finds no business at the number this time keeps the question open too', async () => {
    for (const places of [[], [placeAt({ number: '300' })]]) {
      placesReply = () => ({ ok: true, status: 200, json: async () => ({ places }) });
      const p = (await run({ occupancyAnswer: 'suite' })).enriched;
      expect(p.serviceScopeDecision).toBe('scope_unresolved');
      expect(p.occupancyAnswer).toBeNull();
      expect(() => translateV2CallToV1Input(p, ['PEST'], {})).toThrow(expect.objectContaining({ code: 'COMMERCIAL_SCOPE_UNRESOLVED' }));
    }
  });

  test('with no answer sent, a failed Places call is still no signal at all', async () => {
    const p = (await run()).enriched;
    for (const key of NEW_KEYS) expect(p).not.toHaveProperty(key);
  });
});

describe('the lookup time budget', () => {
  const { prepareBusinessIdentity } = _private;
  const input = (budgetMs) => ({
    record: noCountyRecord(), aiAnalysis: null, address: ADDRESS, lat: 27.4, lng: -82.5, options: { commercialSuiteSizing: true }, budgetMs,
  });
  beforeEach(() => { process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true'; });

  test('with too little of the lookup budget left the leg is skipped, not started', async () => {
    expect(await prepareBusinessIdentity(input(0))).toBeNull();
    expect(await prepareBusinessIdentity(input(299))).toBeNull();
    expect(placesFetch).not.toHaveBeenCalled();
  });

  test('a short remaining budget caps the request; it never waits past it', async () => {
    placesReply = () => new Promise(() => {});
    global.fetch = jest.fn((url, init) => new Promise((resolve, reject) => {
      placesFetch(String(url), init);
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const started = Date.now();
    expect(await prepareBusinessIdentity(input(350))).toBeNull();
    expect(placesFetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('no deadline (accuracy mode) or plenty of budget asks as usual', async () => {
    expect(await prepareBusinessIdentity(input(null))).toMatchObject({ source: 'google_places' });
    expect(await prepareBusinessIdentity(input(30000))).toMatchObject({ source: 'google_places' });
    expect(placesFetch).toHaveBeenCalledTimes(2);
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

describe('the pricing boundary refuses an unanswered scope (409 COMMERCIAL_SCOPE_UNRESOLVED)', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
  const QUESTION = 'Are we treating just your space or the whole building?';
  const unresolved = (over = {}) => ({
    isCommercial: true, propertyType: 'Commercial', commercialSubtype: 'salon_spa', homeSqFt: 1200,
    serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: QUESTION, occupancyAnswer: null, ...over,
  });
  const translate = (profile) => translateV2CallToV1Input(profile, ['pest'], {});

  test('an unanswered profile throws a fail-closed 409 carrying the question, even with a typed size', () => {
    let caught;
    try { translate(unresolved()); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.statusCode).toBe(409);
    expect(caught.code).toBe('COMMERCIAL_SCOPE_UNRESOLVED');
    expect(caught.failClosed).toBe(true);
    expect(caught.metadata).toEqual({ question: QUESTION });
    expect(caught.message).toContain(QUESTION);
  });

  test('an answered profile proceeds: the occupancy answer on the profile, or a decision the lookup re-ran to', () => {
    expect(() => translate(unresolved({ occupancyAnswer: 'suite' }))).not.toThrow();
    expect(() => translate(unresolved({ occupancyAnswer: 'building' }))).not.toThrow();
    expect(() => translate(unresolved({ serviceScopeDecision: 'commercial_suite' }))).not.toThrow();
    expect(() => translate(unresolved({ serviceScopeDecision: 'entire_commercial_building' }))).not.toThrow();
  });

  test('a profile with no business verdict (gate off, public quote) is untouched', () => {
    expect(() => translate({ isCommercial: true, propertyType: 'Commercial', homeSqFt: 1200 })).not.toThrow();
    expect(() => translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 8000, stories: 1 }, ['pest'], {})).not.toThrow();
  });

  test('the save-time recompute rethrows the refusal instead of falling back to the browser price', async () => {
    const estimateData = { engineRequest: { profile: unresolved(), selectedServices: ['pest'], options: {} } };
    await expect(serverRecomputeFromEstimateData(estimateData, {})).rejects.toMatchObject({
      statusCode: 409, code: 'COMMERCIAL_SCOPE_UNRESOLVED',
    });
  });

  test('the lookup profile stamps the CSR answer so the estimate inputs carry it', async () => {
    process.env.GATE_LOOKUP_BUSINESS_IDENTITY = 'true';
    const asked = (await run()).enriched;
    expect(asked.occupancyAnswer).toBeNull();
    expect(() => translate({ ...asked, homeSqFt: 1200 })).toThrow(/COMMERCIAL_SCOPE|whole building/);
    const answered = (await run({ occupancyAnswer: 'suite' })).enriched;
    expect(answered.occupancyAnswer).toBe('suite');
    expect(() => translate(answered)).not.toThrow();
  });
});
