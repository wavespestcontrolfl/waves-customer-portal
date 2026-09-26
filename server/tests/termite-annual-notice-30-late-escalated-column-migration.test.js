/**
 * Real PostgreSQL, real DDL: 20260926000107_termite_annual_notice_30_late_escalated_column
 * runs its up()/down() against a scratch schema (dropped after each test) in
 * a local throwaway database — same convention as the sibling termite-annual
 * migration tests (e.g. termite-annual-notice-45-late-escalated-column-migration.test.js).
 *
 * Pre-push audit P1 on the #4921 r3 structural fix: 000106 added
 * notice_30_late_sent_at and notice_missed_escalated_at but never
 * notice_30_late_escalated_at, which termiteLateNoticeEscalationCandidates()
 * queries unconditionally — this migration is the fix.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-notice-30-late-escalated-column-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926000107_termite_annual_notice_30_late_escalated_column');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_notice30lateesc_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926000107_termite_annual_notice_30_late_escalated_column — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds the nullable timestamptz escalation column', async () => {
    const { db } = fixture;
    await migration.up(db);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols.notice_30_late_escalated_at).toMatchObject({ type: 'timestamp with time zone', nullable: true });

    const [term] = await db('annual_prepay_terms').insert({ notice_30_late_escalated_at: new Date() }).returning('*');
    expect(term.notice_30_late_escalated_at).toBeInstanceOf(Date);
  });

  test('up() is idempotent', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols.notice_30_late_escalated_at).toBeTruthy();
  });

  test('down() removes the column and is idempotent (reversible)', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('notice_30_late_escalated_at');
  });

  test('tolerates a database without the table', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('annual_prepay_terms');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
