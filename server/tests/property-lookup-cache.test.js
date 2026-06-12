let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  addressKey,
  applyVerifiedOverrides,
  attachFloodZoneToCachedLookup,
  getCachedLookup,
  getVerifiedOverrides,
  saveLookup,
  saveVerifiedOverride,
} = require('../services/property-lookup/lookup-cache');

// Chainable stand-in for the knex table builder, recording writes.
function fakeTable({ row = null, writes = [] } = {}) {
  const builder = {
    where() { return builder; },
    first: async () => row,
    update: async (payload) => { writes.push(['update', payload]); },
    insert(payload) {
      const done = Promise.resolve();
      return {
        onConflict: () => ({
          merge: async (mergePayload) => { writes.push(['upsert', payload, mergePayload]); },
        }),
        then: (...args) => { writes.push(['insert', payload]); return done.then(...args); },
        catch: (...args) => done.catch(...args),
      };
    },
  };
  return builder;
}

afterEach(() => {
  delete process.env.PROPERTY_LOOKUP_CACHE_DISABLED;
  delete process.env.PROPERTY_LOOKUP_CACHE_TTL_DAYS;
  mockDbHandler = () => { throw new Error('db handler not configured'); };
});

describe('addressKey', () => {
  it('hashes case/format variants of the same address identically', () => {
    const a = addressKey('4720 60th St W, Bradenton, FL 34210');
    const b = addressKey('4720 60TH ST W, bradenton, fl 34210');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('distinguishes different addresses', () => {
    const a = addressKey('100 Main St, Venice, FL 34285');
    const b = addressKey('102 Main St, Venice, FL 34285');
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('applyVerifiedOverrides', () => {
  function record() {
    return {
      squareFootage: 1348,
      lotSize: 10043,
      stories: 1,
      _fieldEvidence: {
        lotSize: {
          value: 10043,
          sourceType: 'county',
          fieldVerify: true,
          evidence: [{ field: 'lotSize', value: 10043, sourceType: 'county', sourceQuality: 100 }],
        },
      },
    };
  }

  it('verified value beats county and clears the fieldVerify nudge', () => {
    const rec = applyVerifiedOverrides(record(), {
      lotSize: { value: 12000, verifiedBy: 'Adam', verifiedAt: '2026-06-11T00:00:00Z' },
    });
    expect(rec.lotSize).toBe(12000);
    const evidence = rec._fieldEvidence.lotSize;
    expect(evidence.sourceType).toBe('verified');
    expect(evidence.sourceLabel).toBe('tech verified');
    expect(evidence.score).toBe(110);
    expect(evidence.fieldVerify).toBe(false);
    // Verifier identity stays in the DB row only — record-facing evidence
    // carries a generic 'tech' provider, because enriched.fieldEvidence flows
    // verbatim through the unauthenticated public estimator response.
    expect(evidence.winningProvider).toBe('tech');
    expect(JSON.stringify(rec._fieldEvidence)).not.toContain('Adam');
    // Prior county evidence preserved beneath the verified entry.
    expect(evidence.evidence[0].sourceType).toBe('verified');
    expect(evidence.evidence[1].sourceType).toBe('county');
    expect(rec._verifiedFields).toEqual(['lotSize']);
  });

  it('recomputes _dataQuality so the weak-data banner clears after verification', () => {
    const rec = record();
    rec._dataQuality = { level: 'low', fieldVerifyCount: 1 };
    applyVerifiedOverrides(rec, { lotSize: { value: 12000 } });
    expect(rec._dataQuality.fieldVerifyCount).toBe(0);
    expect(rec._dataQuality.verifyCriticalFields).toEqual([]);
  });

  it('ignores non-whitelisted fields and missing values', () => {
    const rec = applyVerifiedOverrides(record(), {
      ownerNames: { value: ['x'] },
      lotSize: { value: undefined },
    });
    expect(rec.lotSize).toBe(10043);
    expect(rec._verifiedFields).toBeUndefined();
  });

  it('passes through null record/overrides', () => {
    expect(applyVerifiedOverrides(null, { lotSize: { value: 1 } })).toBeNull();
    const rec = record();
    expect(applyVerifiedOverrides(rec, null)).toBe(rec);
  });
});

describe('getCachedLookup', () => {
  const freshRow = {
    property_record: { squareFootage: 1348 },
    lat: '26.9897000',
    lng: '-82.1390000',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  };

  it('returns a fresh row', async () => {
    mockDbHandler = () => fakeTable({ row: freshRow });
    expect(await getCachedLookup('100 Main St, Venice, FL 34285')).toBe(freshRow);
  });

  it('returns null on expired rows, override-only stubs, and missing rows', async () => {
    mockDbHandler = () => fakeTable({
      row: { ...freshRow, expires_at: new Date(Date.now() - 1000).toISOString() },
    });
    expect(await getCachedLookup('100 Main St')).toBeNull();

    mockDbHandler = () => fakeTable({ row: { property_record: null, expires_at: freshRow.expires_at } });
    expect(await getCachedLookup('100 Main St')).toBeNull();

    mockDbHandler = () => fakeTable({ row: null });
    expect(await getCachedLookup('100 Main St')).toBeNull();

    // No stored coordinates = no satellite regeneration = miss.
    mockDbHandler = () => fakeTable({ row: { ...freshRow, lat: null, lng: null } });
    expect(await getCachedLookup('100 Main St')).toBeNull();
  });

  it('a verified override newer than the cached data invalidates the hit', async () => {
    const dataSavedAt = '2026-06-11T10:00:00Z';
    const olderVerify = { lotSize: { value: 12000, verifiedAt: '2026-06-11T09:00:00Z' } };
    const newerVerify = { lotSize: { value: 12000, verifiedAt: '2026-06-11T11:00:00Z' } };

    mockDbHandler = () => fakeTable({
      row: { ...freshRow, data_saved_at: dataSavedAt, verified_overrides: olderVerify },
    });
    expect(await getCachedLookup('100 Main St')).toBeTruthy();

    mockDbHandler = () => fakeTable({
      row: { ...freshRow, data_saved_at: dataSavedAt, verified_overrides: newerVerify },
    });
    expect(await getCachedLookup('100 Main St')).toBeNull();

    // Rows that cannot prove data freshness fail toward the live lookup.
    mockDbHandler = () => fakeTable({
      row: { ...freshRow, data_saved_at: null, verified_overrides: newerVerify },
    });
    expect(await getCachedLookup('100 Main St')).toBeNull();
  });

  it('kill switch disables reads but not override reads', async () => {
    process.env.PROPERTY_LOOKUP_CACHE_DISABLED = '1';
    mockDbHandler = () => fakeTable({
      row: { ...freshRow, verified_overrides: { lotSize: { value: 9 } } },
    });
    expect(await getCachedLookup('100 Main St')).toBeNull();
    expect(await getVerifiedOverrides('100 Main St')).toEqual({ lotSize: { value: 9 } });
  });

  it('fails open on db errors', async () => {
    mockDbHandler = () => { throw new Error('db down'); };
    expect(await getCachedLookup('100 Main St')).toBeNull();
    expect(await getVerifiedOverrides('100 Main St')).toBeNull();
  });
});

describe('saveLookup', () => {
  const result = {
    propertyRecord: {
      county: 'Charlotte',
      _parcel: { parcelId: '402217351013', county: 'Charlotte' },
      _aiProviders: ['charlotte_pao'],
    },
    aiAnalysis: { estimatedTurfSf: 6000 },
    enriched: { lotSqFt: 10043 },
    satellite: { lat: 26.9897, lng: -82.139 },
    meta: { lookupMs: 1234 },
  };

  it('upserts the full payload without touching verified_overrides', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('2965 Rock Creek Dr, Port Charlotte, FL 33948', result);
    expect(writes.length).toBe(1);
    const [kind, payload] = writes[0];
    expect(kind).toBe('upsert');
    expect(payload.parcel_id).toBe('402217351013');
    expect(payload.county).toBe('Charlotte');
    expect(payload.lat).toBe(26.9897);
    expect(payload.lookup_ms).toBe(1234);
    expect(payload.expires_at).toBeInstanceOf(Date);
    expect(payload.data_saved_at).toBeInstanceOf(Date);
    expect(payload).not.toHaveProperty('verified_overrides');
    expect(JSON.parse(payload.property_record).county).toBe('Charlotte');
  });

  it('anchors data_saved_at to the lookup start, not the save time', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    const lookupStart = '2026-06-11T15:00:00.000Z';
    await saveLookup('100 Main St', {
      ...result,
      meta: { ...result.meta, timestamp: lookupStart },
    });
    // An override verified mid-lookup (after lookupStart) must compare as
    // NEWER than this so the next cache hit invalidates.
    expect(writes[0][1].data_saved_at.toISOString()).toBe(lookupStart);
  });

  it('never caches a failed lookup and respects the kill switch', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('100 Main St', { propertyRecord: null });
    expect(writes.length).toBe(0);

    process.env.PROPERTY_LOOKUP_CACHE_DISABLED = '1';
    await saveLookup('100 Main St', result);
    expect(writes.length).toBe(0);
  });

  it('never caches a partial lookup without geocoded coordinates', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('100 Main St', { ...result, satellite: null });
    await saveLookup('100 Main St', { ...result, satellite: { lat: null, lng: null } });
    expect(writes.length).toBe(0);
  });

  it('never caches a lookup whose vision pass failed (no aiAnalysis)', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ writes });
    await saveLookup('100 Main St', { ...result, aiAnalysis: null });
    expect(writes.length).toBe(0);
  });

  it('fails open on db errors', async () => {
    mockDbHandler = () => { throw new Error('db down'); };
    await expect(saveLookup('100 Main St', result)).resolves.toBeUndefined();
  });
});

describe('saveVerifiedOverride', () => {
  it('upserts atomically via JSONB merge and returns the stored map', async () => {
    const writes = [];
    const storedRow = {
      verified_overrides: {
        stories: { value: 2 },
        lotSize: { value: 12000, verifiedBy: 'Adam' },
      },
    };
    mockDbHandler = () => fakeTable({ row: storedRow, writes });

    const merged = await saveVerifiedOverride('100 Main St', {
      lotSize: 12000,
      bogusField: 1,
      stories: '',
    }, 'Adam');

    // One atomic upsert — no read-modify-write that could drop a concurrent
    // request's fields.
    expect(writes.length).toBe(1);
    const [kind, insertPayload, mergePayload] = writes[0];
    expect(kind).toBe('upsert');
    expect(insertPayload.expires_at).toBeNull();
    expect(JSON.parse(insertPayload.verified_overrides).lotSize.value).toBe(12000);
    // The merge folds via Postgres JSONB || (existing || excluded).
    expect(mergePayload.verified_overrides.__raw).toContain('||');
    // Returned map comes from the post-upsert re-read (the true DB state).
    expect(merged).toBe(storedRow.verified_overrides);
  });

  it('sanity-bounds values before persisting (overrides never expire)', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ row: null, writes });

    const merged = await saveVerifiedOverride('100 Main St', {
      squareFootage: -5,
      lotSize: 9999999,
      stories: 9,
      yearBuilt: 'next year',
      hasPool: 'yes',
      propertyType: 'Single Family',
    }, 'Adam');

    const stored = JSON.parse(writes[0][1].verified_overrides);
    expect(Object.keys(stored).sort()).toEqual(['hasPool', 'propertyType']);
    expect(stored.hasPool.value).toBe(true);
    expect(stored.propertyType.value).toBe('Single Family');
    expect(merged.hasPool.value).toBe(true);
  });

  it('normalizes enum fields to the canonical pricing values', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ row: null, writes });

    await saveVerifiedOverride('100 Main St', {
      constructionMaterial: 'wood frame',
      roofType: 'tile',
      foundationType: 'raised on pilings',
    }, 'Adam');

    const stored = JSON.parse(writes[0][1].verified_overrides);
    expect(stored.constructionMaterial.value).toBe('WOOD_FRAME');
    expect(stored.roofType.value).toBe('TILE');
    expect(stored.foundationType.value).toBe('RAISED');

    // Unrecognized enum values are dropped, never stored as junk.
    expect(await saveVerifiedOverride('100 Main St', { roofType: 'thatched bamboo' }, 'Adam')).toBeNull();
  });

  it('returns null when nothing verifiable (or nothing valid) was sent', async () => {
    mockDbHandler = () => fakeTable({});
    expect(await saveVerifiedOverride('100 Main St', { junk: 1 }, 'Adam')).toBeNull();
    expect(await saveVerifiedOverride('100 Main St', { stories: 0 }, 'Adam')).toBeNull();
  });
});

describe('attachFloodZoneToCachedLookup (#1698 backfill)', () => {
  test('atomic jsonb merge guarded on key absence — no read-modify-write', async () => {
    const calls = { wheres: [], whereRaws: [], updates: [] };
    mockDbHandler = () => ({
      where(criteria) { calls.wheres.push(criteria); return this; },
      whereNotNull(col) { calls.wheres.push({ notNull: col }); return this; },
      whereRaw(sql) { calls.whereRaws.push(sql); return this; },
      update: async (payload) => { calls.updates.push(payload); return 1; },
    });

    await attachFloodZoneToCachedLookup('123 Test St, Bradenton, FL', {
      floodZone: 'AE', floodZoneSubtype: null, sfha: true,
    });

    // Guard: only rows that do NOT already carry the key are touched.
    expect(calls.whereRaws.some((sql) => sql.includes("_floodZone"))).toBe(true);
    // Payload: a raw `||` merge (recorded by the db.raw mock), never a full
    // record rewrite — and the freshness anchors are deliberately untouched.
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].property_record.__raw).toContain('||');
    expect(calls.updates[0].data_saved_at).toBeUndefined();
    expect(calls.updates[0].expires_at).toBeUndefined();
  });

  test('no-ops without a flood zone and never throws on db failure', async () => {
    mockDbHandler = () => { throw new Error('db down'); };
    await expect(attachFloodZoneToCachedLookup('x', null)).resolves.toBeUndefined();
    await expect(
      attachFloodZoneToCachedLookup('x', { floodZone: 'X', sfha: false }),
    ).resolves.toBeUndefined();
  });
});
