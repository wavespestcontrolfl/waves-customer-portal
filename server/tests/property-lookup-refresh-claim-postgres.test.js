/**
 * Shared live-refresh cooldown on property_lookups, on real PostgreSQL.
 * Isolated schema on a loopback waves_test database; never reads the
 * application's DATABASE_URL.
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
const { claimLiveRefresh, addressKey } = require('../services/property-lookup/lookup-cache');

const connection = process.env.LOOKUP_REFRESH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `lookup_claim_${randomUUID().replaceAll('-', '')}`;
const ADDRESS = '100 Fixture St, Fixture, FL 34201';
let admin;
let mockPg;

postgres('claimLiveRefresh on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('Use an isolated loopback waves_test database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 8 } });
    // The real schema, from the migrations that own it.
    await require('../models/migrations/20260611000011_property_lookups').up(mockPg);
    await require('../models/migrations/20260812000001_property_lookup_attempt_status').up(mockPg);
  });
  afterAll(async () => {
    await mockPg?.destroy();
    await admin?.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await admin?.destroy();
  });
  beforeEach(() => mockPg('property_lookups').del());

  test('concurrent callers on separate connections get exactly one claim', async () => {
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimLiveRefresh(ADDRESS, 120)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const rows = await mockPg('property_lookups');
    expect(rows).toHaveLength(1);
    // A claim row is a stub: it never reads as cached property data, and the
    // attempt counter only moves on the lookup's own stamps.
    expect(rows[0]).toMatchObject({ address_hash: addressKey(ADDRESS).hash, property_record: null, attempt_count: 0 });
  });

  test('a recent attempt refuses the claim without touching the lookup stamps; an old one grants it', async () => {
    const { hash, normalizedAddress } = addressKey(ADDRESS);
    await mockPg('property_lookups').insert({
      address_hash: hash, normalized_address: normalizedAddress, attempt_count: 3,
      last_attempt_status: 'resolved', last_attempt_at: mockPg.raw("now() - interval '30 seconds'"),
    });
    expect(await claimLiveRefresh(ADDRESS, 120)).toBe(false);
    await mockPg('property_lookups').update({ last_attempt_at: mockPg.raw("now() - interval '5 minutes'") });
    expect(await claimLiveRefresh(ADDRESS, 120)).toBe(true);
    expect(await mockPg('property_lookups').first()).toMatchObject({ attempt_count: 3, last_attempt_status: 'resolved' });
  });
});

describe('claimLiveRefresh without a usable table', () => {
  test('fails closed so the caller serves the cache', async () => {
    mockPg = { raw: async () => { throw new Error('relation "property_lookups" does not exist'); } };
    await expect(claimLiveRefresh(ADDRESS, 120)).resolves.toBe(false);
  });
});
