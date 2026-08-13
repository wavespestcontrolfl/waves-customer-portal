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
    // No vision keys in test env → aiAnalysis null → the DATA slot is never
    // cached. Attempt-lifecycle stamps (markLookupAttempt) are upserts by
    // design — they carry attempt columns only, so the contract pins that no
    // write carried property_record.
    expect(writes.some(([, payload]) => payload && payload.property_record != null)).toBe(false);
    // The attempt lifecycle DID stamp the row (owner ruling 2026-08-11):
    // a record-less lookup must still leave a countable, segmentable row.
    expect(writes.some(([, payload]) => payload && payload.last_attempt_status)).toBe(true);
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

// cacheOnly: the latency-bound probe the service-report cross-sell card uses
// — a miss must return null without ever entering the live pipeline, and a
// hit must skip the backfill provider round-trips.
describe('performPropertyLookup cacheOnly', () => {
  it('a miss returns null and never runs geocode/search/vision', async () => {
    mockDbHandler = () => fakeTable({ row: null });

    const result = await performPropertyLookup(ADDRESS, { cacheOnly: true, persist: false });
    expect(result).toBeNull();
    expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a hit serves the cached row with zero provider calls and zero writes', async () => {
    const writes = [];
    // cachedRow has no _floodZone/_poolPermits/_addressAudit — exactly the
    // shape whose backfills would otherwise fire network calls on a hit.
    mockDbHandler = () => fakeTable({ row: cachedRow(), writes });

    const hit = await performPropertyLookup(ADDRESS, { cacheOnly: true, persist: false });
    expect(hit.meta.cache).toBe('hit');
    expect(hit.enriched.lotSqFt).toBe(10043);
    expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(writes.length).toBe(0);
  });

  it('an unaudited row whose record is a SNAPPED neighbor is a miss, not a hit (PR r18 P1)', async () => {
    // Pre-audit rows carry no _addressAudit. The cache-only path is
    // latency-bound and cannot run the backfill, so returning the row
    // rebuilds the result with no 'address' verification flag — the exact
    // signal every downstream price guard keys on. Here the cached record's
    // house number disagrees with the typed one, so serving it unflagged
    // would let the report cross-sell publish an exact price from the
    // NEIGHBOR's parcel for the rest of the TTL.
    const snapped = cachedRow();
    snapped.property_record.formattedAddress = '2967 Rock Creek Dr, Port Charlotte, FL 33948';
    snapped.property_record.addressLine1 = '2967 Rock Creek Dr';
    mockDbHandler = () => fakeTable({ row: snapped });

    const result = await performPropertyLookup(ADDRESS, { cacheOnly: true, persist: false });
    expect(result).toBeNull();
    expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('an already-audited row still serves on the cache-only path', async () => {
    // The guard is about MISSING audit evidence, not about the audit's
    // verdict — a row that carries one keeps its normal hit.
    const audited = cachedRow();
    audited.property_record._addressAudit = {
      county: 'Charlotte', houseNumber: '2965', streetLabel: 'Rock Creek Dr',
      streetExists: true, hasExactMatch: true, parcelCount: 1, nearestNumbers: [],
    };
    mockDbHandler = () => fakeTable({ row: audited });

    const hit = await performPropertyLookup(ADDRESS, { cacheOnly: true, persist: false });
    expect(hit).not.toBeNull();
    expect(hit.meta.cache).toBe('hit');
  });

  it('cacheOnly combined with refresh still refuses the live pipeline', async () => {
    mockDbHandler = () => fakeTable({ row: cachedRow() });

    const result = await performPropertyLookup(ADDRESS, { cacheOnly: true, refresh: true, persist: false });
    expect(result).toBeNull();
    expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
  });
});
