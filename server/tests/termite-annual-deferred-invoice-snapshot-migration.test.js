/**
 * Real PostgreSQL, real DDL: 20260925000002_termite_annual_deferred_invoice_snapshot
 * runs its up()/down() against a scratch schema, following the same
 * convention as termite-annual-sign-before-pay-migration.test.js. This is a
 * SEPARATE migration file from 20260925000001, which is frozen (pushed;
 * the preview DB has already run it) and must never be edited again.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user:PASSWORD@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-deferred-invoice-snapshot-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260925000002_termite_annual_deferred_invoice_snapshot');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_defsnap_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260925000002_termite_annual_deferred_invoice_snapshot — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds a nullable jsonb column that round-trips a real snapshot', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('estimates').columnInfo();
    expect(cols).toHaveProperty('annual_plan_deferred_invoice');
    expect(cols.annual_plan_deferred_invoice.nullable).toBe(true);
    expect(cols.annual_plan_deferred_invoice.type).toBe('jsonb');

    const id = randomUUID();
    const snapshot = {
      amountCents: 25000,
      setupFeeCents: 0,
      lines: [{ description: 'Subterranean Termite Protection — Annual Fee', quantity: 1, unit_price: 250 }],
      title: 'WaveGuard Bronze — Annual Prepay (12 months)',
      notes: 'test',
      taxRate: null,
      monthlyRate: 20.83,
      resolvedBy: 'estimate-converter:prepay_annual',
      at: '2026-09-25T00:00:00.000Z',
    };
    await db('estimates').insert({ id, annual_plan_deferred_invoice: JSON.stringify(snapshot) });
    const row = await db('estimates').where({ id }).first();
    expect(row.annual_plan_deferred_invoice).toEqual(snapshot);
  });

  test('up() is idempotent — running it twice does not throw and the column is unchanged', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('estimates').columnInfo();
    expect(cols).toHaveProperty('annual_plan_deferred_invoice');
  });

  test('down() removes the column; the base table and its id column survive', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('estimates').columnInfo();
    expect(cols).not.toHaveProperty('annual_plan_deferred_invoice');
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
