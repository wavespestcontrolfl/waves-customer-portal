/**
 * Real PostgreSQL: lockAndAssertNoAnnualPrepayOverlap's sign-before-pay
 * clause (codex round 3 on #4819, item 8). A termite annual-plan estimate
 * parked 'awaiting_signature' blocks another annual plan only while it can
 * still become one — its annual agreement is signed (activation pending),
 * still signable (draft/sent/viewed, share window open or not yet minted),
 * or not drafted yet. Once every agreement drafted for it is cancelled,
 * voided or expired, the abandoned park stops blocking.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/annual-prepay-overlap-awaiting-signature-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `apt_overlap_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status text, renewal_decision text, term_end date
  )`);
  await db.raw(`CREATE TABLE estimates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, annual_plan_activation_status text
  )`);
  await db.raw(`CREATE TABLE customer_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_template_key text, status text,
    share_token_expires_at timestamptz, document_variables_snapshot jsonb
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('lockAndAssertNoAnnualPrepayOverlap — awaiting-signature commitments (real Postgres)', () => {
  let fixture;
  let customerId;
  let parkedId;
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;

  beforeEach(async () => {
    fixture = await createScratchDb();
    customerId = randomUUID();
    const [parked] = await fixture.db('estimates')
      .insert({ customer_id: customerId, annual_plan_activation_status: 'awaiting_signature' })
      .returning('*');
    parkedId = parked.id;
  });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  const agreement = (status, extra = {}) => fixture.db('customer_contracts').insert({
    document_template_key: ANNUAL_TEMPLATE_KEY,
    status,
    document_variables_snapshot: JSON.stringify({ estimate: { id: parkedId } }),
    ...extra,
  });
  const assertFor = (excludeEstimateId = null) => fixture.db.transaction((trx) => lockAndAssertNoAnnualPrepayOverlap(
    trx, customerId, '2026-10-01', false, 'Customer already has an annual prepay term through', excludeEstimateId,
  ));
  const hour = 3600 * 1000;

  test('no agreement drafted yet: still a binding commitment', async () => {
    await expect(assertFor()).rejects.toMatchObject({ annualPrepayOverlap: { awaitingSignatureEstimateId: parkedId } });
  });

  test.each([
    ['draft, link not minted', 'draft', {}],
    ['sent, link open', 'sent', { share_token_expires_at: new Date(Date.now() + hour) }],
    ['viewed, link open', 'viewed', { share_token_expires_at: new Date(Date.now() + hour) }],
    ['signed, activation pending', 'signed', {}],
  ])('%s: blocks another annual plan', async (_label, status, extra) => {
    await agreement(status, extra);
    await expect(assertFor()).rejects.toMatchObject({ annualPrepayOverlap: { awaitingSignatureEstimateId: parkedId } });
  });

  test.each([
    ['cancelled', 'cancelled', {}],
    ['voided', 'voided', {}],
    ['expired status', 'expired', {}],
    ['sent but the share window closed', 'sent', { share_token_expires_at: new Date(Date.now() - hour) }],
  ])('%s: the abandoned park no longer blocks', async (_label, status, extra) => {
    await agreement(status, extra);
    await expect(assertFor()).resolves.toBeUndefined();
  });

  test('an agreement for a DIFFERENT estimate does not keep this one alive', async () => {
    await agreement('cancelled');
    await fixture.db('customer_contracts').insert({
      document_template_key: ANNUAL_TEMPLATE_KEY, status: 'sent', document_variables_snapshot: JSON.stringify({ estimate: { id: randomUUID() } }),
    });
    await expect(assertFor()).resolves.toBeUndefined();
  });

  test('the estimate itself is excluded (a retry / its own activation never self-blocks)', async () => {
    await agreement('signed');
    await expect(assertFor(parkedId)).resolves.toBeUndefined();
  });
});
