/**
 * The commercial-suite-size stamp (server/routes/property-lookup-v2.js,
 * performPropertyLookupCore) must respect `persist:false` exactly like
 * every other cache write on this path — the stamp mutation itself is
 * harmless in-memory bookkeeping, but saveLookup must never be called when
 * the caller asked for a read-only run. Modeled on
 * property-lookup-accuracy-analysis.test.js's mocking pattern.
 */

// Suite sizing ships dark behind GATE_COMMERCIAL_SUITE_SIZING; these tests exercise it ON.
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getVerifiedOverrides: jest.fn(async () => null),
  getCachedLookup: jest.fn(async () => null),
  applyVerifiedOverrides: jest.fn((record) => record),
  saveLookup: jest.fn(async () => {}),
  attachCommercialSuiteSizeToCachedLookup: jest.fn(async () => {}),
}));
jest.mock('../services/property-lookup/fema-nfhl', () => ({ lookupFloodZoneByPoint: jest.fn(async () => null) }));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  ...jest.requireActual('../services/property-lookup/ai-property-lookup'),
  lookupPropertyFromAITrio: jest.fn(),
  lookupStoriesEvidenceFromAI: jest.fn(async () => null),
}));
jest.mock('../services/commercial-suite-size', () => ({
  resolveCommercialSuiteSize: jest.fn(async () => ({
    value: 1400, source: 'license_seats', confidence: 'medium',
    businessName: 'Test Taco Shop', seats: 25,
    evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
  })),
}));

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const { saveLookup } = require('../services/property-lookup/lookup-cache');

const ADDRESS = '4400 Test Commons Pkwy E #102, Bradenton, FL 00000';
const savedFetch = global.fetch;
const savedMapsKey = process.env.GOOGLE_MAPS_API_KEY;

beforeEach(() => {
  lookupPropertyFromAITrio.mockImplementation(async () => ({
    formattedAddress: ADDRESS,
    propertyType: 'Commercial',
    squareFootage: 46031,
    _parcel: { landUseDescription: 'Community Shopping Centers (1555)' },
    unitCount: 1,
    stories: 1,
    _source: 'county',
  }));
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/geocode/')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{ formatted_address: ADDRESS, geometry: { location: { lat: 27.5, lng: -82.45 }, location_type: 'ROOFTOP' } }],
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from('test-image'), headers: { get: () => 'image/png' } };
  });
});

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = savedFetch;
  if (savedMapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = savedMapsKey;
});

test('persist:false resolves and stamps the suite size in-memory but never calls saveLookup', async () => {
  const result = await performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true });
  expect(result.enriched.suiteSize).toEqual(expect.objectContaining({ value: 1400, source: 'license_seats' }));
  expect(result.propertyRecord._commercialSuiteSize).toEqual(expect.objectContaining({ value: 1400 }));
  expect(saveLookup).not.toHaveBeenCalled();
});

test('a persisting run (default) stamps the SAME suite size onto the cached property_record before saveLookup runs', async () => {
  const result = await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
  expect(result.enriched.suiteSize).toEqual(expect.objectContaining({ value: 1400, source: 'license_seats' }));
  expect(saveLookup).toHaveBeenCalledTimes(1);
  const [, savedResult] = saveLookup.mock.calls[0];
  // The exact object saveLookup serializes (JSON.stringify(record) in the
  // real implementation) carries the stamp — a cache hit of this address
  // can reuse it with zero network calls.
  expect(savedResult.propertyRecord._commercialSuiteSize).toEqual(expect.objectContaining({ value: 1400, source: 'license_seats', unitKey: '102' }));
});

test('the lookup\'s remaining budget is passed through as an absolute deadline, not the resolver\'s own full per-leg timeout (primary review PR #4840 r5 P2)', async () => {
  const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
  const before = Date.now();
  await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
  const after = Date.now();
  expect(resolveCommercialSuiteSize).toHaveBeenCalledTimes(1);
  const deadlineAt = resolveCommercialSuiteSize.mock.calls[0][1].deadlineAt;
  // An absolute timestamp near "now + the full ~60s lookup budget" — never
  // undefined (which would mean each network leg gets its own unbounded
  // full timeout on top of everything else this lookup already spent).
  expect(deadlineAt).toBeGreaterThan(before + 40000);
  expect(deadlineAt).toBeLessThanOrEqual(after + 60000);
});

test('a type-default guess is NOT pinned to the cache row, so a later lookup can upgrade it', async () => {
  const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
  resolveCommercialSuiteSize.mockResolvedValueOnce({
    value: 1800, source: 'suite_type_default', confidence: 'low', businessName: null, evidence: [],
  });
  const result = await performPropertyLookup(ADDRESS, { prioritizeAccuracy: true, commercialSuiteSizing: true });
  expect(result.enriched.suiteSize).toEqual(expect.objectContaining({ value: 1800, source: 'suite_type_default' }));
  expect(saveLookup).toHaveBeenCalledTimes(1);
  const [, savedResult] = saveLookup.mock.calls[0];
  expect(savedResult.propertyRecord._commercialSuiteSize).toBeUndefined();
});


describe('cache hit on an older row with no suite stamp', () => {
  const { _private: { buildResultFromCachedLookup } } = require('../routes/property-lookup-v2');
  const { attachCommercialSuiteSizeToCachedLookup } = require('../services/property-lookup/lookup-cache');
  const row = () => ({
    property_record: {
      formattedAddress: ADDRESS, propertyType: 'Commercial', squareFootage: 46031,
      _parcel: { landUseDescription: 'Community Shopping Centers (1555)' }, unitCount: 1, stories: 1, _source: 'county',
    },
    ai_analysis: null, lat: 27.5, lng: -82.45,
  });

  test('a license size resolved on the hit is backfilled onto the cached row, tagged with its unit', async () => {
    const result = await buildResultFromCachedLookup(ADDRESS, row(), null, Date.now(), { commercialSuiteSizing: true });
    expect(result.enriched.suiteSize).toEqual(expect.objectContaining({ value: 1400, source: 'license_seats' }));
    expect(attachCommercialSuiteSizeToCachedLookup).toHaveBeenCalledTimes(1);
    expect(attachCommercialSuiteSizeToCachedLookup.mock.calls[0][1]).toEqual(expect.objectContaining({ value: 1400, unitKey: '102' }));
  });

  test('persist:false and cacheOnly never backfill', async () => {
    await buildResultFromCachedLookup(ADDRESS, row(), null, Date.now(), { commercialSuiteSizing: true, persist: false });
    await buildResultFromCachedLookup(ADDRESS, row(), null, Date.now(), { commercialSuiteSizing: true, cacheOnly: true });
    expect(attachCommercialSuiteSizeToCachedLookup).not.toHaveBeenCalled();
  });
});

describe('GATE_COMMERCIAL_SUITE_SIZING off', () => {
  test('an opt-in caller gets the ordinary lookup: building size, no suite fields, no resolver', async () => {
    const { resolveCommercialSuiteSize } = require('../services/commercial-suite-size');
    const saved = process.env.GATE_COMMERCIAL_SUITE_SIZING;
    delete process.env.GATE_COMMERCIAL_SUITE_SIZING;
    try {
      const result = await performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true, commercialSuiteSizing: true });
      expect(result.enriched.homeSqFt).toBe(46031);
      expect(result.enriched.suiteSize).toBeUndefined();
      expect(result.enriched.suiteBuildingTotalSqFt).toBeUndefined();
      expect(resolveCommercialSuiteSize).not.toHaveBeenCalled();
    } finally {
      process.env.GATE_COMMERCIAL_SUITE_SIZING = saved;
    }
  });
});
