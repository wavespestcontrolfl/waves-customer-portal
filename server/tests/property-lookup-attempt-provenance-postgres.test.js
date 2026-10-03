/**
 * Attempt provenance on property_lookups, on real PostgreSQL: the live writers
 * (markLookupAttempt / saveLookup) stamp the ids, and the replay harness's
 * selection SQL keeps a failed attempt only when its payload is provably its
 * own. Isolated schema on a loopback waves_test database; synthetic data.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.fn = { now: () => mockPg.fn.now() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { markLookupAttempt, saveLookup, sweepStalePendingAttempts, attachPoolPermitsToCachedLookup, saveVerifiedOverride, addressKey } = require('../services/property-lookup/lookup-cache');
const replay = require('../scripts/property-lookup-replay');

const connection = process.env.LOOKUP_REFRESH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `lookup_prov_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

const addr = (n) => `${n} Fixture St, Fixture, FL 34201`;
const RESULT = {
  propertyRecord: { county: 'Manatee', squareFootage: 1500, _aiProviders: ['fixture'] },
  aiAnalysis: { estimatedTurfSf: 4000 },
  satellite: { lat: 27.4, lng: -82.5 },
  meta: { lookupMs: 1200 },
};

// Rows the replay would select, by normalized address, for one failure mode.
async function selected(flags = []) {
  const { text, values } = replay.buildSelectionQuery(replay.parseArgs(['--since=1h', ...flags]));
  return runPositional(text, values);
}
async function runPositional(text, values) {
  const client = await mockPg.client.acquireConnection();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    return (await client.query(text, values)).rows;
  } finally {
    await mockPg.client.releaseConnection(client);
  }
}
const names = (rows) => rows.map((r) => r.normalized_address).sort();
const norm = (n) => addressKey(addr(n)).normalizedAddress;

postgres('attempt provenance on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('Use an isolated loopback waves_test database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 4 } });
    await require('../models/migrations/20260611000011_property_lookups').up(mockPg);
    await require('../models/migrations/20260812000001_property_lookup_attempt_status').up(mockPg);
    await require('../models/migrations/20260930120000_property_lookup_refresh_claim').up(mockPg);
    await require('../models/migrations/20261003090000_property_lookup_attempt_provenance').up(mockPg);
  });
  afterAll(async () => {
    await mockPg?.destroy();
    await admin?.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await admin?.destroy();
  });
  beforeEach(() => mockPg('property_lookups').del());

  test('migration is reversible and idempotent', async () => {
    const m = require('../models/migrations/20261003090000_property_lookup_attempt_provenance');
    await m.up(mockPg);
    await m.down(mockPg);
    expect(await mockPg.schema.hasColumn('property_lookups', 'payload_attempt_id')).toBe(false);
    expect(await mockPg.schema.hasColumn('property_lookups', 'last_attempt_id')).toBe(false);
    await m.down(mockPg);
    await m.up(mockPg);
    expect(await mockPg.schema.hasColumn('property_lookups', 'last_attempt_id')).toBe(true);
  });

  test('a full attempt stamps one id on both columns; later non-attempt writers keep them', async () => {
    await markLookupAttempt(addr(1), 'pending', null, 'A');
    await saveLookup(addr(1), RESULT, 'A');
    await markLookupAttempt(addr(1), 'no_parcel', null, 'A');
    const row = () => mockPg('property_lookups').where({ address_hash: addressKey(addr(1)).hash }).first();
    expect(await row()).toMatchObject({ payload_attempt_id: 'A', last_attempt_id: 'A' });
    await attachPoolPermitsToCachedLookup(addr(1), { hasPool: false });
    await saveVerifiedOverride(addr(1), { stories: 2 }, 'Tech');
    await sweepStalePendingAttempts();
    expect(await row()).toMatchObject({ payload_attempt_id: 'A', last_attempt_id: 'A' });
  });

  test('a failed refresh moves last_attempt_id and keeps the old payload id', async () => {
    await markLookupAttempt(addr(2), 'pending', null, 'A');
    await saveLookup(addr(2), RESULT, 'A');
    await markLookupAttempt(addr(2), 'resolved', null, 'A');
    await markLookupAttempt(addr(2), 'pending', null, 'B');
    await markLookupAttempt(addr(2), 'no_parcel', null, 'B');
    expect(await mockPg('property_lookups').where({ address_hash: addressKey(addr(2)).hash }).first())
      .toMatchObject({ payload_attempt_id: 'A', last_attempt_id: 'B', last_attempt_status: 'no_parcel' });
  });

  test('selection: exact match in, stale (even a sub-second refresh) out, stubs and cache hits in', async () => {
    // match: payload saved by the stamped attempt
    await markLookupAttempt(addr(10), 'pending', null, 'M');
    await saveLookup(addr(10), RESULT, 'M');
    await markLookupAttempt(addr(10), 'no_parcel', null, 'M');
    // stale: failed refresh over an earlier success, finishing instantly
    await markLookupAttempt(addr(11), 'pending', null, 'S1');
    await saveLookup(addr(11), RESULT, 'S1');
    await markLookupAttempt(addr(11), 'resolved', null, 'S1');
    await markLookupAttempt(addr(11), 'pending', null, 'S2');
    await markLookupAttempt(addr(11), 'no_parcel', null, 'S2');
    // stub: failure with no payload at all
    await markLookupAttempt(addr(12), 'pending', null, 'T');
    await markLookupAttempt(addr(12), 'no_parcel', null, 'T');
    // payload with no id (saved without one) under a later attempt: stale
    await saveLookup(addr(13), RESULT);
    await markLookupAttempt(addr(13), 'no_parcel', null, 'U');
    expect(names(await selected())).toEqual([norm(10), norm(12)].sort());
    // all-failed also admits a cache hit (it served the payload it stamped)
    await markLookupAttempt(addr(14), 'pending', null, 'C1');
    await saveLookup(addr(14), RESULT, 'C1');
    await markLookupAttempt(addr(14), 'cache_hit', null, 'C2');
    expect(names(await selected(['--status=all-failed']))).toEqual([norm(10), norm(12), norm(14)].sort());
  });

  test('legacy rows (both ids NULL) keep the timing window', async () => {
    const base = (n, extra) => ({
      address_hash: addressKey(addr(n)).hash, normalized_address: norm(n), property_record: JSON.stringify({ county: 'Manatee' }),
      last_attempt_status: 'no_parcel', lookup_ms: 2000, ...extra,
    });
    // inside the window: stamp lands lookup_ms after the data start
    await mockPg('property_lookups').insert(base(20, { data_saved_at: mockPg.raw("now() - interval '2 seconds'"), last_attempt_at: mockPg.fn.now() }));
    // outside: payload months older than the stamp
    await mockPg('property_lookups').insert(base(21, { data_saved_at: mockPg.raw("now() - interval '30 days'"), last_attempt_at: mockPg.fn.now() }));
    expect(names(await selected())).toEqual([norm(20)]);
  });
});
