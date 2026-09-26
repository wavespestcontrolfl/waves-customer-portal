/**
 * Real PostgreSQL: P2-4 (owner ruling 2026-09-26) — an unpaid termite
 * renewal successor stays COVERED through its own 30-day payment grace.
 * Runs coveredTermsAsOf's real SQL (the GREATEST(term_start, created_at)
 * + INTERVAL grace-deadline expression, the invoice-status exclusion) —
 * not mocked — against a scratch schema.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-grace-coverage-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_grace_cov_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    paid_at timestamptz,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text,
    refund_status text,
    stripe_payment_intent_id text,
    stripe_charge_id text
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    prepay_invoice_id uuid,
    status text NOT NULL,
    renewal_decision text,
    renewed_from_term_id uuid,
    annual_plan_version text,
    term_start date NOT NULL,
    term_end date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

describeOrSkip('coveredTermsAsOf — termite renewal grace coverage (P2-4), real Postgres', () => {
  let fixture;
  let db;
  let customerId;
  let invoiceId;

  beforeEach(async () => {
    fixture = await createScratchDb();
    db = fixture.db;
    customerId = randomUUID();
    invoiceId = randomUUID();
    await db('invoices').insert({ id: invoiceId, status: 'sent' });
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  async function insertSuccessor({ termStart, createdAt, termEnd = '2099-01-01', overrides = {} } = {}) {
    const id = randomUUID();
    await db('annual_prepay_terms').insert({
      id,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      status: 'payment_pending',
      renewed_from_term_id: randomUUID(),
      annual_plan_version: 'v3',
      term_start: termStart,
      term_end: termEnd,
      created_at: createdAt,
      ...overrides,
    });
    return id;
  }

  test('covered on day 0 (term_start itself)', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-09-27').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('covered on day 29', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-26').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('covered exactly on the deadline (day 30)', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-27').where('t.id', id).first('t.id');
    expect(row).toBeDefined();
  });

  test('NOT covered the day after the deadline', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-28').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });

  test('the deadline anchors on the LATER of term_start / created_at — a delayed mint keeps the full window', async () => {
    // Minted 5 days after its nominal term_start.
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-10-02T12:00:00Z' });
    // Day 34 from term_start (= day 29 from created_at) is still covered.
    const stillCovered = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-31').where('t.id', id).first('t.id');
    expect(stillCovered).toBeDefined();
    // Day 32 from created_at is not.
    const lapsed = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-11-03').where('t.id', id).first('t.id');
    expect(lapsed).toBeUndefined();
  });

  test('NOT covered after the invoice actually voids', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z' });
    const coveredBefore = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(coveredBefore).toBeDefined();
    await db('invoices').where({ id: invoiceId }).update({ status: 'void' });
    const coveredAfter = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(coveredAfter).toBeUndefined();
  });

  test('a non-termite payment_pending term (no annual_plan_version) is still NOT covered', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', overrides: { annual_plan_version: null } });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });

  test('an ORIGINAL (non-successor) termite payment_pending term is still NOT covered', async () => {
    const id = await insertSuccessor({ termStart: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', overrides: { renewed_from_term_id: null } });
    const row = await AnnualPrepayRenewals.coveredTermsAsOf(db, '2026-10-01').where('t.id', id).first('t.id');
    expect(row).toBeUndefined();
  });
});
