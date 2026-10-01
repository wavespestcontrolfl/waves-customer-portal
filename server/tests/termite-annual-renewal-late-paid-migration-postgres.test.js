/**
 * Real PostgreSQL, real DDL: 20260927040000_termite_annual_renewal_late_paid_bell_marker
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database — same
 * convention as the 050000/050001/050002/020000 migration tests.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-late-paid-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260927040000_termite_annual_renewal_late_paid_bell_marker');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_late_paid_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), renewal_charge_failure_kind text)');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260927040000_termite_annual_renewal_late_paid_bell_marker — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds renewal_late_paid_belled_at as a nullable timestamptz and leaves the existing columns alone', async () => {
    const { db } = fixture;
    await migration.up(db);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols.renewal_late_paid_belled_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });
    expect(cols.renewal_charge_failure_kind).toMatchObject({ type: 'text' });
  });

  test('up() and down() are idempotent; down() removes only the new column', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_late_paid_belled_at');
    expect(cols).toHaveProperty('renewal_charge_failure_kind');
  });

  test('a missing annual_prepay_terms table is a no-op both ways', async () => {
    const { db } = fixture;
    await db.schema.dropTable('annual_prepay_terms');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
