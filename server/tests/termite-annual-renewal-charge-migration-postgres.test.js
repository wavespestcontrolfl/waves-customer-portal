/**
 * Real PostgreSQL, real DDL: 20260926050000_termite_annual_renewal_charge
 * runs its up()/down() against a scratch schema (its own random name,
 * dropped after the suite) inside a local throwaway database — same
 * convention as termite-annual-plan-stamps-migration.test.js.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-charge-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260926050000_termite_annual_renewal_charge');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_renewal_chg_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's alterTable/insert calls touch.
  await db.raw(`
    CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE sms_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key varchar(120) UNIQUE NOT NULL,
      name varchar(200),
      category varchar(60),
      body text,
      variables jsonb,
      is_active boolean,
      sort_order integer,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260926050000_termite_annual_renewal_charge — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds renewal_charge_attempted_at as a nullable timestamptz', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_charge_attempted_at');
    expect(cols.renewal_charge_attempted_at.nullable).toBe(true);
    expect(cols.renewal_charge_attempted_at.type).toBe('timestamp with time zone');

    // The column actually enforces the at-most-once fence shape used by the
    // job: a conditional UPDATE ... WHERE renewal_charge_attempted_at IS NULL
    // only ever matches once.
    const rowId = randomUUID();
    await db('annual_prepay_terms').insert({ id: rowId });
    const first = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_charge_attempted_at')
      .update({ renewal_charge_attempted_at: new Date() });
    expect(first).toBe(1);
    const second = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_charge_attempted_at')
      .update({ renewal_charge_attempted_at: new Date() });
    expect(second).toBe(0);
  });

  test('up() seeds the termite_annual_renewal_charge_failed sms template with its variables', async () => {
    const { db } = fixture;
    await migration.up(db);

    const row = await db('sms_templates').where({ template_key: 'termite_annual_renewal_charge_failed' }).first();
    expect(row).toBeDefined();
    expect(row.is_active).toBe(true);
    expect(row.body).toMatch(/\{first_name\}/);
    expect(row.body).toMatch(/\{amount\}/);
    expect(row.body).toMatch(/\{pay_url\}/);
    const variables = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
    expect(variables).toEqual(['first_name', 'amount', 'pay_url']);
  });

  test('up() is idempotent — running it twice does not throw, upserts the same template row', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_charge_attempted_at');

    const rows = await db('sms_templates').where({ template_key: 'termite_annual_renewal_charge_failed' });
    expect(rows.length).toBe(1);
  });

  test('down() removes the column and the seeded template', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_charge_attempted_at');
    expect(cols).toHaveProperty('id');

    const row = await db('sms_templates').where({ template_key: 'termite_annual_renewal_charge_failed' }).first();
    expect(row).toBeUndefined();
  });

  test('down() is idempotent — a re-run after already-removed does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
