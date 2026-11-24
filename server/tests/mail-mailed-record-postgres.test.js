/**
 * The mailed record against real PostgreSQL (migration 20261124160000, services/mail/mailed-record.js): the columns and
 * CHECKs, the frozen price (the table refuses a change to a mailed home's price or record; the price pass and the deed
 * save leave it alone), marking a batch (one transaction, idempotent, only eligible priced homes), the label rows, the
 * home page showing the printed price, and a down that refuses once a home is mailed. Made-up rows in a throwaway schema
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
const detailMigration = require('../models/migrations/20261002220000_construction_permit_detail');
const mailMigration = require('../models/migrations/20261122160000_mail_prospects');
const priceMigration = require('../models/migrations/20261122200000_mail_prospects_home_price');
const attemptsMigration = require('../models/migrations/20261122200100_mail_prospects_price_attempts');
const tokenMigration = require('../models/migrations/20261123200000_mail_prospects_page_token');
const slugMigration = require('../models/migrations/20261124040000_mail_prospects_page_slug');
const mailedMigration = require('../models/migrations/20261124160000_mail_prospects_mailed_record');
const keepViewsMigration = require('../models/migrations/20261124160100_mail_prospects_keep_typed_views');
const { dueForPrice, savePriceResult } = require('../services/mail/home-price-store');
const { markBatch, wouldMark, labelsFor } = require('../services/mail/mailed-record');
const { getHomePage } = require('../services/mail/home-page');

jest.setTimeout(60000);

const NOW = new Date('2026-11-24T15:00:00Z');

postgres('mailed record on PostgreSQL', () => {
  const schema = `mail_mailed_${randomUUID().replaceAll('-', '')}`;
  let admin;
  let conn;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's, or CI's database (as the other mail DB suites).
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
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
    conn = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    db.connection = conn;
    await conn.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});
    await constructionMigration.up(conn);
    await detailMigration.up(conn);
    await mailMigration.up(conn);
    await priceMigration.up(conn);
    await attemptsMigration.up(conn);
    await tokenMigration.up(conn);
    await slugMigration.up(conn);
    await mailedMigration.up(conn);
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
  });

  let seq = 0;
  // A live priced row of the new-home list: 600 a year is 50 a month.
  const row = (extra = {}) => {
    seq += 1;
    return conn('mail_prospects').insert({
      list_key: 'new_home', source: 'manatee_clerk_deed', source_ref: `2026991${String(seq).padStart(5, '0')}`,
      recorded_date: '2026-11-17', status: 'eligible', parcel_pin: String(6000000000 + seq), permit_no: `PMT-${seq}`,
      recipient_names: JSON.stringify(['TESTER ALEX J', 'TESTER JAMIE']),
      address_line1: '101 EXAMPLE TRL', city: 'LAKEWOOD RANCH', zip: '34202', page_slug: `${100 + seq}-example`,
      price_status: 'priced', price_annual: 600, price_setup_fee: 0, price_digest: 'digest-1', priced_at: '2026-11-22T22:00:00Z',
      home_sqft: 1800, home_sqft_source: 'parcel_map', home_stories: 1, lot_sqft: 8000,
      ...extra,
    }).returning('id').then(([r]) => r.id);
  };
  const stored = (id) => conn('mail_prospects').where({ id }).first();
  const refusal = async (promise) => promise.then(() => null, (err) => err);

  test('migration: the columns, the default of 0, the checks and the trigger; a second up changes nothing', async () => {
    const id = await row();
    const cols = (await conn.raw(
      "SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'mail_prospects'", [schema],
    )).rows;
    const col = (name) => cols.find((c) => c.column_name === name);
    expect(col('mailed_at')).toMatchObject({ is_nullable: 'YES', column_default: null, data_type: 'timestamp with time zone' });
    expect(col('mail_batch')).toMatchObject({ is_nullable: 'YES', data_type: 'character varying' });
    expect(col('mailed_price')).toMatchObject({ is_nullable: 'YES', data_type: 'jsonb' });
    expect(col('page_typed_views')).toMatchObject({ is_nullable: 'NO', column_default: '0', data_type: 'integer' });
    expect((await conn.raw("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'mail_prospects' AND column_name = 'mail_batch'", [schema])).rows[0].n).toBe(40);
    await mailedMigration.up(conn);
    expect(await stored(id)).toMatchObject({ mailed_at: null, mail_batch: null, mailed_price: null, page_typed_views: 0 });
  });

  test('the table keeps its rules: the mailed columns are all set or all empty, a snapshot has its numbers, only a priced home is mailed', async () => {
    const snap = { plan: 'pest_quarterly', annual: 600, monthly: 50, setupFee: 0, pricedAt: null };
    const id = await row();
    for (const set of [
      { mailed_at: NOW }, // no batch, no snapshot
      { mailed_at: NOW, mail_batch: 'b1' }, // no snapshot
      { mail_batch: 'b1', mailed_price: JSON.stringify(snap) }, // no time
      { mailed_at: NOW, mail_batch: '  ', mailed_price: JSON.stringify(snap) }, // blank batch
      { mailed_at: NOW, mail_batch: 'b1', mailed_price: JSON.stringify({ ...snap, monthly: '50' }) }, // text, not a number
      { mailed_at: NOW, mail_batch: 'b1', mailed_price: JSON.stringify([snap]) }, // not an object
      { page_typed_views: -1 },
    ]) {
      const err = await refusal(conn('mail_prospects').where({ id }).update(set));
      expect(err && err.code).toBe('23514');
    }
    const unpriced = await row({ price_status: 'failed', price_annual: null, price_setup_fee: null, price_digest: null, priced_at: null });
    const err = await refusal(conn('mail_prospects').where({ id: unpriced }).update({ mailed_at: NOW, mail_batch: 'b1', mailed_price: JSON.stringify(snap) }));
    expect(err && err.code).toBe('23514');
    expect(await stored(id)).toMatchObject({ mailed_at: null });
  });

  test('markBatch: marks only eligible, priced, not-yet-mailed homes, with the printed price frozen; a second run marks nothing', async () => {
    const a = await row({ price_annual: 601.02 }); // 50.085 a month: rounded from whole cents to 50.09
    const b = await row();
    const held = await row({ status: 'held_back' });
    const unpriced = await row({ price_status: 'not_clean', price_reason: 'engine_review', price_annual: null, price_setup_fee: null, price_digest: null, priced_at: null });
    const other = await row({ list_key: 'other_list' });

    const dry = await wouldMark();
    expect(dry.homes.map((h) => h.id).sort()).toEqual([a, b].sort());
    expect((await stored(a)).mailed_at).toBeNull(); // read only

    const first = await markBatch({ batch: '2026-11-a', now: NOW });
    expect(first.marked.sort()).toEqual([a, b].sort());
    const marked = await stored(a);
    expect(marked.mailed_at.toISOString()).toBe(NOW.toISOString());
    expect(marked.mail_batch).toBe('2026-11-a');
    expect(marked.mailed_price).toEqual({ plan: 'pest_quarterly', annual: 601.02, monthly: 50.09, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' });
    for (const id of [held, unpriced, other]) expect((await stored(id)).mailed_at).toBeNull();

    const again = await markBatch({ batch: '2026-11-b', now: new Date(NOW.getTime() + 86400000) });
    expect(again.marked).toEqual([]);
    expect(await stored(a)).toMatchObject({ mail_batch: '2026-11-a' }); // never touched again
    expect((await stored(a)).mailed_at.toISOString()).toBe(NOW.toISOString());
  });

  test('a batch name is used once: a retry marks nothing, even for homes priced since, and a concurrent twin waits its turn', async () => {
    const a = await row();
    expect((await markBatch({ batch: 'run-1', now: NOW })).marked).toEqual([a]);
    const late = await row(); // priced after the print run was exported
    const retry = await markBatch({ batch: 'run-1', now: NOW });
    expect(retry).toMatchObject({ marked: [], batchExists: true });
    expect((await stored(late)).mailed_at).toBeNull();
    expect((await labelsFor({ batch: 'run-1' })).labels).toHaveLength(1);
    // Two runs of one new name at the same moment: one marks, the other sees its rows.
    const [x, y] = await Promise.all([markBatch({ batch: 'run-2', now: NOW }), markBatch({ batch: 'run-2', now: NOW })]);
    expect([x.marked.length, y.marked.length].sort()).toEqual([0, 1]);
  });

  test('markBatch with ids marks just those homes and reports the ones that could not be marked; bad input is refused before any write', async () => {
    const a = await row();
    const b = await row();
    const held = await row({ status: 'held_back' });
    const result = await markBatch({ batch: 'one', ids: [a, held, randomUUID()], now: NOW });
    expect(result.marked).toEqual([a]);
    expect(result.notMailable).toHaveLength(2);
    expect((await stored(b)).mailed_at).toBeNull();
    await expect(markBatch({ batch: '', now: NOW })).rejects.toThrow(TypeError);
    await expect(markBatch({ batch: 'x'.repeat(41), now: NOW })).rejects.toThrow(TypeError);
    await expect(markBatch({ batch: 'ok', ids: ['not-a-uuid'], now: NOW })).rejects.toThrow(TypeError);
    expect((await stored(b)).mailed_at).toBeNull();
  });

  test('a failure in the middle of a batch writes nothing (one transaction)', async () => {
    const ids = [await row(), await row()].sort(); // the batch marks them in id order (same deed day)
    // A test-only trigger refuses the LAST home, after the first was already updated in the same transaction.
    await conn.raw(`CREATE FUNCTION test_refuse_last() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql`);
    await conn.raw(`CREATE TRIGGER test_refuse_last_trg BEFORE UPDATE ON mail_prospects FOR EACH ROW WHEN (NEW.id = '${ids[1]}' AND NEW.mailed_at IS NOT NULL) EXECUTE FUNCTION test_refuse_last()`);
    try {
      await expect(markBatch({ batch: 'half', now: NOW })).rejects.toThrow('refused');
    } finally {
      await conn.raw('DROP TRIGGER test_refuse_last_trg ON mail_prospects');
      await conn.raw('DROP FUNCTION test_refuse_last()');
    }
    for (const id of ids) expect((await stored(id)).mailed_at).toBeNull();
  });

  test('a mailed home cannot change its price or its record, whoever writes; an update to the same value, other columns and the typed counter still work', async () => {
    const id = await row();
    await markBatch({ batch: 'frozen', now: NOW });
    for (const set of [
      { price_annual: 700 }, { price_setup_fee: 99 }, { price_status: 'failed', price_annual: null, price_setup_fee: null, price_digest: null, priced_at: null },
      { price_digest: 'digest-2' }, { priced_at: '2026-11-30T00:00:00Z' }, { price_reason: 'x' },
      { mailed_at: null, mail_batch: null, mailed_price: null }, { mail_batch: 'other' }, { mailed_at: new Date(NOW.getTime() + 1000) },
      { mailed_price: JSON.stringify({ plan: 'pest_quarterly', annual: 1, monthly: 1, setupFee: 0 }) },
    ]) {
      const err = await refusal(conn('mail_prospects').where({ id }).update(set));
      expect(err && err.code).toBe('23514');
    }
    // The deed save (an upsert that rewrites the list's own columns) is not a price change.
    await conn('mail_prospects').where({ id }).update({ price_annual: 600, subdivision: 'SAMPLETON ESTATES', last_checked_at: NOW });
    await conn('mail_prospects').where({ id }).update({ page_typed_views: conn.raw('page_typed_views + 1') });
    expect(await stored(id)).toMatchObject({ price_annual: '600.00', page_typed_views: 1, mail_batch: 'frozen' });
  });

  test('the price pass leaves a mailed home alone: not due, and savePriceResult writes nothing, even for a stale run', async () => {
    const mailed = await row();
    await markBatch({ batch: 'frozen', now: NOW });
    expect((await dueForPrice({ now: NOW })).map((r) => r.id)).not.toContain(mailed);
    const result = await savePriceResult({ id: mailed, price_version: 0 }, {
      status: 'priced', homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000, priceAnnual: 999, priceSetupFee: 0, priceDigest: 'd2',
    });
    expect(result).toMatchObject({ written: false, why: 'settled' });
    expect(await stored(mailed)).toMatchObject({ price_annual: '600.00', price_digest: 'digest-1', price_attempts: 0 });
  });

  test('the home page shows the printed price and the hold date of a mailed home', async () => {
    const id = await row();
    const { page_token: token } = await stored(id);
    expect((await getHomePage(token)).price).toMatchObject({ monthly: 50, annual: 600 });
    expect((await getHomePage(token)).heldUntil).toBeNull();
    await markBatch({ batch: 'frozen', now: NOW });
    const page = await getHomePage(token);
    expect(page.price).toEqual({ monthly: 50, annual: 600, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' });
    expect(page.heldUntil).toBeNull(); // no hold until booking honors the printed price
  });

  test('labelsFor: the would-be batch before marking, the batch after (frozen price, hold from mailed_at); office line by city', async () => {
    const lwr = await row({ price_annual: 601.02, recipient_names: JSON.stringify(['TESTER ALEX J', 'TESTER JAMIE']) });
    const venice = await row({ city: 'NORTH PORT', zip: '34286', page_slug: null, price_setup_fee: 99, recipient_names: JSON.stringify(['SAMPLE SAM']) });
    const before = await labelsFor({});
    expect(before.labels).toHaveLength(2);
    const bySlug = (list, slug) => list.find((l) => l.slug === slug);
    const first = (list) => list.find((l) => l.name === 'Alex & Jamie Tester');
    expect(first(before.labels)).toEqual({
      name: 'Alex & Jamie Tester', price: '50.09', perApplication: '150.26', slug: (await stored(lwr)).page_slug, token: (await stored(lwr)).page_token,
      textNumber: '(941) 318-7612', setupFee: null,
    });
    expect(bySlug(before.labels, null)).toMatchObject({ name: 'Sam Sample', price: '50', perApplication: '150', textNumber: '(941) 297-3337', token: (await stored(venice)).page_token, setupFee: '99' });
    expect((await stored(lwr)).mailed_at).toBeNull(); // read only

    await markBatch({ batch: 'b-1', now: NOW });
    await conn('mail_prospects').where({ id: venice }).update({ page_typed_views: 3 });
    const after = await labelsFor({ batch: 'b-1' });
    expect(after.labels.map((l) => l.price).sort()).toEqual(['50', '50.09']);
    expect(after.labels.every((l) => !('heldUntil' in l))).toBe(true); // no hold date until booking honors it
    expect((await labelsFor({ batch: 'no-such-batch' })).labels).toEqual([]);
  });

  test('down refuses once a home is mailed, and drops the columns, checks and trigger before that', async () => {
    const id = await row();
    await markBatch({ batch: 'kept', now: NOW });
    // knex runs a migration inside a transaction (the down takes a table lock).
    await expect(conn.transaction((trx) => mailedMigration.down(trx))).rejects.toThrow(/refusing to drop/);
    // The newer down refuses a mailed batch too, before anything is dropped, so the counter stays.
    await expect(conn.transaction((trx) => keepViewsMigration.down(trx))).rejects.toThrow(/marked as mailed/);
    expect(await stored(id)).toMatchObject({ mail_batch: 'kept', page_typed_views: 0 });
    // Take the mark off (the trigger blocks an update, so disable it for the test's own setup only), then roll back.
    await conn.raw('ALTER TABLE mail_prospects DISABLE TRIGGER mail_prospects_freeze_mailed_trg');
    await conn('mail_prospects').where({ id }).update({ mailed_at: null, mail_batch: null, mailed_price: null });
    await conn.raw('ALTER TABLE mail_prospects ENABLE TRIGGER mail_prospects_freeze_mailed_trg');
    // A typed-link visit on a home not yet mailed also blocks the drop.
    const visited = await row();
    await conn('mail_prospects').where({ id: visited }).update({ page_typed_views: 2 });
    await expect(conn.transaction((trx) => keepViewsMigration.down(trx))).rejects.toThrow(/typed-link visit counts/);
    // A hand-named down of the older migration alone refuses too.
    await expect(conn.transaction((trx) => mailedMigration.down(trx))).rejects.toThrow(/typed-link visit counts/);
    await conn('mail_prospects').where({ id: visited }).update({ page_typed_views: 0 });
    await conn.transaction((trx) => keepViewsMigration.down(trx));
    // The newer down only checks: the counter and its check stay until the older down drops them.
    expect(await stored(visited)).toMatchObject({ page_typed_views: 0 });
    await expect(conn('mail_prospects').where({ id: visited }).update({ page_typed_views: -1 })).rejects.toThrow(/page_typed_views_check/);
    await conn.transaction((trx) => mailedMigration.down(trx));
    const cols = (await conn.raw("SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'mail_prospects'", [schema])).rows.map((c) => c.column_name);
    for (const name of ['mailed_at', 'mail_batch', 'mailed_price', 'page_typed_views']) expect(cols).not.toContain(name);
    const triggers = (await conn.raw("SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass(?) AND NOT tgisinternal", [`${schema}.mail_prospects`])).rows;
    expect(triggers).toEqual([]);
    await mailedMigration.up(conn);
    expect(await stored(id)).toMatchObject({ mailed_at: null, page_typed_views: 0 });
  });
});
