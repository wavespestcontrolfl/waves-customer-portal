/**
 * The home price store against real PostgreSQL (services/mail/home-price-store.js): the migration's columns and CHECKs
 * and a clean down, the due order and cap, the 20-hour and 21-day rules, only eligible rows of the new-home list, each
 * status write, a half-written price refused by the table, a settled row left alone, and the permit facts for each
 * detail status. Made-up rows in a throwaway schema of this worktree's own QA database or CI's database.
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
const detailMigration = require('../models/migrations/20261002220000_construction_permit_detail');
const mailMigration = require('../models/migrations/20261122160000_mail_prospects');
const priceMigration = require('../models/migrations/20261122200000_mail_prospects_home_price');
const { dueForPrice, permitFacts, savePriceResult } = require('../services/mail/home-price-store');

jest.setTimeout(60000);

const NOW = new Date('2026-11-22T15:00:00Z'); // 10:00 Eastern on 2026-11-22
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

postgres('home price store on PostgreSQL', () => {
  const schema = `mail_price_${randomUUID().replaceAll('-', '')}`;
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
    await detailMigration.up(conn);
    await mailMigration.up(conn);
    await priceMigration.up(conn);
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
  });

  let seq = 0;
  // A live row of the new-home list, untried unless a test says otherwise.
  const row = (extra = {}) => {
    seq += 1;
    const pin = String(5000000000 + seq);
    return conn('mail_prospects').insert({
      list_key: 'new_home', source: 'manatee_clerk_deed', source_ref: `2026990${String(seq).padStart(5, '0')}`,
      recorded_date: '2026-11-17', status: 'eligible', parcel_pin: pin, permit_no: `PMT-${seq}`,
      address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212', ...extra,
    }).returning('id').then(([r]) => r.id);
  };
  const stored = (id) => conn('mail_prospects').where({ id }).first();
  const dueIds = async (options = {}) => (await dueForPrice({ now: NOW, ...options })).map((r) => r.id);
  const PRICED = {
    status: 'priced', homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000,
    priceAnnual: 480, priceSetupFee: 0, priceDigest: 'digest-1',
  };

  test('migration: the columns are nullable without a default, the checks exist, and down leaves the list table as it was', async () => {
    const cols = (await conn.raw(
      "SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'mail_prospects'", [schema],
    )).rows;
    const added = ['home_sqft', 'home_sqft_source', 'home_stories', 'lot_sqft', 'price_status', 'price_reason', 'price_annual',
      'price_setup_fee', 'price_digest', 'priced_at', 'price_checked_at'];
    for (const name of added) {
      const col = cols.find((c) => c.column_name === name);
      expect(col).toMatchObject({ is_nullable: 'YES', column_default: null });
    }
    const checks = async () => (await conn.raw(
      "SELECT conname FROM pg_constraint WHERE conrelid = to_regclass(?) AND contype = 'c'", [`${schema}.mail_prospects`],
    )).rows.map((r) => r.conname);
    expect(await checks()).toEqual(expect.arrayContaining([
      'mail_prospects_home_sqft_source_check', 'mail_prospects_price_status_check',
      'mail_prospects_price_only_when_priced', 'mail_prospects_home_facts_positive',
    ]));
    const id = await row();
    await priceMigration.up(conn); // second run: no-op, the row is kept
    expect((await stored(id)).price_status).toBeNull();
    await priceMigration.down(conn);
    const after = (await conn.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'mail_prospects'", [schema],
    )).rows.map((c) => c.column_name);
    for (const name of added) expect(after).not.toContain(name);
    expect(after).toContain('stories'); // the list's own column stays
    expect(await checks()).toEqual(expect.arrayContaining(['mail_prospects_status_check']));
    expect((await checks()).filter((n) => /price|home_/.test(n))).toEqual([]);
    await priceMigration.up(conn);
    expect((await stored(id)).price_status).toBeNull();
  });

  test('the table refuses a half-written price, a price on an unpriced row, a bad enum and a size of zero', async () => {
    const id = await row();
    const refused = (changes) => expect(conn('mail_prospects').where({ id }).update(changes)).rejects.toMatchObject({ code: '23514' });
    const full = { price_status: 'priced', price_annual: 480, price_setup_fee: 0, price_digest: 'd', priced_at: conn.fn.now() };
    for (const missing of ['price_annual', 'price_setup_fee', 'price_digest', 'priced_at']) {
      await refused({ ...full, [missing]: null });
    }
    await refused({ price_status: 'not_clean', price_reason: 'engine_review', price_annual: 480 });
    await refused({ price_status: null, price_digest: 'd' });
    await refused({ price_status: 'bogus' });
    await refused({ home_sqft_source: 'guess' });
    await refused({ home_sqft: 0 });
    await refused({ lot_sqft: -5 });
    await refused({ home_stories: 0 });
    await refused({ ...full, price_annual: 0 });
    await conn('mail_prospects').where({ id }).update({ ...full, home_sqft: 1800, home_sqft_source: 'permit_plan' });
    expect((await stored(id)).price_status).toBe('priced');
  });

  test('due order: never tried first (oldest deed first), then the retries (oldest deed first); the cap cuts the end', async () => {
    const retryOld = await row({ recorded_date: '2026-11-10', price_status: 'failed', price_reason: 'parcel_map', price_checked_at: hoursAgo(30) });
    const newB = await row({ recorded_date: '2026-11-18' });
    const retryNew = await row({ recorded_date: '2026-11-19', price_status: 'missing_fact', price_reason: 'no_stories', price_checked_at: hoursAgo(21) });
    const newA = await row({ recorded_date: '2026-11-16' });
    const noCheckTime = await row({ recorded_date: '2026-11-12', price_status: 'failed', price_reason: 'engine' });
    expect(await dueIds()).toEqual([newA, newB, retryOld, noCheckTime, retryNew]);
    expect(await dueIds({ limit: 2 })).toEqual([newA, newB]);
    expect(await dueIds({ limit: 3 })).toEqual([newA, newB, retryOld]);
    const first = (await dueForPrice({ now: NOW, limit: 1 }))[0];
    expect(Object.keys(first).sort()).toEqual(
      ['address_line1', 'city', 'id', 'parcel_pin', 'permit_no', 'price_status', 'recorded_date', 'state', 'zip'],
    );
    expect(first.recorded_date).toBe('2026-11-16');
  });

  test('the cap defaults to 40 rows and a bad limit or a handle in the options place is refused', async () => {
    for (let i = 0; i < 42; i += 1) await row();
    expect(await dueIds()).toHaveLength(40);
    await expect(dueForPrice({ now: NOW, limit: 0 })).rejects.toThrow(TypeError);
    await expect(dueForPrice({ now: NOW, limit: 1.5 })).rejects.toThrow(TypeError);
    await expect(dueForPrice({ now: 'not a date' })).rejects.toThrow(TypeError);
    await expect(dueForPrice(conn)).rejects.toThrow(TypeError);
  });

  test('the 20-hour rule: a row checked 19 h ago waits, one checked 21 h ago is due, for both retry statuses', async () => {
    const waits = await row({ price_status: 'failed', price_reason: 'permit_page', price_checked_at: hoursAgo(19) });
    const waits2 = await row({ price_status: 'missing_fact', price_reason: 'no_lot_size', price_checked_at: hoursAgo(19.9) });
    const due = await row({ price_status: 'failed', price_reason: 'permit_page', price_checked_at: hoursAgo(21) });
    expect(await dueIds()).toEqual([due]);
    expect(await dueIds()).not.toContain(waits);
    expect(await dueIds()).not.toContain(waits2);
  });

  test('the 21-day rule counts Eastern days: a deed recorded 21 days ago is retried, 22 days ago is not; a never-tried row stays due', async () => {
    const edge = await row({ recorded_date: '2026-11-01', price_status: 'failed', price_reason: 'engine', price_checked_at: hoursAgo(30) });
    const tooOld = await row({ recorded_date: '2026-10-31', price_status: 'failed', price_reason: 'engine', price_checked_at: hoursAgo(30) });
    const tooOld2 = await row({ recorded_date: '2026-10-20', price_status: 'missing_fact', price_reason: 'no_stories', price_checked_at: hoursAgo(30) });
    const untried = await row({ recorded_date: '2026-10-25' });
    const ids = await dueIds();
    expect(ids).toEqual([untried, edge]);
    expect(ids).not.toContain(tooOld);
    expect(ids).not.toContain(tooOld2);
    // Just after midnight UTC it is still the evening before in Eastern time: the 21 days count from that day.
    const lateNow = new Date('2026-11-23T03:00:00Z'); // 22:00 Eastern on 2026-11-22
    expect((await dueForPrice({ now: lateNow })).map((r) => r.id)).toEqual([untried, edge]);
  });

  test('only eligible rows of the new-home list are due, and settled rows never are', async () => {
    const ok = await row();
    await row({ list_key: 'other_list' });
    await row({ status: 'held_back' });
    await row({ status: 'not_eligible', reason: 'known_address', parcel_pin: null, permit_no: null });
    await row({ status: 'unmatched', reason: 'no_permit', parcel_pin: null, permit_no: null });
    await row({ price_status: 'not_clean', price_reason: 'engine_review', price_checked_at: hoursAgo(100) });
    await row({
      price_status: 'priced', price_annual: 480, price_setup_fee: 0, price_digest: 'd', priced_at: hoursAgo(100), price_checked_at: hoursAgo(100),
    });
    expect(await dueIds()).toEqual([ok]);
  });

  test('savePriceResult: a priced row keeps the facts, the price and the digest, and is then settled', async () => {
    const id = await row();
    expect(await savePriceResult(id, PRICED)).toEqual({ written: true, price_status: 'priced' });
    const r = await stored(id);
    expect(r).toMatchObject({
      price_status: 'priced', price_reason: null, home_sqft: 1800, home_sqft_source: 'parcel_map', lot_sqft: 8000, price_digest: 'digest-1',
    });
    expect([Number(r.home_stories), Number(r.price_annual), Number(r.price_setup_fee)]).toEqual([1, 480, 0]);
    expect(r.priced_at).toBeInstanceOf(Date);
    expect(r.price_checked_at).toBeInstanceOf(Date);
    expect(r.stories).toBeNull(); // the list's own column is not touched
    expect(await dueIds()).toEqual([]);
  });

  test('savePriceResult: not_clean, missing_fact and failed write their reason and no price', async () => {
    const [a, b, c] = [await row(), await row(), await row()];
    expect(await savePriceResult(a, { status: 'not_clean', reason: 'engine_review', homeSqft: 2000, homeSqftSource: 'permit_plan', stories: 2, lotSqft: 7000 }))
      .toEqual({ written: true, price_status: 'not_clean' });
    expect(await savePriceResult(b, { status: 'missing_fact', reason: 'no_lot_size', homeSqft: 1500, homeSqftSource: 'parcel_map', stories: 1.5 }))
      .toEqual({ written: true, price_status: 'missing_fact' });
    expect(await savePriceResult(c, { status: 'failed', reason: 'parcel_map' })).toEqual({ written: true, price_status: 'failed' });
    const [ra, rb, rc] = await Promise.all([stored(a), stored(b), stored(c)]);
    expect(ra).toMatchObject({ price_status: 'not_clean', price_reason: 'engine_review', home_sqft: 2000, home_sqft_source: 'permit_plan', lot_sqft: 7000 });
    expect(rb).toMatchObject({ price_status: 'missing_fact', price_reason: 'no_lot_size', home_sqft: 1500, lot_sqft: null });
    expect(Number(rb.home_stories)).toBe(1.5);
    expect(rc).toMatchObject({ price_status: 'failed', price_reason: 'parcel_map', home_sqft: null, home_stories: null });
    for (const r of [ra, rb, rc]) {
      expect([r.price_annual, r.price_setup_fee, r.price_digest, r.priced_at]).toEqual([null, null, null, null]);
      expect(r.price_checked_at).toBeInstanceOf(Date);
    }
  });

  test('a retry row can be written again, and a later priced result clears the earlier reason and stale facts', async () => {
    const id = await row();
    await savePriceResult(id, { status: 'missing_fact', reason: 'no_stories', homeSqft: 1500, homeSqftSource: 'parcel_map', lotSqft: 6000 });
    await savePriceResult(id, { status: 'failed', reason: 'permit_page' });
    expect(await stored(id)).toMatchObject({ price_status: 'failed', home_sqft: null, lot_sqft: null });
    expect((await savePriceResult(id, PRICED)).written).toBe(true);
    expect(await stored(id)).toMatchObject({ price_status: 'priced', price_reason: null, home_sqft: 1800 });
  });

  test('a priced or not_clean row is left as it is, and the answer says so', async () => {
    const priced = await row();
    const notClean = await row();
    await savePriceResult(priced, PRICED);
    await savePriceResult(notClean, { status: 'not_clean', reason: 'not_one_line', homeSqft: 1900, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 5000 });
    const before = await Promise.all([stored(priced), stored(notClean)]);
    expect(await savePriceResult(priced, { status: 'failed', reason: 'engine' })).toEqual({ written: false, why: 'settled', price_status: 'priced' });
    expect(await savePriceResult(priced, { ...PRICED, priceAnnual: 999 })).toEqual({ written: false, why: 'settled', price_status: 'priced' });
    expect(await savePriceResult(notClean, PRICED)).toEqual({ written: false, why: 'settled', price_status: 'not_clean' });
    expect(await Promise.all([stored(priced), stored(notClean)])).toEqual(before);
  });

  test('a row that is no longer eligible, is another list\'s or is missing is left as it is', async () => {
    const held = await row({ status: 'held_back' });
    const gone = await row({ status: 'not_eligible', reason: 'known_address', parcel_pin: null, permit_no: null });
    const other = await row({ list_key: 'other_list' });
    expect(await savePriceResult(held, PRICED)).toEqual({ written: false, why: 'not_eligible', price_status: null });
    expect(await savePriceResult(gone, PRICED)).toEqual({ written: false, why: 'not_eligible', price_status: null });
    expect(await savePriceResult(other, PRICED)).toEqual({ written: false, why: 'not_eligible', price_status: null });
    expect(await savePriceResult(randomUUID(), PRICED)).toEqual({ written: false, why: 'not_found', price_status: null });
    for (const id of [held, gone, other]) expect((await stored(id)).price_status).toBeNull();
  });

  test('a half-written price is refused by the table through the store, and the row is unchanged', async () => {
    const id = await row();
    await expect(savePriceResult(id, { ...PRICED, priceDigest: null })).rejects.toMatchObject({ code: '23514' });
    await expect(savePriceResult(id, { ...PRICED, homeSqft: 0 })).rejects.toMatchObject({ code: '23514' });
    expect((await stored(id)).price_status).toBeNull();
    await expect(savePriceResult(id, { status: 'maybe' })).rejects.toThrow(TypeError);
    await expect(savePriceResult(id, conn)).rejects.toThrow(TypeError);
  });

  test('two saves at the same time write once', async () => {
    const id = await row();
    const results = await Promise.all([
      savePriceResult(id, PRICED),
      savePriceResult(id, { status: 'not_clean', reason: 'engine_review' }),
    ]);
    expect(results.filter((r) => r.written)).toHaveLength(1);
    expect(results.filter((r) => !r.written)[0]).toMatchObject({ why: 'settled' });
  });

  test('a save inside a caller\'s transaction uses that transaction', async () => {
    const id = await row();
    await expect(conn.transaction(async (trx) => {
      await savePriceResult(id, PRICED, trx);
      expect((await trx('mail_prospects').where({ id }).first()).price_status).toBe('priced');
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect((await stored(id)).price_status).toBeNull();
  });

  describe('permitFacts', () => {
    const permit = (no, extra = {}) => conn('construction_permit_records').insert({
      permit_no: no, permit_type: 'Residential', type_of_work: 'New Single Family', status: 'Permit Issued', ...extra,
    });

    test('ok: the plan size, the stories, the fetch time, the CO date and the type of work', async () => {
      await permit('PMT-1', {
        detail_status: 'ok', conditioned_sqft: 2100, stories: 2, detail_fetched_at: hoursAgo(5), co_date: '2026-10-30',
      });
      const facts = await permitFacts('PMT-1');
      expect(facts).toMatchObject({
        permit_no: 'PMT-1', type_of_work: 'New Single Family', detail_status: 'ok', conditioned_sqft: 2100, stories: 2, co_date: '2026-10-30',
      });
      expect(facts.detail_fetched_at.getTime()).toBe(hoursAgo(5).getTime());
    });

    test.each(['no_fields', 'not_found', 'error'])('%s: the status and fetch time come back with no facts', async (detailStatus) => {
      await permit('PMT-2', { detail_status: detailStatus, detail_fetched_at: hoursAgo(30) });
      expect(await permitFacts('PMT-2')).toMatchObject({
        detail_status: detailStatus, conditioned_sqft: null, stories: null, co_date: null, type_of_work: 'New Single Family',
      });
    });

    test('never tried: detail_status and fetch time are null; a townhouse keeps its type of work', async () => {
      await permit('PMT-3', { type_of_work: 'New Townhouse' });
      expect(await permitFacts('PMT-3')).toMatchObject({ detail_status: null, detail_fetched_at: null, type_of_work: 'New Townhouse' });
    });

    test('a half stories value is a number; an unknown or blank permit number is null; a handle in its place is refused', async () => {
      await permit('PMT-4', { detail_status: 'ok', conditioned_sqft: 1500, stories: 1.5 });
      expect((await permitFacts('PMT-4')).stories).toBe(1.5);
      expect(await permitFacts('PMT-NONE')).toBeNull();
      expect(await permitFacts('')).toBeNull();
      expect(await permitFacts(null)).toBeNull();
      await expect(permitFacts(conn)).rejects.toThrow(TypeError);
    });

    test('the row can be handed to the permit reader as its candidate (it needs permit_no, co_date, detail_status)', async () => {
      await permit('PMT-5', { co_date: '2026-11-01' });
      expect(Object.keys(await permitFacts('PMT-5'))).toEqual(expect.arrayContaining(['permit_no', 'co_date', 'detail_status']));
    });
  });
});
