/**
 * Real PostgreSQL, real DDL: 20260925000004_termite_annual_activation_attempt
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database, following the
 * same convention as termite-annual-sign-before-pay-migration.test.js and
 * the sibling 20260925000003 delivery-attempt migration this one mirrors.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-activation-attempt-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260925000004_termite_annual_activation_attempt');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_actattempt_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's own alterTable calls touch.
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260925000004_termite_annual_activation_attempt — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds the column, nullable, and it round-trips a real value', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('estimates').columnInfo();
    expect(cols).toHaveProperty('annual_plan_activation_attempted_at');
    expect(cols.annual_plan_activation_attempted_at.nullable).toBe(true);

    const id = randomUUID();
    await db('estimates').insert({ id });
    const now = new Date();
    await db('estimates').where({ id }).update({ annual_plan_activation_attempted_at: now });
    const row = await db('estimates').where({ id }).first();
    expect(new Date(row.annual_plan_activation_attempted_at).getTime()).toBe(now.getTime());
  });

  test('up() is idempotent — running it twice does not throw and the column is unchanged', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('estimates').columnInfo();
    expect(cols).toHaveProperty('annual_plan_activation_attempted_at');
  });

  test('down() removes the column; the base table and its id column survive', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('estimates').columnInfo();
    expect(cols).not.toHaveProperty('annual_plan_activation_attempted_at');
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after the column is already gone does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });

  test('up() and down() no-op cleanly when the table does not exist yet', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('estimates');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
