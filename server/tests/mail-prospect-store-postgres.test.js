/**
 * mail_prospects store against real PostgreSQL: the migration, insert-then-update by the same key, the one-live-row-
 * per-parcel index with its duplicate_parcel fallback, the new-home permit read (both pin forms, the address proof,
 * the open-permit rule, the Eastern 24-month limit; canceled, alteration, ADU and long-finished homes left out) and
 * the known-address read. One test runs the new-home list through this store end to end (a made-up Clerk page and
 * a made-up parcel map; the real permit read, known-address read and table). Made-up rows in a throwaway schema
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
const priceMigration = require('../models/migrations/20261122200000_mail_prospects_home_price');
const attemptsMigration = require('../models/migrations/20261122200100_mail_prospects_price_attempts');
const tokenMigration = require('../models/migrations/20261123200000_mail_prospects_page_token');
const slugMigration = require('../models/migrations/20261124040000_mail_prospects_page_slug');
const {
  findBySourceRefs, newHomePermitsForParcels, addressKnownToWaves, saveProspect, assignPageSlug, backfillPageSlugs,
} = require('../services/mail/prospect-store');
const { monthsAgoIso } = require('../services/property-lookup/manatee-permit-sync');
const { runNewHomeList, daysToRead, holdBack, LIST_KEY } = require('../services/mail/new-home-list');

jest.setTimeout(60000);

// The table as production has it: the first migration and every one that adds a column (saveProspect writes the page slug).
async function migrateMailProspects(conn) {
  for (const migration of [mailMigration, priceMigration, attemptsMigration, tokenMigration, slugMigration]) await migration.up(conn);
}

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
    await migrateMailProspects(conn);
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
  // A live row: each parcel has its own permit, unless a test says otherwise.
  const live = (ref, pin, extra = {}) => prospect(ref, {
    status: 'eligible', reason: null, match_basis: 'permit', parcel_pin: pin, permit_no: `BLD-${pin}`,
    address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', ...extra,
  });
  // Dates count back from today, so the 24-month bound holds on any run date.
  const dateAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // A permit and a parcel at the same made-up address, unless a test says otherwise.
  const permit = (no, extra = {}) => conn('construction_permit_records').insert({
    permit_no: no, permit_type: 'Residential', type_of_work: 'New Single Family', status: 'Permit Issued',
    issued_date: dateAgo(200), parcel_pin: '5133090590', address_loose_key: '101example34212',
    address_raw: '101 EXAMPLE TRL  SAMPLETON 34212', ...extra,
  });
  const parcel = (parid, extra = {}) => ({ parid, addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', ...extra });
  const found = async (...parids) => Object.keys(await newHomePermitsForParcels(parids.map((id) => parcel(id)))).sort();

  test('migration: columns, the unique key, the two partial indexes, the checks, and a clean down', async () => {
    const idx = (await conn.raw('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?', [schema, 'mail_prospects'])).rows;
    const names = idx.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining([
      'mail_prospects_list_source_ref_key', 'mail_prospects_list_status_idx', 'mail_prospects_recorded_date_idx',
      'mail_prospects_one_live_per_parcel', 'mail_prospects_one_live_per_permit',
    ]));
    expect(idx.find((r) => r.indexname === 'mail_prospects_one_live_per_parcel').indexdef).toMatch(/UNIQUE.*WHERE/);
    expect(idx.find((r) => r.indexname === 'mail_prospects_one_live_per_permit').indexdef).toMatch(/UNIQUE.*WHERE/);
    const checks = (await conn.raw(
      "SELECT conname FROM pg_constraint WHERE conrelid = to_regclass(?) AND contype = 'c'", [`${schema}.mail_prospects`],
    )).rows.map((r) => r.conname);
    expect(checks).toEqual(expect.arrayContaining(['mail_prospects_status_check', 'mail_prospects_live_has_parcel_and_permit']));
    await mailMigration.up(conn); // second run: no-op
    await mailMigration.down(conn);
    expect(await conn.schema.hasTable('mail_prospects')).toBe(false);
    await migrateMailProspects(conn);
    expect(await conn.schema.hasTable('mail_prospects')).toBe(true);
  });

  test('insert, then an update by the same key keeps one row and keeps first_seen_at', async () => {
    expect((await saveProspect(prospect('202699000001'))).status).toBe('unmatched');
    const [first] = await conn('mail_prospects').select('*');
    expect(first.state).toBe('FL');
    await conn('mail_prospects').update({ first_seen_at: '2026-11-01T12:00:00Z', last_checked_at: '2026-11-01T12:00:00Z' });
    expect((await saveProspect(live('202699000001', '5133090590'))).status).toBe('eligible');
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
    expect((await saveProspect(prospect('202699000001', { status: 'not_eligible', reason: 'known_address' }))).status).toBe('not_eligible');
    const [row] = await conn('mail_prospects').select('*');
    expect(row).toMatchObject({ status: 'not_eligible', reason: 'known_address', parcel_pin: null, permit_no: null, address_line1: null });
  });

  test('unmatched is "no answer yet": it never replaces a row that has an answer', async () => {
    await saveProspect(live('202699000001', '5133090590'));
    await saveProspect(prospect('202699000002', { status: 'not_eligible', reason: 'company_buyer' }));
    await saveProspect(prospect('202699000003', { reason: 'no_permit' }));
    await conn('mail_prospects').update({ last_checked_at: '2026-11-01T12:00:00Z' });
    // A second run that could not reach the map saves "unmatched" for all three.
    expect(await saveProspect(prospect('202699000001', { reason: 'lookup_failed' }))).toEqual({ status: 'eligible', reason: null, written: false });
    expect(await saveProspect(prospect('202699000002', { reason: 'lookup_failed' }))).toEqual({ status: 'not_eligible', reason: 'company_buyer', written: false });
    expect(await saveProspect(prospect('202699000003', { reason: 'lookup_failed' }))).toEqual({ status: 'unmatched', reason: 'lookup_failed', written: true });
    const rows = await conn('mail_prospects').orderBy('source_ref');
    expect(rows.map((r) => [r.status, r.reason, r.parcel_pin])).toEqual([
      ['eligible', null, '5133090590'], ['not_eligible', 'company_buyer', null], ['unmatched', 'lookup_failed', null],
    ]);
    // The two kept rows were not written at all; the unmatched one was checked again.
    expect(rows.map((r) => r.last_checked_at.toISOString() === '2026-11-01T12:00:00.000Z')).toEqual([true, true, false]);
    // Inside a caller's transaction too.
    await conn.transaction(async (trx) => {
      expect((await saveProspect(prospect('202699000001'), trx)).status).toBe('eligible');
    });
  });

  test('a save never replaces a stored answer with a less careful one, in both write orders', async () => {
    const known = (ref) => prospect(ref, { status: 'not_eligible', reason: 'known_address' });
    // Two runs judged deed 1 at the same time: one found a known address, the other a live home.
    expect(await saveProspect(known('202699000001'))).toEqual({ status: 'not_eligible', reason: 'known_address', written: true });
    expect(await saveProspect(live('202699000001', '5133090590'))).toEqual({ status: 'not_eligible', reason: 'known_address', written: false });
    // The other order, deed 2: the live home is saved first, then the known address.
    expect((await saveProspect(live('202699000002', '6000000060'))).status).toBe('eligible');
    expect(await saveProspect(known('202699000002'))).toEqual({ status: 'not_eligible', reason: 'known_address', written: true });
    // A live home keeps its first match (deed 3), and not_eligible keeps its first reason (deed 4).
    expect((await saveProspect(live('202699000003', '7000000070', { status: 'held_back' }))).status).toBe('held_back');
    await conn('mail_prospects').update({ last_checked_at: '2026-11-01T12:00:00Z' });
    expect((await saveProspect(live('202699000003', '8000000080'))).status).toBe('held_back');
    expect((await saveProspect(prospect('202699000004', { status: 'not_eligible', reason: 'company_buyer' }))).status).toBe('not_eligible');
    expect(await saveProspect(prospect('202699000004', { status: 'not_eligible', reason: 'trust_buyer' }))).toEqual({ status: 'not_eligible', reason: 'company_buyer', written: false });
    const rows = await conn('mail_prospects').orderBy('source_ref');
    expect(rows.map((r) => [r.status, r.reason, r.parcel_pin, r.permit_no])).toEqual([
      ['not_eligible', 'known_address', null, null],
      ['not_eligible', 'known_address', null, null],
      ['held_back', null, '7000000070', 'BLD-7000000070'],
      ['not_eligible', 'company_buyer', null, null],
    ]);
    // The kept live home was not written at all.
    expect(rows[2].last_checked_at.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    // The parcel of deed 2 is free again for another deed.
    expect((await saveProspect(live('202699000005', '6000000060'))).status).toBe('eligible');
  });

  test('a second live row for the same parcel is saved as not_eligible / duplicate_parcel', async () => {
    expect((await saveProspect(live('202699000001', '5133090590'))).status).toBe('eligible');
    expect(await saveProspect(live('202699000002', '5133090590', { status: 'held_back' }))).toEqual({ status: 'not_eligible', reason: 'duplicate_parcel', written: true });
    const rows = await conn('mail_prospects').orderBy('source_ref');
    expect(rows.map((r) => [r.source_ref, r.status, r.reason])).toEqual([
      ['202699000001', 'eligible', null], ['202699000002', 'not_eligible', 'duplicate_parcel'],
    ]);
  });

  test('a permit that already backs a live home cannot back a second one: not_eligible / duplicate_permit', async () => {
    expect((await saveProspect(live('202699000001', '900000009', { permit_no: 'BLD9900-0020' }))).status).toBe('eligible');
    expect((await saveProspect(live('202699000002', '9000000090', { permit_no: 'BLD9900-0020' }))).status).toBe('not_eligible');
    const rows = await conn('mail_prospects').orderBy('source_ref');
    expect(rows.map((r) => [r.source_ref, r.status, r.reason])).toEqual([
      ['202699000001', 'eligible', null], ['202699000002', 'not_eligible', 'duplicate_permit'],
    ]);
    // The same deed read again keeps its own row and its own permit.
    expect((await saveProspect(live('202699000001', '900000009', { permit_no: 'BLD9900-0020' }))).status).toBe('eligible');
    // Another list is another list.
    expect((await saveProspect(live('202699000003', '9000000090', { permit_no: 'BLD9900-0020', list_key: 'other_list' }))).status).toBe('eligible');
  });

  test('a live row must name its parcel and its permit, and a status must be a known one', async () => {
    const refusedBy = async (row) => saveProspect(row).then(() => 'saved', (err) => `${err.code} ${err.constraint}`);
    const live2 = (extra) => live('202699000009', '5133090590', extra);
    expect(await refusedBy(live2({ parcel_pin: null }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ parcel_pin: undefined }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ parcel_pin: '  ' }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ permit_no: null }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ permit_no: '' }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ status: 'held_back', parcel_pin: null }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(live2({ status: 'Eligible' }))).toBe('23514 mail_prospects_status_check');
    expect(await refusedBy(prospect('202699000009', { status: 'mailed' }))).toBe('23514 mail_prospects_status_check');
    expect(await conn('mail_prospects').count('* as n').first()).toMatchObject({ n: '0' });
    // A row that is not live needs neither.
    expect(await refusedBy(prospect('202699000009'))).toBe('saved');
    expect(await refusedBy(prospect('202699000010', { status: 'not_eligible', reason: 'company_buyer' }))).toBe('saved');
    // The same refusals when the deed already has an answer: the row would be kept, not written, so the table
    // never sees it and the store refuses it by the same two rules.
    const answered = (extra) => live('202699000010', '6000000060', extra);
    expect(await refusedBy(answered({ parcel_pin: null }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(answered({ parcel_pin: '  ' }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(answered({ status: 'held_back', permit_no: '' }))).toBe('23514 mail_prospects_live_has_parcel_and_permit');
    expect(await refusedBy(answered({ status: 'Eligible' }))).toBe('23514 mail_prospects_status_check');
    expect(await refusedBy(prospect('202699000010', { status: 'mailed' }))).toBe('23514 mail_prospects_status_check');
    expect(await refusedBy(prospect('202699000010', { status: undefined }))).toBe('23514 mail_prospects_status_check');
    // A good row for that deed is kept as before.
    expect(await saveProspect(answered())).toEqual({ status: 'not_eligible', reason: 'company_buyer', written: false });
  });

  test('two saves of one deed never interleave: a second save cannot land between the refused write and the fallback', async () => {
    await saveProspect(live('202699000001', '5133090590')); // the parcel is live under another deed
    const until = async (check, what) => {
      for (let i = 0; i < 400; i += 1) {
        if (await check()) return;
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      throw new Error(`never happened: ${what}`);
    };
    // The lock saveProspect takes on this deed, as pg_locks shows it (a bigint key is classid high, objid low).
    const deedLocks = async (granted) => (await conn.raw(
      `SELECT count(*)::int AS n FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted = ?
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(?, 0)`,
      [granted, 'mail_prospects:new_home:manatee_clerk_deed:202699000002'],
    )).rows[0].n;
    // Hold the first save in the gap: its fallback row waits 2 seconds before it is written.
    await conn.raw(`
      CREATE FUNCTION mail_test_pause_fallback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reason = 'duplicate_parcel' THEN PERFORM pg_sleep(2); END IF;
        RETURN NEW;
      END $$`);
    await conn.raw('CREATE TRIGGER mail_test_pause_fallback BEFORE INSERT ON mail_prospects FOR EACH ROW EXECUTE FUNCTION mail_test_pause_fallback()');
    try {
      const first = saveProspect(live('202699000002', '5133090590')); // refused by the parcel index, then falls back
      await until(async () => (await deedLocks(true)) === 1, 'the first save holds the lock on the deed');
      // A second read of the same deed finds another match while the first save is still in its fallback.
      const second = saveProspect(live('202699000002', '6000000060'));
      await until(async () => (await deedLocks(false)) === 1, 'the second save waits for the lock on the deed');
      expect((await first).status).toBe('not_eligible');
      // The second save reads the first one's answer under the lock and keeps it: it says what the row holds.
      expect(await second).toEqual({ status: 'not_eligible', reason: 'duplicate_parcel', written: false });
    } finally {
      await conn.raw('DROP TRIGGER IF EXISTS mail_test_pause_fallback ON mail_prospects');
      await conn.raw('DROP FUNCTION IF EXISTS mail_test_pause_fallback()');
    }
    // Without the lock the second save would be written during the pause and answer "eligible"; the first save's
    // fallback would then overwrite it with not_eligible, so the answer would not be what the row holds.
    const row = await conn('mail_prospects').where({ source_ref: '202699000002' }).first();
    expect(row).toMatchObject({ status: 'not_eligible', reason: 'duplicate_parcel' });
    expect(row.parcel_pin).not.toBe('6000000060');
  });

  test('the duplicate fallback works inside a caller transaction', async () => {
    await saveProspect(live('202699000001', '5133090590'));
    await conn.transaction(async (trx) => {
      expect((await saveProspect(live('202699000002', '5133090590'), trx)).status).toBe('not_eligible');
      expect((await saveProspect(prospect('202699000003'), trx)).status).toBe('unmatched');
    });
    expect(await conn('mail_prospects').count('* as n').first()).toMatchObject({ n: '3' });
  });

  describe('page slug (the short typed address on the postcard)', () => {
    const slugOf = async (ref) => (await conn('mail_prospects').where({ source_ref: ref }).first('page_slug')).page_slug;
    const home = (ref, pin, address, zip = '34212', extra = {}) => live(ref, pin, { address_line1: address, zip, ...extra });

    test('migration: the column, the partial unique index and the shape CHECK; a clean down and a second up', async () => {
      const idx = (await conn.raw('SELECT indexdef FROM pg_indexes WHERE schemaname = ? AND indexname = ?', [schema, 'mail_prospects_page_slug_uniq'])).rows;
      expect(idx[0].indexdef).toMatch(/UNIQUE.*page_slug.*WHERE/);
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL'));
      for (const bad of ['101', 'example', '101-Example', '101--example', '-101-example', '101-example-', '101_example']) {
        await expect(conn('mail_prospects').where({ source_ref: '202699000001' }).update({ page_slug: bad })).rejects.toMatchObject({ code: '23514' });
      }
      await conn('mail_prospects').where({ source_ref: '202699000001' }).update({ page_slug: null }); // NULL is allowed
      await saveProspect(home('202699000002', '6000000060', '102 EXAMPLE TRL', '34212', { status: 'held_back' }));
      await conn('mail_prospects').update({ page_slug: null });
      await conn('mail_prospects').where({ source_ref: '202699000001' }).update({ page_slug: '101-example' });
      await expect(conn('mail_prospects').where({ source_ref: '202699000002' }).update({ page_slug: '101-example' })).rejects.toMatchObject({ code: '23505' });
      await slugMigration.up(conn); // second run: no-op
      await slugMigration.down(conn);
      expect(await conn.schema.hasColumn('mail_prospects', 'page_slug')).toBe(false);
      await slugMigration.down(conn); // down twice: no-op
      await slugMigration.up(conn);
      expect(await conn.schema.hasColumn('mail_prospects', 'page_slug')).toBe(true);
    });

    test('a live home gets its slug in the save: the street name without its type, for eligible and held_back alike', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL'));
      await saveProspect(home('202699000002', '6000000060', '4512 N RIVER OAKS DR', '34212', { status: 'held_back' }));
      expect(await slugOf('202699000001')).toBe('101-example');
      expect(await slugOf('202699000002')).toBe('4512-n-river-oaks');
    });

    test('the other statuses and the other lists get none', async () => {
      await saveProspect(prospect('202699000001', { address_line1: '101 EXAMPLE TRL' })); // unmatched
      await saveProspect(prospect('202699000002', { status: 'not_eligible', reason: 'company_buyer', address_line1: '102 EXAMPLE TRL' }));
      await saveProspect(home('202699000003', '5133090590', '103 EXAMPLE TRL', '34212', { list_key: 'other_list' }));
      for (const ref of ['202699000001', '202699000002', '202699000003']) expect(await slugOf(ref)).toBeNull();
    });

    test('a slug is given once and never changes: a second save, a changed address and a new price run keep it', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL'));
      expect(await slugOf('202699000001')).toBe('101-example');
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL'));
      await saveProspect(home('202699000001', '5133090590', '999 OTHER ST'));
      expect(await slugOf('202699000001')).toBe('101-example');
      const row = await conn('mail_prospects').where({ source_ref: '202699000001' }).first('id');
      expect(await assignPageSlug(row.id)).toBe('101-example');
      expect(await slugOf('202699000001')).toBe('101-example');
    });

    test('a clash: the second home takes the ZIP form, a third with the same ZIP too has none, and none ever moves', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL', '34212'));
      await saveProspect(home('202699000002', '6000000060', '101 EXAMPLE DR', '34211'));
      await saveProspect(home('202699000003', '7000000070', '101 EXAMPLE CT', '34211'));
      expect(await slugOf('202699000001')).toBe('101-example');
      expect(await slugOf('202699000002')).toBe('101-example-34211');
      expect(await slugOf('202699000003')).toBeNull(); // both forms are taken: the card prints the QR code only
      // The save still worked, and a later save of the same home tries again without touching the others.
      expect((await conn('mail_prospects').where({ source_ref: '202699000003' }).first('status')).status).toBe('eligible');
      await saveProspect(home('202699000003', '7000000070', '101 EXAMPLE CT', '34211'));
      expect(await slugOf('202699000003')).toBeNull();
      expect(await slugOf('202699000001')).toBe('101-example');
    });

    test('the unique-index refusal (23505) is retried with the ZIP form without failing the save, also inside a caller transaction', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL', '34212'));
      await conn.transaction(async (trx) => {
        // Another run took the plain slug between the read and the write: here the table already holds it.
        const saved = await saveProspect(home('202699000002', '6000000060', '101 EXAMPLE DR', '34212'), trx);
        expect(saved).toEqual({ status: 'eligible', reason: null, written: true });
        expect((await trx('mail_prospects').where({ source_ref: '202699000002' }).first('page_slug')).page_slug).toBe('101-example-34212');
        // The transaction is alive after the refusal: it can still write.
        expect((await saveProspect(prospect('202699000003'), trx)).status).toBe('unmatched');
      });
      expect(await slugOf('202699000002')).toBe('101-example-34212');
    });

    test('an address that gives no slug leaves NULL and does not fail the save', async () => {
      expect((await saveProspect(home('202699000001', '5133090590', '12A EXAMPLE TRL'))).status).toBe('eligible');
      expect(await slugOf('202699000001')).toBeNull();
    });

    test('a home that turns not_eligible keeps its slug, and the slug stays taken', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL'));
      await saveProspect(prospect('202699000001', { status: 'not_eligible', reason: 'known_address' }));
      expect(await slugOf('202699000001')).toBe('101-example');
      await saveProspect(home('202699000002', '6000000060', '101 EXAMPLE DR', '34212'));
      expect(await slugOf('202699000002')).toBe('101-example-34212');
    });

    test('assignPageSlug gives nothing for a row that is not live, or not there', async () => {
      await saveProspect(prospect('202699000001', { address_line1: '101 EXAMPLE TRL' }));
      const row = await conn('mail_prospects').where({ source_ref: '202699000001' }).first('id');
      expect(await assignPageSlug(row.id)).toBeNull();
      expect(await assignPageSlug('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    test('backfillPageSlugs gives the live homes with no slug theirs, oldest first, and counts what it did', async () => {
      await saveProspect(home('202699000001', '5133090590', '101 EXAMPLE TRL', '34212'));
      await saveProspect(home('202699000002', '6000000060', '101 EXAMPLE DR', '34212'));
      await saveProspect(home('202699000003', '7000000070', '55 TESTER WAY', '34212'));
      await saveProspect(home('202699000004', '8000000080', '12A EXAMPLE TRL', '34212'));
      await saveProspect(home('202699000005', '9000000090', '101 EXAMPLE CT', '34212'));
      await conn('mail_prospects').update({ page_slug: null }); // as before this feature
      const first = await backfillPageSlugs({ limit: 3 });
      expect(first).toMatchObject({ tried: 3, assigned: 3, withoutSlug: 0 });
      expect(first.next).toEqual(expect.objectContaining({ id: expect.anything() }));
      expect(await backfillPageSlugs()).toEqual({ tried: 2, assigned: 0, withoutSlug: 2, next: null });
      expect(await slugOf('202699000001')).toBe('101-example');
      expect(await slugOf('202699000002')).toBe('101-example-34212');
      expect(await slugOf('202699000003')).toBe('55-tester');
      expect(await slugOf('202699000004')).toBeNull();
      expect(await slugOf('202699000005')).toBeNull();
      expect(await backfillPageSlugs()).toEqual({ tried: 2, assigned: 0, withoutSlug: 2, next: null }); // nothing moves on a re-run
      await expect(backfillPageSlugs({ limit: 0 })).rejects.toThrow(TypeError);
      // The cursor walks past homes that can never get a slug: one row a batch still reaches the last one.
      const one = await backfillPageSlugs({ limit: 1 });
      expect(one).toMatchObject({ tried: 1, withoutSlug: 1 });
      expect(await backfillPageSlugs({ limit: 1, after: one.next })).toMatchObject({ tried: 1, withoutSlug: 1 });
    });

    test('the migration refuses to roll back once a slug is assigned (slugs are printed on postcards)', async () => {
      await saveProspect(home('202699000011', '5133090591', '77 EXAMPLE TRL', '34212'));
      const migration = require('../models/migrations/20261124040000_mail_prospects_page_slug');
      await expect(migration.down(conn)).rejects.toThrow(/refusing to drop/);
      expect(await slugOf('202699000011')).toBe('77-example');
    });
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

  test('new-home permits: with the sale day, a permit issued after it does not count', async () => {
    await permit('BLD9900-0040', { parcel_pin: '4000000041', issued_date: dateAgo(3) }); // the buyer of a lot got it
    const forSale = async (soldOn) => Object.keys(await newHomePermitsForParcels([parcel('4000000041')], { soldOn }));
    expect(await forSale(dateAgo(5))).toEqual([]); // sold five days ago: the permit came after
    expect(await forSale(dateAgo(3))).toEqual(['4000000041']); // issued on the sale day
    expect(await forSale(dateAgo(1))).toEqual(['4000000041']);
    // No sale day, or one that is not a date: today is the bound, as before.
    expect(await forSale(undefined)).toEqual(['4000000041']);
    expect(await forSale('not a date')).toEqual(['4000000041']);
    expect(Object.keys(await newHomePermitsForParcels([parcel('4000000041')]))).toEqual(['4000000041']);
    // The later permit does not take the place of the home's real one.
    await permit('BLD9900-0041', { parcel_pin: '4000000041', issued_date: dateAgo(300), co_date: dateAgo(20) });
    const atSale = await newHomePermitsForParcels([parcel('4000000041')], { soldOn: dateAgo(5) });
    expect(atSale['4000000041'].permit_no).toBe('BLD9900-0041');
    // A connection in the options' place (the call form before this change) is refused, not ignored.
    await expect(newHomePermitsForParcels([parcel('4000000041')], conn)).rejects.toThrow('the connection is the third argument');
    expect(Object.keys(await newHomePermitsForParcels([parcel('4000000041')], undefined, conn))).toEqual(['4000000041']);
    // No issue date: the certificate must be there by the sale day.
    await permit('BLD9900-0042', { parcel_pin: '4200000041', issued_date: null, co_date: dateAgo(2) });
    const noIssueDate = async (soldOn) => Object.keys(await newHomePermitsForParcels([parcel('4200000041')], { soldOn }));
    expect(await noIssueDate(dateAgo(5))).toEqual([]); // sold before the certificate
    expect(await noIssueDate(dateAgo(2))).toEqual(['4200000041']); // sold on the certificate's day
    expect(await noIssueDate(dateAgo(1))).toEqual(['4200000041']); // sold after it
    expect(await noIssueDate(undefined)).toEqual(['4200000041']); // no sale day: as before
  });

  test('new-home permits: a certificate or an issue date after today does not count', async () => {
    const tomorrow = new Date(Date.parse(`${monthsAgoIso(0)}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await permit('BLD9900-0030', { parcel_pin: '3000000031', co_date: tomorrow }); // "finished" tomorrow
    await permit('BLD9900-0031', { parcel_pin: '3100000031', issued_date: tomorrow }); // "issued" tomorrow, no certificate
    await permit('BLD9900-0032', { parcel_pin: '3200000031', co_date: monthsAgoIso(0) }); // finished today
    await permit('BLD9900-0033', { parcel_pin: '3300000031', issued_date: monthsAgoIso(0) }); // issued today
    expect(await found('3000000031', '3100000031', '3200000031', '3300000031')).toEqual(['3200000031', '3300000031']);
    // A recent certificate with an issue date of tomorrow does not count, and it does not take the place of the
    // parcel's real permit. A finished home's permit with no issue date still counts.
    await permit('BLD9900-0034', { parcel_pin: '3400000031', issued_date: tomorrow, co_date: dateAgo(10) });
    expect(await found('3400000031')).toEqual([]);
    await permit('BLD9900-0035', { parcel_pin: '3400000031', issued_date: dateAgo(300), co_date: dateAgo(20) });
    expect((await newHomePermitsForParcels([parcel('3400000031')]))['3400000031'].permit_no).toBe('BLD9900-0035');
    await permit('BLD9900-0036', { parcel_pin: '3600000031', issued_date: null, co_date: dateAgo(10) });
    expect(await found('3600000031')).toEqual(['3600000031']);
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
    await permit('BLD9900-0020', { parcel_pin: '9000000090', address_loose_key: '900sample34219', address_raw: '900 SAMPLE CT  SAMPLETON 34219' });
    const nine = parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219' });
    const ten = parcel('9000000090', { addressLine1: '12 OTHER WAY', zip: '34219' });
    const owners = async (...list) => Object.keys(await newHomePermitsForParcels(list));
    expect(await owners(nine)).toEqual(['900000009']);
    expect(await owners(ten)).toEqual([]);
    expect(await owners(nine, ten)).toEqual(['900000009']);
    expect(await owners(ten, nine)).toEqual(['900000009']);
    // The other way round: the permit's address is the 10-digit parcel's.
    await conn('construction_permit_records').update({ address_loose_key: '12other34219', address_raw: '12 OTHER WAY  SAMPLETON 34219' });
    expect(await owners(nine)).toEqual([]);
    expect(await owners(nine, ten)).toEqual(['9000000090']);
    // No address on one side proves nothing.
    expect(await owners(parcel('9000000090', { addressLine1: null }), parcel('900000009', { addressLine1: 'SAMPLE CT', zip: '34219' }), parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: null }))).toEqual([]);
    await conn('construction_permit_records').update({ address_loose_key: null });
    expect(await owners(nine, ten)).toEqual([]);
    await conn('construction_permit_records').update({ address_loose_key: '12other34219', address_raw: null });
    expect(await owners(nine, ten)).toEqual([]);
  });

  test('new-home permits: the same house number, first street word and zip is not enough: the whole street address decides', async () => {
    // "900 Sample Ct" and "900 Sample Dr" share the loose key 900sample34219, and the two parcels share the pin.
    await permit('BLD9900-0021', { parcel_pin: '9000000090', address_loose_key: '900sample34219', address_raw: '900 SAMPLE CT  SAMPLETON 34219' });
    const court = parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219' });
    const drive = parcel('9000000090', { addressLine1: '900 SAMPLE DR', zip: '34219' });
    const owners = async (...list) => Object.keys(await newHomePermitsForParcels(list));
    expect(await owners(court)).toEqual(['900000009']);
    expect(await owners(drive)).toEqual([]); // asked alone, it still gets nothing
    expect(await owners(drive, court)).toEqual(['900000009']);
    // The part after the break must be the parcel's city and zip: "CT  E SAMPLETON" is not "900 Sample Ct".
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  E SAMPLETON 34219' });
    expect(await owners(court)).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT E', zip: '34219' }))).toEqual([]);
    // Another city name for the same street and zip is not proof,
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  OTHERTON 34219' });
    expect(await owners(court)).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219', city: 'OTHERTON' }))).toEqual(['900000009']);
    // except the two names the county uses for one place in that zip (the report says Parrish, the map Palmetto).
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  PARRISH 34219' });
    const palmetto = (extra = {}) => parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219', city: 'PALMETTO', ...extra });
    expect(await owners(palmetto())).toEqual(['900000009']);
    expect(await owners(court)).toEqual([]); // SAMPLETON is not one of the two names
    expect(await owners(palmetto({ addressLine1: '900 SAMPLE DR' }))).toEqual([]);
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT PARRISH 34219' }); // single spaces
    expect(await owners(palmetto())).toEqual(['900000009']);
    // The pair holds in its own zip only.
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  PARRISH 34208', address_loose_key: '900sample34208' });
    expect(await owners(palmetto({ zip: '34208' }))).toEqual([]);
    await conn('construction_permit_records').update({ address_loose_key: '900sample34219' });
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  SAMPLETON 34219' });
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219', city: null }))).toEqual([]);
    // A shorter or a longer street address is not the permit's address either.
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE', zip: '34219' }))).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT E', zip: '34219' }))).toEqual([]);
    // Letter case and spacing are not part of an address.
    expect(await owners(parcel('900000009', { addressLine1: ' 900  Sample ct ', zip: '34219' }))).toEqual(['900000009']);
    // The report line with single spaces only: the whole line must be the parcel's street address, city and zip.
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT SAMPLETON 34219' });
    expect(await owners(court)).toEqual(['900000009']);
    expect(await owners(drive)).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE', zip: '34219' }))).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219', city: 'OTHERTON' }))).toEqual([]);
    expect(await owners(parcel('900000009', { addressLine1: '900 SAMPLE CT', zip: '34219', city: null }))).toEqual([]);
    // A line with two breaks is not a shape the report writes: no proof.
    await conn('construction_permit_records').update({ address_raw: '900 SAMPLE CT  SAMPLETON  34219' });
    expect(await owners(court)).toEqual([]);
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

  test('addressKnownToWaves finds a stored address whatever its spacing or zip form', async () => {
    const stored = [
      { address_line1: '  31 Leading Space Dr', zip: '34203' },
      { address_line1: '32\tTabbed Way', zip: '34203' },
      { address_line1: '33   Wide Gap Ct', zip: '34203-1234' },
      { address_line1: '34 Plain Rd', zip: 'FL 34203' },
    ];
    await conn('customers').insert(stored);
    expect(await addressKnownToWaves('31 LEADING SPACE DR', '34203')).toBe(true);
    expect(await addressKnownToWaves('32 TABBED WAY', '34203')).toBe(true);
    expect(await addressKnownToWaves('33 WIDE GAP CT', '34203')).toBe(true);
    expect(await addressKnownToWaves('34 PLAIN RD', '34203')).toBe(true);
    // The key joins the number and the street word, so "12 34th" and "123 4th" share one: the number decides.
    await conn('customers').insert({ address_line1: '123 4th St', zip: '34203' });
    expect(await addressKnownToWaves('12 34TH ST', '34203')).toBe(false);
    expect(await addressKnownToWaves('123 4TH ST', '34203')).toBe(true);
    // The same digits inside another house number or another street are not this home.
    expect(await addressKnownToWaves('3 LEADING SPACE DR', '34203')).toBe(false);
    expect(await addressKnownToWaves('31 OTHER DR', '34203')).toBe(false);
    expect(await addressKnownToWaves('31 LEADING SPACE DR', '34204')).toBe(false);
  });

  test('a long deed description, address, city and subdivision are saved whole', async () => {
    const long = (word, size) => `${word} `.repeat(Math.ceil(size / (word.length + 1))).trim();
    const row = live('202641990001', '4100000041', {
      legal_description: long('LOT 1 EXAMPLE', 900), address_line1: long('101 EXAMPLE TRL', 500),
      city: long('EXAMPLE', 200), subdivision: long('EXAMPLE LAKES', 400),
    });
    expect((await saveProspect(row)).status).toBe(row.status);
    const saved = await conn('mail_prospects').where({ source_ref: '202641990001' }).first();
    expect(saved).toMatchObject({
      legal_description: row.legal_description, address_line1: row.address_line1, city: row.city, subdivision: row.subdivision,
    });
    expect(saved.legal_description.length).toBeGreaterThan(300);
  });

  test('addressKnownToWaves reads every customer with that house number and zip, however many there are', async () => {
    const others = Array.from({ length: 450 }, (_, i) => ({ address_line1: `77 Street${i} Rd`, zip: '34221' }));
    await conn('customers').insert(others);
    await conn('customers').insert({ address_line1: '77 Lastone Ln', zip: '34221' });
    expect(await addressKnownToWaves('77 LASTONE LN', '34221')).toBe(true);
    expect(await addressKnownToWaves('77 MISSING LN', '34221')).toBe(false);
  });

  test('the new-home run saves through this store: a new home, a known address and a deed with no parcel', async () => {
    // One clock for the run and the table (the 20-hour wait compares them): now, and the newest day a night
    // run reads today.
    const now = Date.now();
    const [day] = daysToRead('night', now);
    const deedRow = (lot) => ({
      instrument: String(202699200000 + lot), from: ['SAMPLE HOMES LLC'], to: ['TESTER ALEX J'], type: 'DEED',
      consideration: 425000, description: `LOT ${lot} SAMPLE GROVE`, date: day,
    });
    const mapParcel = (extra = {}) => ({
      parid: '513309059', addressLine1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', subdivision: 'SAMPLE GROVE',
      lot: '12', block: null, ownerName: 'SAMPLE HOMES LLC', ownerName2: null, livingSqft: 2100, stories: 2, yearBuilt: 2026,
      platKnown: true, ...extra,
    });
    const parcelsByLot = {
      12: [mapParcel()],
      13: [mapParcel({ parid: '777000111', lot: '13', addressLine1: '202 KNOWN RD' })],
      14: [],
    };
    const deps = {
      fetchDayList: jest.fn(async (asked) => ({ rows: asked === day ? [deedRow(12), deedRow(13), deedRow(14)] : [] })),
      queryParcels: jest.fn(async (legal) => parcelsByLot[legal.lot]),
      sleep: async () => {},
    };
    await permit('BLD9900-0040', { parcel_pin: '5133090590', co_date: dateAgo(15) });
    await permit('BLD9900-0041', { parcel_pin: '7770001110', address_loose_key: '202known34212', address_raw: '202 KNOWN RD  SAMPLETON 34212' });
    await conn('customers').insert({ address_line1: '202 Known Rd', zip: '34212' });
    const live = holdBack(LIST_KEY, '513309059') ? 'held_back' : 'eligible';

    const first = await runNewHomeList({ mode: 'night', now, deps });
    expect(first.saved).toEqual({ [live]: 1, not_eligible: 1, unmatched: 1 });
    expect(first.savedByReason).toEqual({ 'not_eligible/known_address': 1, 'unmatched/no_parcel': 1 });
    expect(first.errors).toEqual({});
    const rows = (await conn.raw(
      `SELECT source_ref, status, reason, match_basis, parcel_pin, permit_no, to_char(co_date, 'YYYY-MM-DD') AS co_date,
              address_line1, city, state, zip, subdivision, living_sqft, stories::float AS stories, year_built,
              legal_description, recipient_names, to_char(recorded_date, 'YYYY-MM-DD') AS recorded_date
         FROM mail_prospects ORDER BY source_ref`,
    )).rows;
    expect(rows.map((r) => [r.source_ref, r.status, r.reason])).toEqual([
      ['202699200012', live, null], ['202699200013', 'not_eligible', 'known_address'], ['202699200014', 'unmatched', 'no_parcel'],
    ]);
    expect(rows[0]).toMatchObject({
      match_basis: 'owner_permit', parcel_pin: '513309059', permit_no: 'BLD9900-0040', co_date: dateAgo(15),
      address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212', subdivision: 'SAMPLE GROVE',
      living_sqft: 2100, stories: 2, year_built: 2026, legal_description: 'LOT 12 SAMPLE GROVE',
      recipient_names: ['TESTER ALEX J'], recorded_date: day,
    });
    expect(rows[1]).toMatchObject({ parcel_pin: null, permit_no: null, address_line1: null });

    // A second run asks the map about nothing: two deeds are settled, and the third waits 20 hours.
    deps.queryParcels.mockClear();
    const second = await runNewHomeList({ mode: 'night', now, deps });
    expect(second.skipped).toMatchObject({ settled: 2, retry_wait: 1 });
    expect(second.saved).toEqual({});
    expect(deps.queryParcels).not.toHaveBeenCalled();
    expect(await conn('mail_prospects').count('* as n').first()).toMatchObject({ n: '3' });
  });
});
