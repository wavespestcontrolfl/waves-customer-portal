/**
 * Real PostgreSQL, real DDL: 20260925000005_termite_annual_signature_charge
 * runs its up()/down() against a scratch schema (dropped after each test)
 * in a local throwaway database — same convention as the sibling
 * 20260925000001..000004 migration tests.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-signature-charge-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260925000005_termite_annual_signature_charge');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_sigmig_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw('CREATE TABLE estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw('CREATE TABLE customer_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw('CREATE TABLE payment_method_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('20260925000005_termite_annual_signature_charge — real Postgres DDL', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() adds both nullable columns; the claim round-trips as jsonb and the evidence FK nulls on contract delete', async () => {
    const { db } = fixture;
    await migration.up(db);

    const estimateCols = await db('estimates').columnInfo();
    expect(estimateCols.annual_plan_signature_charge).toMatchObject({ type: 'jsonb', nullable: true });
    const consentCols = await db('payment_method_consents').columnInfo();
    expect(consentCols.evidence_contract_id).toMatchObject({ type: 'uuid', nullable: true });

    const [estimate] = await db('estimates').insert({
      annual_plan_signature_charge: JSON.stringify({ status: 'claimed', claim_token: 't' }),
    }).returning('*');
    const claimed = await db('estimates').where({ id: estimate.id })
      .whereRaw("annual_plan_signature_charge ->> 'claim_token' = ?", ['t']).first();
    expect(claimed.annual_plan_signature_charge).toEqual({ status: 'claimed', claim_token: 't' });

    const [contract] = await db('customer_contracts').insert({}).returning('*');
    const [consent] = await db('payment_method_consents').insert({ evidence_contract_id: contract.id }).returning('*');
    await db('customer_contracts').where({ id: contract.id }).del();
    expect((await db('payment_method_consents').where({ id: consent.id }).first()).evidence_contract_id).toBeNull();
  });

  test('up() is idempotent', async () => {
    const { db } = fixture;
    await migration.up(db);
    await expect(migration.up(db)).resolves.not.toThrow();
  });

  test('down() removes both columns and is idempotent', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    await expect(migration.down(db)).resolves.not.toThrow();
    expect(await db('estimates').columnInfo()).not.toHaveProperty('annual_plan_signature_charge');
    expect(await db('payment_method_consents').columnInfo()).not.toHaveProperty('evidence_contract_id');
  });

  test('tolerates a database without the tables', async () => {
    const { db } = fixture;
    await db.schema.dropTableIfExists('payment_method_consents');
    await db.schema.dropTableIfExists('estimates');
    await expect(migration.up(db)).resolves.not.toThrow();
    await expect(migration.down(db)).resolves.not.toThrow();
  });
});
