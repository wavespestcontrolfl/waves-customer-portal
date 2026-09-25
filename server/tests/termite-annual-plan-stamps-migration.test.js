/**
 * Real PostgreSQL, real DDL: 20260924030001_termite_annual_plan_stamps runs
 * its up()/down() against a scratch schema (its own random name, dropped
 * after the suite) inside a local throwaway database, following the same
 * safety-checked convention as helpers/invoice-repair-db.js — localhost only,
 * and only the invoice_repair_test / waves_test database names.
 *
 * This isolates the migration's actual ALTER TABLE / FK / UNIQUE DDL against
 * real Postgres without requiring the full ~1500-migration chain: the
 * fixture tables below are the minimal shape the migration's own alterTable
 * calls touch (annual_prepay_terms.id, customer_contracts.id), not a claim
 * that every production migration ran.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user:PASSWORD@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-plan-stamps-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260924030001_termite_annual_plan_stamps');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_stamps_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's own alterTable/references calls touch —
  // just enough for the FK (renewed_from_term_id -> annual_prepay_terms.id)
  // and the UNIQUE constraint to be real DDL, not a mock.
  await db.raw(`
    CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE customer_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260924030001_termite_annual_plan_stamps — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds all five columns with the right nullability, plus the FK and UNIQUE on renewed_from_term_id', async () => {
    const { db } = fixture;
    await migration.up(db);

    const termsCols = await db('annual_prepay_terms').columnInfo();
    expect(termsCols).toHaveProperty('annual_plan_version');
    expect(termsCols.annual_plan_version.nullable).toBe(true);
    expect(termsCols).toHaveProperty('notice_45_sent_at');
    expect(termsCols.notice_45_sent_at.nullable).toBe(true);
    expect(termsCols).toHaveProperty('renewal_charge_consent_at');
    expect(termsCols.renewal_charge_consent_at.nullable).toBe(true);
    expect(termsCols).toHaveProperty('renewed_from_term_id');
    expect(termsCols.renewed_from_term_id.nullable).toBe(true);

    const contractCols = await db('customer_contracts').columnInfo();
    expect(contractCols).toHaveProperty('annual_plan_version');
    expect(contractCols.annual_plan_version.nullable).toBe(true);

    // FK: ON DELETE SET NULL, self-referencing annual_prepay_terms.id
    const fk = (await db.raw(`
      SELECT confupdtype, confdeltype
      FROM pg_constraint
      WHERE conname = 'annual_prepay_terms_renewed_from_term_id_foreign'
    `)).rows[0];
    expect(fk).toBeDefined();
    expect(fk.confdeltype).toBe('n'); // 'n' = SET NULL

    // UNIQUE — one successor per parent
    const unique = (await db.raw(`
      SELECT conname FROM pg_constraint
      WHERE conname = 'annual_prepay_terms_renewed_from_term_unique' AND contype = 'u'
    `)).rows;
    expect(unique.length).toBe(1);

    // The unique constraint is actually enforced end to end.
    const parentId = randomUUID();
    const childId = randomUUID();
    const secondChildId = randomUUID();
    await db('annual_prepay_terms').insert([{ id: parentId }, { id: childId }, { id: secondChildId }]);
    await db('annual_prepay_terms').where({ id: childId }).update({ renewed_from_term_id: parentId });
    await expect(
      db('annual_prepay_terms').where({ id: secondChildId }).update({ renewed_from_term_id: parentId }),
    ).rejects.toThrow(/annual_prepay_terms_renewed_from_term_unique/);

    // ON DELETE SET NULL actually fires.
    await db('annual_prepay_terms').where({ id: parentId }).del();
    const survivingChild = await db('annual_prepay_terms').where({ id: childId }).first();
    expect(survivingChild.renewed_from_term_id).toBeNull();
  });

  test('up() is idempotent — running it twice does not throw and columns are unchanged', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('annual_plan_version');
    expect(cols).toHaveProperty('renewed_from_term_id');
  });

  test('down() removes all five columns; the base tables and their id columns survive', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const termsCols = await db('annual_prepay_terms').columnInfo();
    expect(termsCols).not.toHaveProperty('annual_plan_version');
    expect(termsCols).not.toHaveProperty('notice_45_sent_at');
    expect(termsCols).not.toHaveProperty('renewal_charge_consent_at');
    expect(termsCols).not.toHaveProperty('renewed_from_term_id');
    expect(termsCols).toHaveProperty('id');

    const contractCols = await db('customer_contracts').columnInfo();
    expect(contractCols).not.toHaveProperty('annual_plan_version');
    expect(contractCols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after the columns are already gone does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });

  test('up() and down() no-op cleanly when the tables do not exist yet', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('annual_prepay_terms');
    await db.schema.dropTableIfExists('customer_contracts');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
