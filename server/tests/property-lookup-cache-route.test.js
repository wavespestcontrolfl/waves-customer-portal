let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../services/property-lookup/ai-property-lookup', () => {
  const actual = jest.requireActual('../services/property-lookup/ai-property-lookup');
  return {
    ...actual,
    lookupPropertyFromAITrio: jest.fn(async () => ({
      formattedAddress: '2965 Rock Creek Dr, Port Charlotte, FL 33948',
      county: 'Charlotte',
      squareFootage: 1348,
      lotSize: 10043,
      stories: 1,
      propertyType: 'Single Family',
      hasPool: false,
      _provider: 'charlotte_pao',
      _source: 'county',
      _aiProviders: ['charlotte_pao'],
      _fieldEvidence: {
        lotSize: { value: 10043, sourceType: 'county', fieldVerify: false, evidence: [] },
      },
      _parcel: {
        parcelId: '402217351013',
        county: 'Charlotte',
        polygon: null,
        polygonAreaSqft: 10085,
      },
    })),
    lookupStoriesFromAI: jest.fn(async () => null),
  };
});

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');

const ADDRESS = '2965 Rock Creek Dr, Port Charlotte, FL 33948';

function fakeTable({ row = null, writes = [] } = {}) {
  const builder = {
    where() { return builder; },
    first: async () => row,
    update: async (payload) => { writes.push(['update', payload]); },
    insert(payload) {
      const done = Promise.resolve();
      return {
        onConflict: () => ({
          merge: async () => { writes.push(['upsert', payload]); },
        }),
        then: (...args) => { writes.push(['insert', payload]); return done.then(...args); },
        catch: (...args) => done.catch(...args),
      };
    },
  };
  return builder;
}

const savedEnv = {};
const KEYS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
const originalFetch = global.fetch;

beforeEach(() => {
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GOOGLE_MAPS_API_KEY = 'current-maps-key';
  lookupPropertyFromAITrio.mockClear();

  global.fetch = jest.fn(async (url) => {
    const urlText = String(url);
    if (urlText.includes('geocode')) {
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [{
            formatted_address: '2965 Rock Creek Dr, Port Charlotte, FL 33948, USA',
            geometry: { location: { lat: 26.9897, lng: -82.139 }, location_type: 'ROOFTOP' },
            address_components: [],
          }],
        }),
      };
    }
    if (urlText.includes('staticmap')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    throw new Error(`unexpected fetch: ${urlText}`);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// Cached-row fixture matching what saveLookup writes for the trio mock above
// (the live path in this test env has no vision keys, so a full row is built
// by hand — saveLookup correctly refuses to cache vision-less lookups).
function cachedRow(extra = {}) {
  return {
    property_record: {
      formattedAddress: ADDRESS,
      county: 'Charlotte',
      squareFootage: 1348,
      lotSize: 10043,
      stories: 1,
      propertyType: 'Single Family',
      hasPool: false,
      _provider: 'charlotte_pao',
      _source: 'county',
      _aiProviders: ['charlotte_pao'],
      _fieldEvidence: {
        lotSize: { value: 10043, sourceType: 'county', fieldVerify: false, evidence: [] },
      },
      _parcel: { parcelId: '402217351013', county: 'Charlotte', polygon: null, polygonAreaSqft: 10085 },
    },
    ai_analysis: { estimatedTurfSf: 6000, confidenceScore: 80 },
    lat: '26.9897',
    lng: '-82.1390',
    verified_overrides: {},
    data_saved_at: '2026-06-11T12:00:00Z',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    updated_at: '2026-06-11T12:00:00Z',
    ...extra,
  };
}

describe('performPropertyLookup cache integration', () => {
  it('a vision-less live lookup is a miss and is NOT cached', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ row: null, writes });

    const live = await performPropertyLookup(ADDRESS);
    expect(live.meta.cache).toBe('miss');
    expect(live.aiAnalysis).toBeNull();
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
    // No vision keys in test env → aiAnalysis null → never cached.
    expect(writes.some(([kind]) => kind === 'upsert')).toBe(false);
  });

  it('hit serves the cached row with key-by-key response shape parity', async () => {
    mockDbHandler = () => fakeTable({ row: null });
    const live = await performPropertyLookup(ADDRESS);

    mockDbHandler = () => fakeTable({ row: cachedRow() });
    const hit = await performPropertyLookup(ADDRESS);
    expect(hit.meta.cache).toBe('hit');
    expect(hit.meta.cachedAt).toBeTruthy();
    // Only the first (live) call ran the trio.
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);

    // Shape parity: same top-level keys as a live response.
    expect(Object.keys(hit).sort()).toEqual(Object.keys(live).sort());
    expect(hit.propertyRecord.squareFootage).toBe(live.propertyRecord.squareFootage);
    expect(hit.aiAnalysis.estimatedTurfSf).toBe(6000);
    expect(hit.rentcast).toBe(hit.propertyRecord);

    // Satellite URLs regenerated with the CURRENT key, never stored ones.
    expect(hit.satellite.closeUrl).toContain('current-maps-key');
    expect(hit.satellite.inServiceArea).toBe(true);
    expect(hit.satellite._closeB64).toBeUndefined();
  });

  it('refresh forces a live lookup even with a fresh row', async () => {
    mockDbHandler = () => fakeTable({ row: cachedRow() });

    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.meta.cache).toBe('refresh');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
  });

  it('verified overrides apply on cache hits and on refresh lookups', async () => {
    // Override is OLDER than data_saved_at — the hit stays valid.
    const overrides = { lotSize: { value: 12000, verifiedBy: 'Adam', verifiedAt: '2026-06-11T00:00:00Z' } };
    const row = cachedRow({ verified_overrides: overrides });
    row.property_record._fieldEvidence.lotSize.fieldVerify = true;
    mockDbHandler = () => fakeTable({ row });

    const hit = await performPropertyLookup(ADDRESS);
    expect(hit.meta.cache).toBe('hit');
    expect(hit.propertyRecord.lotSize).toBe(12000);
    expect(hit.propertyRecord._fieldEvidence.lotSize.sourceType).toBe('verified');
    expect(hit.propertyRecord._fieldEvidence.lotSize.fieldVerify).toBe(false);
    expect(hit.enriched.lotSqFt).toBe(12000);

    const refreshed = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(refreshed.meta.cache).toBe('refresh');
    expect(refreshed.propertyRecord.lotSize).toBe(12000);
    expect(refreshed.propertyRecord._fieldEvidence.lotSize.sourceType).toBe('verified');
  });

  it('an override saved AFTER the cached data forces a live re-run', async () => {
    const overrides = { lotSize: { value: 12000, verifiedAt: '2026-06-11T13:00:00Z' } };
    mockDbHandler = () => fakeTable({ row: cachedRow({ verified_overrides: overrides }) });

    const result = await performPropertyLookup(ADDRESS);
    // data_saved_at (12:00Z) predates the correction (13:00Z) — the stored
    // aiAnalysis was derived from pre-correction facts, so it's a miss.
    expect(result.meta.cache).toBe('miss');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
    expect(result.propertyRecord.lotSize).toBe(12000);
  });

  it('expired rows are misses', async () => {
    mockDbHandler = () => fakeTable({
      row: cachedRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });

    const result = await performPropertyLookup(ADDRESS);
    expect(result.meta.cache).toBe('miss');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
  });

  it('a tech-verified no-pool answer beats satellite vision', () => {
    const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
    const ai = { pool: 'YES', confidenceScore: 80 };

    const unverified = buildEnrichedProfile({ hasPool: false }, ai, 26.99, -82.14);
    expect(unverified.pool).toBe('POSSIBLE');
    expect(unverified.fieldVerifyFlags.some((f) => f.field === 'pool')).toBe(true);

    const verified = buildEnrichedProfile({
      hasPool: false,
      _fieldEvidence: { hasPool: { sourceType: 'verified', fieldVerify: false } },
    }, ai, 26.99, -82.14);
    expect(verified.pool).toBe('NO');
    expect(verified.fieldVerifyFlags.some((f) => f.field === 'pool')).toBe(false);

    const verifiedYes = buildEnrichedProfile({
      hasPool: true,
      _fieldEvidence: { hasPool: { sourceType: 'verified', fieldVerify: false } },
    }, { pool: 'NO' }, 26.99, -82.14);
    expect(verifiedYes.pool).toBe('YES');
  });
});
