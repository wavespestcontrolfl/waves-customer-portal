/**
 * Real PostgreSQL, real DDL: 20260926170000_termite_annual_decline_retrieval_attempt
 * runs its up()/down() against a scratch schema (dropped after each test)
 * in a local throwaway database — same convention as the
 * 20260925000007 anchor-attempt migration test.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-decline-retrieval-attempt-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926170000_termite_annual_decline_retrieval_attempt');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_declretatt_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926170000_termite_annual_decline_retrieval_attempt — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds the nullable attempt column', async () => {
    const { db } = fixture;
    await migration.up(db);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols.decline_retrieval_attempted_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });
  });

  test('up() and down() are idempotent; down() removes the column', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    expect(await db('annual_prepay_terms').columnInfo()).not.toHaveProperty('decline_retrieval_attempted_at');
  });

  test('tolerates a database without the table', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('annual_prepay_terms');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
