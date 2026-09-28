/**
 * Real PostgreSQL, real DDL: 20260928000100_termite_annual_renewal_payment_
 * method_neutral_wording runs its up()/down() against a scratch schema (its
 * own random name, dropped after the suite) inside a local throwaway
 * database — same convention as termite-annual-renewal-charge-migration-
 * postgres.test.js (20260926050000, pushed/frozen — this is a SEPARATE, new
 * migration file that only UPDATES the row it left behind).
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     ../node_modules/.bin/jest --runInBand --coverage=false termite-annual-renewal-payment-method-neutral-wording-migration-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260928000100_termite_annual_renewal_payment_method_neutral_wording');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const TEMPLATE_KEY = 'termite_annual_renewal_charge_failed';
const OLD_BODY = "Hi {first_name}, we tried to charge your card on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.";

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_neutral_wording_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // Minimal shape the migration's alterTable/update calls touch — the
  // sms_templates row is seeded exactly as 20260926050000's own up()
  // would have left it, standing in for that already-applied migration.
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
  await db('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Termite Annual Renewal — Charge Failed',
    category: 'billing',
    body: OLD_BODY,
    variables: JSON.stringify(['first_name', 'amount', 'pay_url']),
    is_active: true,
    sort_order: 51,
  });
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260928000100_termite_annual_renewal_payment_method_neutral_wording — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  // Finding 4: the decline template said "card on file", but the renewal
  // charge also debits ACH/us_bank_account methods on file.
  test('up() rewords the template to payment-method-neutral wording, keeping the rest of the copy identical', async () => {
    const { db } = fixture;
    await migration.up(db);

    const row = await db('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
    expect(row.body).toMatch(/payment method on file/);
    expect(row.body).not.toMatch(/card on file/);
    // Same placeholders, same pay-link/close copy — only the instrument
    // wording changed.
    expect(row.body).toMatch(/\{first_name\}/);
    expect(row.body).toMatch(/\{amount\}/);
    expect(row.body).toMatch(/\{pay_url\}/);
    expect(row.body).toMatch(/Please pay here to keep your coverage active/);
    expect(row.body).toMatch(/Just reply to this message\.$/);
    // No signature added (owner ruling: no signature on texts).
    expect(row.body).not.toMatch(/-\s*Waves/i);
  });

  test('up() adds renewal_parent_deleted_conflict_belled_at as a nullable timestamptz', async () => {
    const { db } = fixture;
    await migration.up(db);

    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_parent_deleted_conflict_belled_at');
    expect(cols.renewal_parent_deleted_conflict_belled_at.nullable).toBe(true);
    expect(cols.renewal_parent_deleted_conflict_belled_at.type).toBe('timestamp with time zone');
  });

  // Finding 5: the exclusion marker's own claim shape — a scan's
  // `whereNull(...).update(...)` claims the row exactly once.
  test('the new column supports the exact whereNull/update exclusion shape the scan uses', async () => {
    const { db } = fixture;
    await migration.up(db);
    const rowId = randomUUID();
    await db('annual_prepay_terms').insert({ id: rowId });

    const claimed = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_parent_deleted_conflict_belled_at')
      .update({ renewal_parent_deleted_conflict_belled_at: new Date() });
    expect(claimed).toBe(1);

    const reclaimed = await db('annual_prepay_terms').where({ id: rowId }).whereNull('renewal_parent_deleted_conflict_belled_at')
      .update({ renewal_parent_deleted_conflict_belled_at: new Date() });
    expect(reclaimed).toBe(0);
  });

  test('up() is idempotent — running it twice does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();

    const row = await db('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
    expect(row.body).toMatch(/payment method on file/);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).toHaveProperty('renewal_parent_deleted_conflict_belled_at');
  });

  test('down() restores the exact prior template text and drops the new column', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);

    const row = await db('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
    expect(row.body).toBe(OLD_BODY);
    const cols = await db('annual_prepay_terms').columnInfo();
    expect(cols).not.toHaveProperty('renewal_parent_deleted_conflict_belled_at');
    expect(cols).toHaveProperty('id');
  });

  test('down() is idempotent — a re-run after already-reverted does not throw', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
