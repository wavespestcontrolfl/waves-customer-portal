let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
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
    expect(evidence.winningProvider).toBe('Adam');
    // Prior county evidence preserved beneath the verified entry.
    expect(evidence.evidence[0].sourceType).toBe('verified');
    expect(evidence.evidence[1].sourceType).toBe('county');
    expect(rec._verifiedFields).toEqual(['lotSize']);
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
    expect(payload).not.toHaveProperty('verified_overrides');
    expect(JSON.parse(payload.property_record).county).toBe('Charlotte');
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

  it('fails open on db errors', async () => {
    mockDbHandler = () => { throw new Error('db down'); };
    await expect(saveLookup('100 Main St', result)).resolves.toBeUndefined();
  });
});

describe('saveVerifiedOverride', () => {
  it('whitelists fields and merges with existing overrides', async () => {
    const writes = [];
    mockDbHandler = () => ({
      ...fakeTable({ writes }),
      where() { return this; },
      first: async () => ({ id: 'row-1', verified_overrides: { stories: { value: 2 } } }),
      update: async (payload) => { writes.push(['update', payload]); },
    });
    const merged = await saveVerifiedOverride('100 Main St', {
      lotSize: 12000,
      bogusField: 1,
      stories: '',
    }, 'Adam');
    expect(Object.keys(merged).sort()).toEqual(['lotSize', 'stories']);
    expect(merged.lotSize.value).toBe(12000);
    expect(merged.stories.value).toBe(2);
    expect(writes[0][0]).toBe('update');
    expect(JSON.parse(writes[0][1].verified_overrides).lotSize.value).toBe(12000);
  });

  it('creates an override-only stub row when the address was never cached', async () => {
    const writes = [];
    mockDbHandler = () => fakeTable({ row: null, writes });
    const merged = await saveVerifiedOverride('100 Main St', { stories: 2 }, 'Adam');
    expect(merged.stories.value).toBe(2);
    const insert = writes.find(([kind]) => kind === 'insert');
    expect(insert).toBeTruthy();
    expect(insert[1].expires_at).toBeNull();
  });

  it('returns null when nothing verifiable was sent', async () => {
    mockDbHandler = () => fakeTable({});
    expect(await saveVerifiedOverride('100 Main St', { junk: 1 }, 'Adam')).toBeNull();
  });
});
