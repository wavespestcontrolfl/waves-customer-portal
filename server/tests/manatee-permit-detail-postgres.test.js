/**
 * Permit detail collector against real PostgreSQL: the migration's columns,
 * the candidate query (new-dwelling vocabulary, never-tried, re-read when a
 * CO date appears, retry windows, order, cap), the write path, and the read
 * helper's tier precedence. Synthetic permits in a throwaway schema; skipped
 * without DATABASE_URL (runs in the DB-gated CI step).
 */
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
const detailMigration = require('../models/migrations/20261002220000_construction_permit_detail');
const {
  findPermitBuildingFacts,
  _private: { selectCandidates, recordResult },
} = require('../services/property-lookup/manatee-permit-detail');
const { _private: { normalizeConstructionRow } } = require('../services/property-lookup/manatee-permit-sync');

jest.setTimeout(60000);

const DETAIL_COLUMNS = [
  'conditioned_sqft', 'under_roof_sqft', 'stories', 'bedrooms', 'bathrooms',
  'detail_status', 'detail_fetched_at', 'detail_co_date',
];
const DAY = 24 * 60 * 60 * 1000;

postgres('permit detail collector on PostgreSQL', () => {
  const schema = `permit_detail_${randomUUID().replaceAll('-', '')}`;
  let admin;
  let conn;
  const now = Date.now();
  const ago = (days) => new Date(now - days * DAY);

  beforeAll(async () => {
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    conn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    db.connection = conn;
    await conn.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});
    await constructionMigration.up(conn);
    await detailMigration.up(conn);
  });
  afterAll(async () => {
    if (conn) await conn.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
      await admin.destroy();
    }
  });
  beforeEach(async () => { await conn('construction_permit_records').del(); });

  const insert = (permit_no, extra = {}) => conn('construction_permit_records').insert({
    permit_no, type_of_work: 'New Single Family', status: 'Permit Issued', issued_date: '2026-05-01', ...extra,
  });

  test('migration adds the eight nullable columns, is re-runnable, and reverses cleanly', async () => {
    const cols = async () => (await conn.raw(
      "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = 'construction_permit_records'",
      [schema],
    )).rows;
    let rows = await cols();
    for (const c of DETAIL_COLUMNS) {
      const r = rows.find((x) => x.column_name === c);
      expect(r).toBeTruthy();
      expect(r.is_nullable).toBe('YES');
      expect(r.column_default).toBeNull();
    }
    await detailMigration.up(conn); // second run: no-op, no throw
    await detailMigration.down(conn);
    rows = await cols();
    expect(DETAIL_COLUMNS.some((c) => rows.find((x) => x.column_name === c))).toBe(false);
    expect(rows.find((x) => x.column_name === 'permit_no')).toBeTruthy();
    await detailMigration.down(conn); // second run: no-op
    await detailMigration.up(conn);
    expect((await cols()).filter((x) => DETAIL_COLUMNS.includes(x.column_name))).toHaveLength(DETAIL_COLUMNS.length);
  });

  test('the report sync never writes the detail columns', () => {
    const uc = normalizeConstructionRow({
      Permit: 'BLD9801-0001', CurrentStatus: 'Permit Issued', IssuedDate: '3/2/2026', Type: 'Residential',
      TypeofWork: ' New Single Family', Parcel: '1234567890000-1111111111', JobAddress: '100 SAMPLE CV  BRADENTON 34212',
    }, 'under_construction');
    const co = normalizeConstructionRow({ Permit: 'BLD9801-0001', Status: 'Closed', CODate: '8/20/2026' }, 'cos');
    for (const out of [uc, co]) {
      expect(Object.keys(out).filter((k) => DETAIL_COLUMNS.includes(k))).toEqual([]);
    }
  });

  test('candidates: vocabulary, never tried, CO appeared, retry windows, newest first, capped', async () => {
    await insert('BLD9802-0001', { issued_date: '2026-05-01' }); // never tried
    await insert('BLD9802-0002', { issued_date: '2026-07-01' }); // never tried, newer
    await insert('BLD9802-0003', { type_of_work: 'New Townhouse/Duplex', issued_date: '2026-06-01' });
    await insert('BLD9802-0004', { type_of_work: ' NEW TOWNHOUSE ', issued_date: '2026-04-01' });
    await insert('BLD9802-0005', { type_of_work: 'Alteration Single Family' });
    await insert('BLD9802-0006', { type_of_work: 'New Villa' });
    await insert('BLD9802-0007', { type_of_work: 'New Single Family', status: 'Canceled' });
    await insert('BLD9802-0008', { type_of_work: null });
    // Already read, no CO yet: done.
    await insert('BLD9802-0010', { detail_status: 'ok', detail_fetched_at: ago(60), conditioned_sqft: 2000 });
    // Read before the CO existed: CO appeared since -> first in line.
    await insert('BLD9802-0011', { detail_status: 'ok', detail_fetched_at: ago(60), conditioned_sqft: 2000, co_date: '2026-09-01', issued_date: '2025-01-01' });
    // Read after seeing this CO date: done.
    await insert('BLD9802-0012', { detail_status: 'ok', detail_fetched_at: ago(5), conditioned_sqft: 2000, co_date: '2026-09-01', detail_co_date: '2026-09-01' });
    // CO date moved since the last read: re-read.
    await insert('BLD9802-0013', { detail_status: 'ok', detail_fetched_at: ago(5), conditioned_sqft: 2000, co_date: '2026-09-09', detail_co_date: '2026-09-01', issued_date: '2025-02-01' });
    // Retry windows: error 1 d, not_found 14 d, no_fields 30 d.
    await insert('BLD9802-0020', { detail_status: 'error', detail_fetched_at: ago(0.1) });
    await insert('BLD9802-0021', { detail_status: 'error', detail_fetched_at: ago(2), issued_date: '2026-02-01' });
    await insert('BLD9802-0022', { detail_status: 'not_found', detail_fetched_at: ago(3) });
    await insert('BLD9802-0023', { detail_status: 'not_found', detail_fetched_at: ago(20), issued_date: '2026-02-02' });
    await insert('BLD9802-0024', { detail_status: 'no_fields', detail_fetched_at: ago(10) });
    await insert('BLD9802-0025', { detail_status: 'no_fields', detail_fetched_at: ago(40), issued_date: '2026-02-03' });
    // A no_fields row whose CO appeared since: read again regardless of the window.
    await insert('BLD9802-0026', { detail_status: 'no_fields', detail_fetched_at: ago(2), co_date: '2026-09-05', issued_date: '2025-03-01' });

    const rows = await selectCandidates(50, now);
    expect(rows.map((r) => r.permit_no)).toEqual([
      // ok rows whose CO changed, newest issued first
      'BLD9802-0013', 'BLD9802-0011',
      // never tried, newest issued first
      'BLD9802-0002', 'BLD9802-0003', 'BLD9802-0001', 'BLD9802-0004',
      // failed reads past their window or with a new CO, newest issued first
      'BLD9802-0025', 'BLD9802-0023', 'BLD9802-0021', 'BLD9802-0026',
    ]);
  });

  test('candidate order and cap', async () => {
    await insert('BLD9803-0001', { issued_date: '2026-05-01' });
    await insert('BLD9803-0002', { issued_date: '2026-07-01' });
    await insert('BLD9803-0003', { detail_status: 'ok', detail_fetched_at: ago(60), conditioned_sqft: 2000, co_date: '2026-09-01', issued_date: '2024-01-01' });
    await insert('BLD9803-0004', { detail_status: 'error', detail_fetched_at: ago(3), issued_date: '2026-08-01' });
    expect((await selectCandidates(50, now)).map((r) => r.permit_no)).toEqual([
      'BLD9803-0003', // CO re-read first
      'BLD9803-0002', 'BLD9803-0001', // never tried, newest first
      'BLD9803-0004', // retry last
    ]);
    expect((await selectCandidates(2, now)).map((r) => r.permit_no)).toEqual(['BLD9803-0003', 'BLD9803-0002']);
  });

  test('writing a result: facts and CO date stored; a CO appearing later makes the permit a candidate once', async () => {
    await insert('BLD9804-0001', { issued_date: '2026-05-01' });
    let [c] = await selectCandidates(10, now);
    expect(c.permit_no).toBe('BLD9804-0001');
    await recordResult(c, 'ok', { conditioned_sqft: 2240, under_roof_sqft: 3150, stories: 1, bedrooms: 3, bathrooms: 2.5 }, new Date(now));
    let row = await conn('construction_permit_records').where({ permit_no: 'BLD9804-0001' }).first();
    expect(row).toMatchObject({ detail_status: 'ok', conditioned_sqft: 2240, under_roof_sqft: 3150, bedrooms: 3, detail_co_date: null });
    expect(Number(row.bathrooms)).toBe(2.5);
    expect(Number(row.stories)).toBe(1);
    expect(await selectCandidates(10, now)).toEqual([]);

    // The weekly report sync merges a CO date onto the row (only its own columns).
    await conn('construction_permit_records').where({ permit_no: 'BLD9804-0001' }).update({ co_date: '2026-09-12' });
    [c] = await selectCandidates(10, now);
    expect(c.permit_no).toBe('BLD9804-0001');
    // A failed re-read keeps the stored facts.
    await recordResult(c, 'error', null, new Date(now));
    row = await conn('construction_permit_records').where({ permit_no: 'BLD9804-0001' }).first();
    expect(row).toMatchObject({ detail_status: 'ok', conditioned_sqft: 2240 });
    // A good re-read stamps the CO it saw; nothing is due afterwards.
    await recordResult(c, 'ok', { conditioned_sqft: 2300, under_roof_sqft: null, stories: 1, bedrooms: 4, bathrooms: 3 }, new Date(now));
    row = await conn('construction_permit_records').where({ permit_no: 'BLD9804-0001' }).first();
    expect(row.conditioned_sqft).toBe(2300);
    expect(String(row.detail_co_date.toISOString?.().slice(0, 10) ?? row.detail_co_date)).toBe('2026-09-12');
    expect(await selectCandidates(10, now)).toEqual([]);
  });

  test('read helper: newest ok row, parcel tier before loose key, guard, no canceled or unread rows', async () => {
    const facts = (n) => ({ detail_status: 'ok', detail_fetched_at: ago(3), conditioned_sqft: n, bedrooms: 3, bathrooms: 2, stories: 1 });
    await insert('BLD9805-0001', { parcel_pin: '1111111111', address_loose_key: '100sample34212', issued_date: '2024-02-01', ...facts(1800) });
    await insert('BLD9805-0002', { parcel_pin: '1111111111', address_loose_key: '100sample34212', issued_date: '2026-02-01', ...facts(2200) });
    await insert('BLD9805-0003', { parcel_pin: '1111111111', address_loose_key: '100sample34212', issued_date: '2026-06-01', status: 'Canceled', ...facts(9000) });
    await insert('BLD9805-0004', { parcel_pin: '1111111111', address_loose_key: '100sample34212', issued_date: '2026-07-01', detail_status: 'no_fields', detail_fetched_at: ago(1) });
    // Neighbor on another parcel sharing the loose key, newer.
    await insert('BLD9805-0005', { parcel_pin: '2222222222', address_loose_key: '100sample34212', issued_date: '2026-08-01', ...facts(3500) });
    // Pin-less row on the loose key.
    await insert('BLD9805-0006', { parcel_pin: null, address_loose_key: '300other34212', issued_date: '2026-03-01', ...facts(2600) });

    // Parcel tier wins and takes the newest ok, non-canceled row.
    expect(await findPermitBuildingFacts({ parcelPin: '1111111111', looseKey: '100sample34212' }))
      .toMatchObject({ source: 'manatee_permit_detail', permitNo: 'BLD9805-0002', conditionedSqft: 2200 });
    // Unknown parcel + loose key: the neighbor asserts a different clean parcel; with the known parcel it is skipped.
    expect(await findPermitBuildingFacts({ parcelPin: '3333333333', looseKey: '100sample34212' })).toBeNull();
    // Loose key alone has no parcel to contradict: newest ok row.
    expect(await findPermitBuildingFacts({ looseKey: '100sample34212' })).toMatchObject({ permitNo: 'BLD9805-0005' });
    // A pin-less row may rescue a pin miss.
    expect(await findPermitBuildingFacts({ parcelPin: '3333333333', looseKey: '300other34212' }))
      .toMatchObject({ permitNo: 'BLD9805-0006', conditionedSqft: 2600 });
    // Nothing matches.
    expect(await findPermitBuildingFacts({ parcelPin: '4444444444' })).toBeNull();
    // Fetch date is a plain date.
    expect((await findPermitBuildingFacts({ parcelPin: '1111111111' })).fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
