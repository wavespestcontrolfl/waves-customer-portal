/**
 * consultationStats — real Postgres, real migrated schema (codex P1 :1064,
 * round 12). The mocked unit test's hand-built fixture rows can never catch
 * a query referencing a column that doesn't exist — `l.lead_source` (the
 * pre-fix bug: leads has `lead_source_id`, a FK to lead_sources.id, not a
 * plain `lead_source` string) 500'd this endpoint in production on every
 * call and every mocked test stayed green. This suite runs the REAL query
 * against a REAL, fully-migrated database, so a column typo throws here
 * exactly as it would in production.
 *
 * Runs only when CONSULTATION_STATS_TEST_DATABASE_URL points at a local,
 * already-migrated Postgres (this repo's standing convention — see e.g.
 * VOICE_RECOVERY_TEST_DATABASE_URL in call-recording-relay-postgres.test.js,
 * C360_TEST_DATABASE_URL in admin-billing-recovery-postgres.test.js). A
 * quick local repro recipe (this round's own verification — see the
 * round-12 commit for the exact commands): `createdb -h localhost -T
 * waves_audit_tpl waves_audit_<slug>`, then `DATABASE_URL=postgres://…
 * NODE_ENV=development npx knex migrate:latest --knexfile server/knexfile.js`
 * from server/, then point this env var at that database. Skipped (not
 * failed) when unset, so it never blocks a machine without a local PG.
 */
const knex = require('knex');
const { randomUUID } = require('node:crypto');

const connection = process.env.CONSULTATION_STATS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

postgres('consultationStats — real query against real migrated Postgres', () => {
  let db;
  let ids;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) {
      throw new Error('Use isolated loopback PostgreSQL (CONSULTATION_STATS_TEST_DATABASE_URL)');
    }
    db = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    if (!(await db.schema.hasTable('knex_migrations'))) {
      throw new Error('Run development migrations first (see this file\'s header for the recipe)');
    }
    if (!(await db.schema.hasTable('consultation_outcomes'))) {
      throw new Error('consultation_outcomes table missing — migrate to at least 20260924000005 first');
    }
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  beforeEach(async () => {
    ids = {
      technician: randomUUID(),
      customer: randomUUID(),
      leadSource: randomUUID(),
      lead: randomUUID(),
      visit: randomUUID(),
      outcome: randomUUID(),
    };
    await db('technicians').insert({ id: ids.technician, name: 'Consultation Stats Fixture Tech' });
    await db('customers').insert({
      id: ids.customer, first_name: 'Consult Stats', last_name: 'Fixture', phone: `+1941555${Math.floor(1000 + Math.random() * 9000)}`,
      email: `${ids.customer}@example.invalid`, address_line1: '1 Fixture Ln', city: 'Test City', zip: '00000',
    });
    await db('lead_sources').insert({ id: ids.leadSource, name: 'Consult Stats Fixture Source', source_type: 'paid' });
    await db('leads').insert({ id: ids.lead, lead_source_id: ids.leadSource, customer_id: ids.customer });
    await db('scheduled_services').insert({
      id: ids.visit, customer_id: ids.customer, technician_id: ids.technician,
      scheduled_date: new Date().toISOString().slice(0, 10), service_type: 'Waves Assessment', status: 'completed',
    });
    await db('consultation_outcomes').insert({
      id: ids.outcome, scheduled_service_id: ids.visit, customer_id: ids.customer, lead_id: ids.lead,
      outcome: 'warm', interests: JSON.stringify([]),
    });
  });

  afterEach(async () => {
    // Reverse dependency order — only this test's own fixture rows, never a
    // real customer's data (CLAUDE.md rule 13).
    await db('consultation_outcomes').where({ id: ids.outcome }).del();
    await db('leads').where({ id: ids.lead }).del();
    await db('scheduled_services').where({ id: ids.visit }).del();
    await db('lead_sources').where({ id: ids.leadSource }).del();
    await db('customers').where({ id: ids.customer }).del();
    await db('technicians').where({ id: ids.technician }).del();
  });

  test('does not throw (the pre-fix query 500s here: column l.lead_source does not exist)', async () => {
    const { consultationStats } = require('../services/consultation-outcomes');
    await expect(consultationStats({ trx: db })).resolves.toBeDefined();
  });

  test('by_source reports the JOINED lead_sources.name, not a raw leads column', async () => {
    const { consultationStats } = require('../services/consultation-outcomes');
    const stats = await consultationStats({ trx: db });
    const entry = stats.by_source.find((s) => s.lead_source === 'Consult Stats Fixture Source');
    expect(entry).toBeDefined();
    expect(entry.showed).toBeGreaterThanOrEqual(1);
  });
});
