/**
 * Real PostgreSQL, real DDL: 20260926050001_termite_annual_renewal_charge_bell_kinds
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database — same
 * convention as termite-annual-renewal-charge-migration-postgres.test.js
 * (050000, now pushed/frozen — this is a SEPARATE, new migration file).
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-charge-bell-kinds-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926050001_termite_annual_renewal_charge_bell_kinds');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_bell_kinds_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's alterTable calls touch — plus the
  // (unused-by-this-migration) 050000 columns, proving they're left alone.
  await db.raw(`
    CREATE TABLE annual_prepay_terms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      renewal_exception_belled_at timestamptz,
      renewal_exception_kind text
    );
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926050001_termite_annual_renewal_charge_bell_kinds — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds one nullable timestamptz column per exception-bell kind', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    for (const col of ['renewal_no_witness_belled_at', 'renewal_unanchored_belled_at', 'renewal_stale_overdue_belled_at']) {
      expect(cols).toHaveProperty(col);
      expect(cols[col].nullable).toBe(true);
      expect(cols[col].type).toBe('timestamp with time zone');
    }
    // 050000's shared columns are untouched — still present, unused.
    expect(cols).toHaveProperty('renewal_exception_belled_at');
    expect(cols).toHaveProperty('renewal_exception_kind');
  });

  // The exact shape each of the three scans' own whereNull/update exclusion
  // runs — a term belled for one kind must NOT be excluded from another.
  test('a term stamped for one kind stays excludable-and-belled for a DIFFERENT kind', async () => {
    const { db } = fixture;
    await migration.up(db);

    const rowId = randomUUID();
    await db('annual_prepay_terms').insert({ id: rowId });

    const claimedA = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_no_witness_belled_at')
      .update({ renewal_no_witness_belled_at: new Date() });
    expect(claimedA).toBe(1);

    // Excluded from a SECOND no_witness stamp attempt (already set)...
    const reclaimA = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_no_witness_belled_at')
      .update({ renewal_no_witness_belled_at: new Date() });
    expect(reclaimA).toBe(0);

    // ...but a DIFFERENT kind's column is still null, so that scan still
    // finds and can stamp this same row.
    const stillEligibleForB = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_stale_overdue_belled_at').first('id');
    expect(stillEligibleForB).toBeDefined();
    const claimedB = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_stale_overdue_belled_at')
      .update({ renewal_stale_overdue_belled_at: new Date() });
    expect(claimedB).toBe(1);
  });

  test('up() is idempotent — running it twice does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_no_witness_belled_at');
  });

  test('down() removes only these three columns, leaving 050000\'s columns alone', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_no_witness_belled_at');
    expect(cols).not.toHaveProperty('renewal_unanchored_belled_at');
    expect(cols).not.toHaveProperty('renewal_stale_overdue_belled_at');
    // 050000's own columns (created directly by the fixture here, standing
    // in for that already-applied migration) are untouched.
    expect(cols).toHaveProperty('renewal_exception_belled_at');
    expect(cols).toHaveProperty('renewal_exception_kind');
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after already-removed does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
