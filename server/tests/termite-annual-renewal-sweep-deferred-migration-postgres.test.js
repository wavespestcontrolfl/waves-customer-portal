/**
 * Real PostgreSQL, real DDL: 20260927020000_termite_annual_renewal_sweep_deferred_marker
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database — same
 * convention as the 050000/050001/050002 migration tests.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-sweep-deferred-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260927020000_termite_annual_renewal_sweep_deferred_marker');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_sweep_deferred_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260927020000_termite_annual_renewal_sweep_deferred_marker — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds renewal_sweep_deferred_at as a nullable timestamptz', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_sweep_deferred_at');
    expect(cols.renewal_sweep_deferred_at.nullable).toBe(true);
    expect(cols.renewal_sweep_deferred_at.type).toBe('timestamp with time zone');

    // The rotation order every deferring recovery scan uses: never-deferred
    // rows first, then least-recently-deferred.
    const [never, older, newer] = [randomUUID(), randomUUID(), randomUUID()];
    await db('annual_prepay_terms').insert([
      { id: newer, renewal_sweep_deferred_at: new Date('2026-10-02T00:00:00Z') },
      { id: never },
      { id: older, renewal_sweep_deferred_at: new Date('2026-10-01T00:00:00Z') },
    ]);
    const order = await db('annual_prepay_terms').orderByRaw('renewal_sweep_deferred_at asc nulls first').pluck('id');
    expect(order).toEqual([never, older, newer]);
  });

  test('up() adds the charge follow-through columns (kind, reason, handled_at), all nullable', async () => {
    const { db } = fixture;
    await migration.up(db);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols.renewal_charge_failure_kind).toMatchObject({ type: 'text', nullable: true });
    expect(cols.renewal_charge_failure_reason).toMatchObject({ type: 'text', nullable: true });
    expect(cols.renewal_charge_failure_handled_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });
    await migration.down(db);
    const after = await db('annual_prepay_terms').columnInfo();
    expect(after).not.toHaveProperty('renewal_charge_failure_kind');
    expect(after).not.toHaveProperty('renewal_charge_failure_handled_at');
    expect(after).not.toHaveProperty('renewal_sweep_deferred_at');
  });

  test('up() is idempotent — running it twice does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_sweep_deferred_at');
  });

  test('down() removes the column', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_sweep_deferred_at');
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after already-removed does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
