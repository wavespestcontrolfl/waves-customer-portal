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

function rowFromUpsert(payload, extra = {}) {
  return {
    ...payload,
    property_record: JSON.parse(payload.property_record),
    ai_analysis: payload.ai_analysis ? JSON.parse(payload.ai_analysis) : null,
    parcel: payload.parcel ? JSON.parse(payload.parcel) : null,
    // pg numeric columns come back as strings.
    lat: payload.lat == null ? null : String(payload.lat),
    lng: payload.lng == null ? null : String(payload.lng),
    verified_overrides: {},
    updated_at: '2026-06-11T12:00:00Z',
    ...extra,
  };
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

describe('performPropertyLookup cache integration', () => {
  it('miss → save → hit, with key-by-key response shape parity', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ row: null, writes });

    const live = await performPropertyLookup(ADDRESS);
    expect(live.meta.cache).toBe('miss');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
    const upsert = writes.find(([kind]) => kind === 'upsert');
    expect(upsert).toBeTruthy();

    const row = rowFromUpsert(upsert[1]);
    mockDbHandler = () => fakeTable({ row });

    const hit = await performPropertyLookup(ADDRESS);
    expect(hit.meta.cache).toBe('hit');
    expect(hit.meta.cachedAt).toBeTruthy();
    // No second live lookup.
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);

    // Shape parity: every top-level key of the live response exists on the
    // hit (meta gains cachedAt; that is additive).
    expect(Object.keys(hit).sort()).toEqual(Object.keys(live).sort());
    expect(hit.propertyRecord.squareFootage).toBe(live.propertyRecord.squareFootage);
    expect(hit.enriched.lotSqFt).toBe(live.enriched.lotSqFt);
    expect(hit.rentcast).toBe(hit.propertyRecord);

    // Satellite URLs regenerated with the CURRENT key, never stored ones.
    expect(hit.satellite.closeUrl).toContain('current-maps-key');
    expect(hit.satellite.inServiceArea).toBe(true);
    expect(hit.satellite._closeB64).toBeUndefined();
  });

  it('refresh forces a live lookup even with a fresh row', async () => {
    const writes = [];
    const row = {
      property_record: { squareFootage: 1348, county: 'Charlotte' },
      ai_analysis: null,
      lat: '26.9897',
      lng: '-82.1390',
      verified_overrides: {},
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      updated_at: '2026-06-11T12:00:00Z',
    };
    mockDbHandler = () => fakeTable({ row, writes });

    const result = await performPropertyLookup(ADDRESS, { refresh: true });
    expect(result.meta.cache).toBe('refresh');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
    expect(writes.some(([kind]) => kind === 'upsert')).toBe(true);
  });

  it('verified overrides apply on cache hits and on refresh lookups', async () => {
    const overrides = { lotSize: { value: 12000, verifiedBy: 'Adam', verifiedAt: '2026-06-11T00:00:00Z' } };
    const row = {
      property_record: {
        squareFootage: 1348,
        lotSize: 10043,
        county: 'Charlotte',
        _fieldEvidence: { lotSize: { value: 10043, sourceType: 'county', fieldVerify: true, evidence: [] } },
      },
      ai_analysis: null,
      lat: '26.9897',
      lng: '-82.1390',
      verified_overrides: overrides,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      updated_at: '2026-06-11T12:00:00Z',
    };
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

  it('expired rows are misses', async () => {
    const row = {
      property_record: { squareFootage: 1348 },
      verified_overrides: {},
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    mockDbHandler = () => fakeTable({ row });

    const result = await performPropertyLookup(ADDRESS);
    expect(result.meta.cache).toBe('miss');
    expect(lookupPropertyFromAITrio).toHaveBeenCalledTimes(1);
  });
});
