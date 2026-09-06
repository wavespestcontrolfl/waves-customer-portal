jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getVerifiedOverrides: jest.fn(async () => null), getCachedLookup: jest.fn(async () => null),
  applyVerifiedOverrides: jest.fn((record) => record),
}));
jest.mock('../services/property-lookup/fema-nfhl', () => ({ lookupFloodZoneByPoint: jest.fn(async () => null) }));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  ...jest.requireActual('../services/property-lookup/ai-property-lookup'),
  lookupPropertyFromAITrio: jest.fn(),
  lookupStoriesEvidenceFromAI: jest.fn(async () => ({ value: 2, confidence: 'high', source: 'county' })),
}));

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const { lookupPropertyFromAITrio, lookupStoriesEvidenceFromAI } = require('../services/property-lookup/ai-property-lookup');
const ADDRESS = '200 Example Way, Bradenton, FL 34203';
const savedFetch = global.fetch;
const savedMapsKey = process.env.GOOGLE_MAPS_API_KEY;

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  global.fetch = savedFetch;
  if (savedMapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = savedMapsKey;
});

test('interactive lookup still attempts vision and retrieves stories after a slow record lookup', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  let now = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  lookupPropertyFromAITrio.mockImplementation(async () => {
    now = 90000;
    return { squareFootage: 2400, lotSize: 10000, propertyType: 'Single Family', stories: null, _source: 'county' };
  });
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/geocode/')) return {
      ok: true,
      json: async () => ({ status: 'OK', results: [{ formatted_address: ADDRESS, geometry: { location: { lat: 27.4, lng: -82.4 }, location_type: 'ROOFTOP' } }] }),
    };
    return { ok: true, arrayBuffer: async () => Buffer.from('test-image'), headers: { get: () => 'image/png' } };
  });
  const result = await performPropertyLookup(ADDRESS, { persist: false, prioritizeAccuracy: true });
  expect(lookupPropertyFromAITrio).toHaveBeenCalledWith(ADDRESS, expect.any(Object), expect.any(Object), { prioritizeAccuracy: true });
  expect(lookupStoriesEvidenceFromAI).toHaveBeenCalled();
  expect(result.enriched.stories).toBe(2);
  expect(result.meta.budgetMs).toBeNull();
  expect(result.errors.some((error) => /Skipped satellite vision|Skipped stories/.test(error.message))).toBe(false);
  // No AI keys in this isolated test: this verdict proves the vision stage
  // was attempted, rather than skipped because of elapsed lookup time.
  expect(result.errors.some((error) => /All AI vision models failed/.test(error.message))).toBe(true);
});
