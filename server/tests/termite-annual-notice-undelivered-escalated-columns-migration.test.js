/**
 * Real PostgreSQL, real DDL: 20260926000108_termite_annual_notice_undelivered_escalated_columns
 * runs its up()/down() against a scratch schema (dropped after each test) in
 * a local throwaway database — same convention as the sibling termite-annual
 * migration tests.
 *
 * Codex #4921 r4 P1: per-rung confirmed-bell witnesses for a 45/30-day
 * termite notice still undelivered after its own deadline.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-notice-undelivered-escalated-columns-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926000108_termite_annual_notice_undelivered_escalated_columns');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const COLUMNS = ['notice_45_undelivered_escalated_at', 'notice_30_undelivered_escalated_at'];

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_noticeundeliv_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926000108_termite_annual_notice_undelivered_escalated_columns — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds both nullable timestamptz escalation columns', async () => {
    const { db } = fixture;
    await migration.up(db);
    const cols = await db('annual_prepay_terms').columnInfo();
    for (const col of COLUMNS) {
      expect(cols[col]).toMatchObject({ type: 'timestamp with time zone', nullable: true });
    }
    const [term] = await db('annual_prepay_terms')
      .insert({ notice_45_undelivered_escalated_at: new Date() })
      .returning('*');
    expect(term.notice_45_undelivered_escalated_at).toBeInstanceOf(Date);
    expect(term.notice_30_undelivered_escalated_at).toBeNull();
  });

  test('up() is idempotent, including when only one column already exists', async () => {
    const { db } = fixture;
    await db.schema.alterTable('annual_prepay_terms', (t) => { t.timestamp('notice_45_undelivered_escalated_at', { useTz: true }); });
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    for (const col of COLUMNS) expect(cols[col]).toBeTruthy();
  });

  test('down() removes both columns and is idempotent (reversible)', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    for (const col of COLUMNS) expect(cols).not.toHaveProperty(col);
  });

  test('tolerates a database without the table', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('annual_prepay_terms');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
