/**
 * Real migrated PostgreSQL: 20260928170000_visit_prep_tech_seen (nullable
 * visit_prep_submissions.tech_seen_at). Separate file from
 * visit-prep-postgres.test.js (which proves the PR #5176 foundation
 * migration) so this PR's own migration gets its own up/down/up proof and
 * a real whereNull-guarded stamp, without touching that file.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('visit_prep_submissions.tech_seen_at against migrated PostgreSQL', () => {
  let database;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const ownedScratch = url.pathname.includes('visit_prep');
    if (!localCI && !ownedQA && !ownedScratch) throw new Error('Use a disposable local/CI/scratch database for this suite.');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 5 } });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  async function fixtureSvc(trx) {
    const customerId = randomUUID();
    const svcId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Tester',
      phone: `+1555${customerId.slice(0, 7)}`, address_line1: '100 Synthetic Ln',
      city: 'Bradenton', zip: '34201', active: true,
    });
    await trx('scheduled_services').insert({
      id: svcId, customer_id: customerId, scheduled_date: '2099-01-01',
      service_type: 'pest_control', status: 'confirmed', is_recurring: true,
    });
    return { customerId, svcId };
  }

  test('migration up/down/up is clean and additive to the existing table', async () => {
    const migration = require('../models/migrations/20260928170000_visit_prep_tech_seen');
    const trx = await database.transaction();
    try {
      expect(await trx.schema.hasColumn('visit_prep_submissions', 'tech_seen_at')).toBe(true);
      await migration.down(trx);
      expect(await trx.schema.hasColumn('visit_prep_submissions', 'tech_seen_at')).toBe(false);
      // The table itself (PR #5176's migration) is untouched by this one's down().
      expect(await trx.schema.hasTable('visit_prep_submissions')).toBe(true);
      await migration.up(trx);
      expect(await trx.schema.hasColumn('visit_prep_submissions', 'tech_seen_at')).toBe(true);
      // Idempotent: running up() again against a column that already
      // exists is a no-op, not an error (hasColumn guard).
      await migration.up(trx);
      expect(await trx.schema.hasColumn('visit_prep_submissions', 'tech_seen_at')).toBe(true);
    } finally {
      await trx.rollback();
    }
  });

  test('defaults to NULL, and the whereNull-guarded first-time stamp is idempotent under a real UPDATE', async () => {
    const trx = await database.transaction();
    try {
      const { customerId, svcId } = await fixtureSvc(trx);
      const submissionId = randomUUID();
      await trx('visit_prep_submissions').insert({
        id: submissionId, scheduled_service_id: svcId, customer_id: customerId, entry: 'appointment_page',
      });
      const before = await trx('visit_prep_submissions').where({ id: submissionId }).first('tech_seen_at');
      expect(before.tech_seen_at).toBeNull();

      // First stamp — same whereNull-guarded UPDATE the route issues.
      const firstUpdate = await trx('visit_prep_submissions')
        .whereIn('id', [submissionId]).whereNull('tech_seen_at')
        .update({ tech_seen_at: trx.fn.now() });
      expect(firstUpdate).toBe(1);
      const afterFirst = await trx('visit_prep_submissions').where({ id: submissionId }).first('tech_seen_at');
      expect(afterFirst.tech_seen_at).not.toBeNull();

      // A second stamp (e.g. the tech reopens the brief) is a no-op —
      // "first time only" — and the original timestamp is preserved.
      const secondUpdate = await trx('visit_prep_submissions')
        .whereIn('id', [submissionId]).whereNull('tech_seen_at')
        .update({ tech_seen_at: trx.fn.now() });
      expect(secondUpdate).toBe(0);
      const afterSecond = await trx('visit_prep_submissions').where({ id: submissionId }).first('tech_seen_at');
      expect(new Date(afterSecond.tech_seen_at).getTime()).toBe(new Date(afterFirst.tech_seen_at).getTime());
    } finally {
      await trx.rollback();
    }
  });
});
