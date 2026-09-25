/**
 * Real PostgreSQL, real DDL: 20260925030001_termite_annual_countersignature_columns
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after each test) inside a local throwaway database, following the
 * same safety-checked convention as termite-annual-plan-stamps-migration.test.js
 * — localhost only, and only the invoice_repair_test / waves_test database
 * names.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/termite-annual-countersignature-columns-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260925030001_termite_annual_countersignature_columns');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_countersig_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's own alterTable/references calls touch —
  // just enough for the FK (countersigned_by -> technicians.id) to be real
  // DDL, not a mock.
  await db.raw(`
    CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE customer_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260925030001_termite_annual_countersignature_columns — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds all five columns, all nullable, plus the FK to technicians (ON DELETE SET NULL)', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('customer_contracts').columnInfo();
    for (const col of ['countersigned_at', 'countersigned_by', 'countersigner_name', 'countersigner_ip', 'countersigner_user_agent']) {
      expect(cols).toHaveProperty(col);
      expect(cols[col].nullable).toBe(true);
    }

    const fk = (await db.raw(`
      SELECT confdeltype
      FROM pg_constraint
      WHERE conname = 'customer_contracts_countersigned_by_foreign'
        AND conrelid = 'customer_contracts'::regclass
    `)).rows[0];
    expect(fk).toBeDefined();
    expect(fk.confdeltype).toBe('n'); // 'n' = SET NULL

    // ON DELETE SET NULL actually fires.
    const techId = randomUUID();
    const contractId = randomUUID();
    await db('technicians').insert({ id: techId });
    await db('customer_contracts').insert({ id: contractId, countersigned_by: techId });
    await db('technicians').where({ id: techId }).del();
    const survivingContract = await db('customer_contracts').where({ id: contractId }).first();
    expect(survivingContract.countersigned_by).toBeNull();
  });

  test('up() is idempotent — running it twice does not throw and columns are unchanged', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('customer_contracts').columnInfo();
    expect(cols).toHaveProperty('countersigned_at');
    expect(cols).toHaveProperty('countersigned_by');
  });

  test('down() removes all five columns; the base table and its id column survive', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('customer_contracts').columnInfo();
    for (const col of ['countersigned_at', 'countersigned_by', 'countersigner_name', 'countersigner_ip', 'countersigner_user_agent']) {
      expect(cols).not.toHaveProperty(col);
    }
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after the columns are already gone does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });

  test('up() and down() no-op cleanly when customer_contracts does not exist yet', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('customer_contracts');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
