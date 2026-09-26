/**
 * The consultation offer's final check reads ONE snapshot (Codex #4918 r21):
 * FINAL_CHECK_SNAPSHOT must give a real Postgres snapshot — every read in
 * the transaction sees the same instant, so no guard can go stale while
 * another is still reading, and nothing inside it can write. The unit suites
 * pin that the page's check and the engine's final guards ask for it; this
 * pins that what they ask for is what Postgres does.
 */

// The config's module graph pulls models/db; this suite opens its own
// connection instead, so the shared app pool never opens here.
jest.mock('../models/db', () => jest.fn());

// Runs with the existing CI PostgreSQL pass; never a production connection.
// Same schema-per-run convention as app-onboarding-postgres.test.js.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knexLib = require('knex');
const { FINAL_CHECK_SNAPSHOT } = require('../services/estimate-consultation-offer');

(SKIP ? describe.skip : describe)('FINAL_CHECK_SNAPSHOT — PostgreSQL', () => {
  let db;
  const schema = `offer_snapshot_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('probe_rows', (t) => { t.integer('v'); });
    await db('probe_rows').insert({ v: 1 });
  });

  afterAll(async () => {
    await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await db.destroy();
  });

  test('is a read-only REPEATABLE READ transaction in Postgres', async () => {
    const mode = await db.transaction(async (trx) => (await trx.raw(
      "select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro",
    )).rows[0], FINAL_CHECK_SNAPSHOT);

    expect(mode).toEqual({ iso: 'repeatable read', ro: 'on' });
  });

  test('every read inside it sees one instant — a row committed elsewhere mid-check stays invisible', async () => {
    const seen = await db.transaction(async (trx) => {
      const before = (await trx('probe_rows').max('v as m').first()).m;
      await db('probe_rows').insert({ v: 2 }); // committed on another connection, mid-snapshot
      const after = (await trx('probe_rows').max('v as m').first()).m;
      return { before, after };
    }, FINAL_CHECK_SNAPSHOT);

    expect(seen).toEqual({ before: 1, after: 1 });
    expect((await db('probe_rows').max('v as m').first()).m).toBe(2);
  });

  test('refuses writes — the final check can never change state', async () => {
    await expect(db.transaction((trx) => trx('probe_rows').insert({ v: 3 }), FINAL_CHECK_SNAPSHOT))
      .rejects.toThrow(/read-only transaction/);
  });
});
