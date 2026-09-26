/**
 * Real PostgreSQL, real DDL: 20260926050002_termite_annual_renewal_charge_reconcile_marker
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database — same
 * convention as the 050000/050001 migration tests (both now pushed/frozen
 * — this is a SEPARATE, new migration file).
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-charge-reconcile-marker-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926050002_termite_annual_renewal_charge_reconcile_marker');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_reconcile_mrk_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926050002_termite_annual_renewal_charge_reconcile_marker — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds renewal_charge_never_reached_stripe_belled_at as a nullable timestamptz', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_charge_never_reached_stripe_belled_at');
    expect(cols.renewal_charge_never_reached_stripe_belled_at.nullable).toBe(true);
    expect(cols.renewal_charge_never_reached_stripe_belled_at.type).toBe('timestamp with time zone');

    // The exclusion query reconcileStuckSuccessors' leg 7b actually runs.
    const rowId = randomUUID();
    await db('annual_prepay_terms').insert({ id: rowId });
    const claimed = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_charge_never_reached_stripe_belled_at')
      .update({ renewal_charge_never_reached_stripe_belled_at: new Date() });
    expect(claimed).toBe(1);
    const stillExcluded = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_charge_never_reached_stripe_belled_at').first();
    expect(stillExcluded).toBeUndefined();
  });

  test('up() is idempotent — running it twice does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_charge_never_reached_stripe_belled_at');
  });

  test('down() removes the column', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_charge_never_reached_stripe_belled_at');
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after already-removed does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
