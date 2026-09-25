/**
 * Real PostgreSQL, real DDL: 20260925000006_termite_annual_install_anchor
 * runs its up()/down() against a scratch schema (dropped after each test)
 * in a local throwaway database — same convention as the sibling
 * 20260925000001..000005 migration tests.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-install-anchor-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260925000006_termite_annual_install_anchor');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_anchormig_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260925000006_termite_annual_install_anchor — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds the three nullable columns; the anchor-visit FK nulls on visit delete', async () => {
    const { db } = fixture;
    await migration.up(db);

    const termCols = await db('annual_prepay_terms').columnInfo();
    expect(termCols.installation_anchored_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });
    expect(termCols.installation_anchor_visit_id).toMatchObject({ type: 'uuid', nullable: true });
    const estimateCols = await db('estimates').columnInfo();
    expect(estimateCols.annual_plan_install_handoff_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });

    const [visit] = await db('scheduled_services').insert({}).returning('*');
    const [term] = await db('annual_prepay_terms').insert({
      installation_anchored_at: new Date(), installation_anchor_visit_id: visit.id,
    }).returning('*');
    await db('scheduled_services').where({ id: visit.id }).del();
    const after = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(after.installation_anchor_visit_id).toBeNull();
    expect(after.installation_anchored_at).toBeInstanceOf(Date);
  });

  test('up() is idempotent', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
  });

  test('down() removes all three columns and is idempotent', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    const termCols = await db('annual_prepay_terms').columnInfo();
    expect(termCols).not.toHaveProperty('installation_anchored_at');
    expect(termCols).not.toHaveProperty('installation_anchor_visit_id');
    expect(await db('estimates').columnInfo()).not.toHaveProperty('annual_plan_install_handoff_at');
  });

  test('tolerates a database without the tables', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('annual_prepay_terms');
    await db.schema.dropTableIfExists('scheduled_services');
    await db.schema.dropTableIfExists('estimates');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
