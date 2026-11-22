/**
 * mail_prospects store against real PostgreSQL: the migration, insert-then-update by the same key, the one-live-row-
 * per-parcel index with its duplicate_parcel fallback, the new-home permit read (both pin forms, the address proof,
 * the open-permit rule, the Eastern 24-month limit; canceled, alteration, ADU and long-finished homes left out) and
 * the known-address read. Made-up rows in a throwaway schema
 * of this worktree's own QA database or CI's database.
 */
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const constructionMigration = require('../models/migrations/20260813000031_construction_permit_records');
const mailMigration = require('../models/migrations/20261122160000_mail_prospects');
const {
  findBySourceRefs, newHomePermitsForParcels, addressKnownToWaves, saveProspect,
} = require('../services/mail/prospect-store');
const { monthsAgoIso } = require('../services/property-lookup/manatee-permit-sync');

jest.setTimeout(60000);

postgres('mail prospect store on PostgreSQL', () => {
  const schema = `mail_prospects_${randomUUID().replaceAll('-', '')}`;
  let admin;
  let conn;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host=, ?port= or
    // ?connectionString= would name another server than the one checked above. A URL with a query is refused,
    // and both pools get the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    const connection = {
      host: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      user: decodeURIComponent(target.username) || undefined,
      password: decodeURIComponent(target.password) || undefined,
      database: target.pathname.slice(1),
    };
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    conn = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
    db.connection = conn;
    await conn.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});
    await constructionMigration.up(conn);
    await mailMigration.up(conn);
    // Only the two columns the known-address read uses; the real table is far larger.
    await conn.schema.createTable('customers', (t) => {
      t.increments('id');
      t.string('address_line1', 200);
      t.string('zip', 10);
    });
  });
  afterAll(async () => {
    if (conn) await conn.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await conn('mail_prospects').del();
    await conn('construction_permit_records').del();
    await conn('customers').del();
  });

  const prospect = (ref, extra = {}) => ({
    list_key: 'new_home', source: 'manatee_clerk_deed', source_ref: ref, recorded_date: '2026-11-17',
    seller_names: ['SAMPLE HOMES LLC'], recipient_names: ['TESTER ALEX J'], buyer_kind: 'person', consideration: 425000,
    legal_description: 'LOT 12 SAMPLE GROVE', status: 'unmatched', reason: 'no_permit', ...extra,
  });
  const live = (ref, pin, extra = {}) => prospect(ref, {
    status: 'eligible', reason: null, match_basis: 'permit', parcel_pin: pin, permit_no: 'BLD9900-0001',
    address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', ...extra,
  });
  // Dates count back from today, so the 24-month bound holds on any run date.
  const dateAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // A permit and a parcel at the same made-up address, unless a test says otherwise.
  const permit = (no, extra = {}) => conn('construction_permit_records').insert({
    permit_no: no, permit_type: 'Residential', type_of_work: 'New Single Family', status: 'Permit Issued',
    issued_date: dateAgo(200), parcel_pin: '5133090590', address_loose_key: '101example34212', ...extra,
  });
  const parcel = (parid, extra = {}) => ({ parid, addressLine1: '101 EXAMPLE TRL', zip: '34212', ...extra });
  const found = async (...parids) => Object.keys(await newHomePermitsForParcels(parids.map((id) => parcel(id)))).sort();

  test('migration: columns, the unique key, the partial index, and a clean down', async () => {
    const idx = (await conn.raw('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?', [schema, 'mail_prospects'])).rows;
    const names = idx.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining([
      'mail_prospects_list_source_ref_key', 'mail_prospects_list_status_idx', 'mail_prospects_recorded_date_idx', 'mail_prospects_one_live_per_parcel',
    ]));
    expect(idx.find((r) => r.indexname === 'mail_prospects_one_live_per_parcel').indexdef).toMatch(/WHERE/);
    await mailMigration.up(conn); // second run: no-op
    await mailMigration.down(conn);
    expect(await conn.schema.hasTable('mail_prospects')).toBe(false);
    await mailMigration.up(conn);
    expect(await conn.schema.hasTable('mail_prospects')).toBe(true);
  });

  test('insert, then an update by the same key keeps one row and keeps first_seen_at', async () => {
    expect(await saveProspect(prospect('202699000001'))).toBe('unmatched');
    const [first] = await conn('mail_prospects').select('*');
    expect(first.state).toBe('FL');
    await conn('mail_prospects').update({ first_seen_at: '2026-11-01T12:00:00Z', last_checked_at: '2026-11-01T12:00:00Z' });
    expect(await saveProspect(live('202699000001', '5133090590'))).toBe('eligible');
    const rows = await conn('mail_prospects').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'eligible', reason: null, parcel_pin: '5133090590', address_line1: '101 EXAMPLE TRL' });
    expect(rows[0].seller_names).toEqual(['SAMPLE HOMES LLC']);
    expect(rows[0].first_seen_at.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(rows[0].last_checked_at.getTime()).toBeGreaterThan(new Date('2026-11-02T00:00:00Z').getTime());
    expect(Number(rows[0].consideration)).toBe(425000);
  });

  test('an update clears fields the new read no longer has', async () => {
    await saveProspect(live('202699000001', '5133090590'));
    await saveProspect(prospect('202699000001'));
    const [row] = await conn('mail_prospects').select('*');
    expect(row).toMatchObject({ status: 'unmatched', parcel_pin: null, permit_no: null, address_line1: null });
  });

  test('a second live row for the same parcel is saved as not_eligible / duplicate_parcel', async () => {
    expect(await saveProspect(live('202699000001', '5133090590'))).toBe('eligible');
    expect(await saveProspect(live('202699000002', '5133090590', { status: 'held_back' }))).toBe('not_eligible');
    const rows = await conn('mail_prospects').orderBy('source_ref');
    expect(rows.map((r) => [r.source_ref, r.status, r.reason])).toEqual([
      ['202699000001', 'eligible', null], ['202699000002', 'not_eligible', 'duplicate_parcel'],
    ]);
  });

  test('the duplicate fallback works inside a caller transaction', async () => {
    await saveProspect(live('202699000001', '5133090590'));
    await conn.transaction(async (trx) => {
      expect(await saveProspect(live('202699000002', '5133090590'), trx)).toBe('not_eligible');
      expect(await saveProspect(prospect('202699000003'), trx)).toBe('unmatched');
    });
    expect(await conn('mail_prospects').count('* as n').first()).toMatchObject({ n: '3' });
  });

  test('findBySourceRefs reads by key and by list', async () => {
    await saveProspect(prospect('202699000001'));
    await saveProspect(prospect('202699000002', { list_key: 'other_list' }));
    const rows = await findBySourceRefs('new_home', 'manatee_clerk_deed', ['202699000001', '202699000002', '202699000003']);
    expect(rows.map((r) => r.source_ref)).toEqual(['202699000001']);
    expect(await findBySourceRefs('new_home', 'manatee_clerk_deed', [])).toEqual([]);
  });

  test('new-home permits: 9-digit and 10-digit forms, the newest permit, and the permits that do not count', async () => {
    await permit('BLD9900-0001', { parcel_pin: '5133090590', issued_date: dateAgo(260) });
    await permit('BLD9900-0002', { parcel_pin: '5133090590', issued_date: dateAgo(200), co_date: dateAgo(20), status: 'Closed' });
    await permit('BLD9900-0003', { parcel_pin: '1000000010' });
    await permit('BLD9900-0004', { parcel_pin: '2000000010', status: 'Canceled' });
    await permit('BLD9900-0005', { parcel_pin: '3000000010', type_of_work: 'Alteration Single Family' });
    await permit('BLD9900-0006', { parcel_pin: '4000000010', type_of_work: 'New Accessory Dwelling Unit' });
    await permit('BLD9900-0007', { parcel_pin: '5000000010', type_of_work: 'New Guest House' });
    await permit('BLD9900-0008', { parcel_pin: '6000000010', permit_type: 'Commercial' });
    await permit('BLD9900-0009', { parcel_pin: '7000000010', status: 'Withdrawn' });
    // Finished more than 24 months ago: a company that sells it now is not its builder.
    await permit('BLD9900-0010', { parcel_pin: '8000000010', issued_date: dateAgo(1200), co_date: dateAgo(800) });
    const parids = ['513309059', '1000000010', '200000001', '300000001', '400000001', '500000001', '600000001', '700000001', '800000001', 'bad'];
    const permits = await newHomePermitsForParcels(parids.map((id) => parcel(id)));
    expect(Object.keys(permits).sort()).toEqual(['1000000010', '513309059']);
    // A finished home's permit is closed: it counts by its certificate. The newest permit of the parcel wins.
    expect(permits['513309059']).toMatchObject({ permit_no: 'BLD9900-0002', co_date: dateAgo(20) });
    expect(permits['1000000010'].permit_no).toBe('BLD9900-0003');
    expect(await newHomePermitsForParcels([])).toEqual({});
    expect(await newHomePermitsForParcels(null)).toEqual({});
  });

  test('new-home permits: with no certificate yet, only a permit the county still lists as open counts', async () => {
    await permit('BLD9900-0011', { parcel_pin: '1100000011' });
    await permit('BLD9900-0012', { parcel_pin: '1200000011', issued_date: dateAgo(800) }); // issued over 24 months ago
    await permit('BLD9900-0013', { parcel_pin: '1300000011', status: 'Closed' }); // closed with no certificate
    await permit('BLD9900-0014', { parcel_pin: '1400000011' });
    await permit('BLD9900-0015', { parcel_pin: '1500000011', issued_date: null });
    // Left the county's report 40 days ago: it keeps its last status, and must not count for ever.
    await conn('construction_permit_records').where({ permit_no: 'BLD9900-0014' }).update({ last_seen_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
    expect(await found('1100000011', '1200000011', '1300000011', '1400000011', '1500000011')).toEqual(['1100000011']);
    // The same four with a recent certificate all count: a finished home needs no open permit.
    await conn('construction_permit_records').whereIn('permit_no', ['BLD9900-0012', 'BLD9900-0013', 'BLD9900-0014', 'BLD9900-0015']).update({ co_date: dateAgo(30) });
    expect(await found('1100000011', '1200000011', '1300000011', '1400000011', '1500000011')).toEqual(['1100000011', '1200000011', '1300000011', '1400000011', '1500000011']);
  });

  test('new-home permits: the 24-month limit counts back from today in Eastern time', async () => {
    const limit = monthsAgoIso(24);
    const dayBefore = new Date(Date.parse(`${limit}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await permit('BLD9900-0016', { parcel_pin: '1600000011', issued_date: dateAgo(900), co_date: limit });
    await permit('BLD9900-0017', { parcel_pin: '1700000011', issued_date: dateAgo(900), co_date: dayBefore });
    expect(await found('1600000011', '1700000011')).toEqual(['1600000011']);
    // 03:00 UTC on Nov 23 is 22:00 on Nov 22 in Florida, so the limit is Nov 22, 2024, not Nov 23.
    await permit('BLD9900-0018', { parcel_pin: '1800000011', issued_date: '2024-03-01', co_date: '2024-11-22' });
    await permit('BLD9900-0019', { parcel_pin: '1900000011', issued_date: '2024-03-01', co_date: '2024-11-21' });
    jest.useFakeTimers({ now: new Date('2026-11-23T03:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    try {
      expect(await found('1800000011', '1900000011')).toEqual(['1800000011']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('new-home permits: a number two parcels can share goes to the parcel at the permit\'s address, whoever is asked', async () => {
    // The pin of the 9-digit parcel 900000009 is 9000000090, which is also the 10-digit parcel 9000000090's own.
    await permit('BLD9900-0020', { parcel_pin: '9000000090', address_loose_key: '900sample34219' });
    const nine = parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219' });
    const ten = parcel('9000000090', { addressLine1: '12 OTHER WAY', zip: '34219' });
    const owners = async (...list) => Object.keys(await newHomePermitsForParcels(list));
    expect(await owners(nine)).toEqual(['900000009']);
    expect(await owners(ten)).toEqual([]);
    expect(await owners(nine, ten)).toEqual(['900000009']);
    expect(await owners(ten, nine)).toEqual(['900000009']);
    // The other way round: the permit's address is the 10-digit parcel's.
    await conn('construction_permit_records').update({ address_loose_key: '12other34219' });
    expect(await owners(nine)).toEqual([]);
    expect(await owners(nine, ten)).toEqual(['9000000090']);
    // No address on one side proves nothing.
    expect(await owners(parcel('9000000090', { addressLine1: null }), parcel('900000009', { addressLine1: 'SAMPLE CT', zip: '34219' }), parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: null }))).toEqual([]);
    await conn('construction_permit_records').update({ address_loose_key: null });
    expect(await owners(nine, ten)).toEqual([]);
  });

  test('addressKnownToWaves: same number, street word and zip is known; anything else is not', async () => {
    await conn('customers').insert([
      { address_line1: '101 Example Trl', zip: '34212' },
      { address_line1: '55 Other St', zip: '34219-1111' },
      { address_line1: null, zip: null },
    ]);
    expect(await addressKnownToWaves('101 EXAMPLE TRL', '34212')).toBe(true);
    expect(await addressKnownToWaves('55 OTHER ST', '34219')).toBe(true);
    expect(await addressKnownToWaves('101 EXAMPLE TRL', '34219')).toBe(false); // same street, other zip
    expect(await addressKnownToWaves('1010 EXAMPLE TRL', '34212')).toBe(false); // different house number
    expect(await addressKnownToWaves('101 ELSEWHERE TRL', '34212')).toBe(false); // different street
    expect(await addressKnownToWaves('EXAMPLE TRL', '34212')).toBe(false); // no house number
    expect(await addressKnownToWaves('101 EXAMPLE TRL', null)).toBe(false);
  });

  test('addressKnownToWaves reads every customer with that house number and zip, however many there are', async () => {
    const others = Array.from({ length: 450 }, (_, i) => ({ address_line1: `77 Street${i} Rd`, zip: '34221' }));
    await conn('customers').insert(others);
    await conn('customers').insert({ address_line1: '77 Lastone Ln', zip: '34221' });
    expect(await addressKnownToWaves('77 LASTONE LN', '34221')).toBe(true);
    expect(await addressKnownToWaves('77 MISSING LN', '34221')).toBe(false);
  });
});
