/**
 * The operator receipt claim (claimReceiptJobForOperatorSend /
 * releaseOperatorReceiptClaim) on real PostgreSQL: an operator's send-now
 * holds the invoice's one receipt_delivery_jobs row as `running`, so the
 * drain cannot claim a queued job and no enqueue (the payment webhook, the
 * Intelligence Bar closeout repair) can add one while the operator's receipt
 * is going out — the duplicate-receipt race a mocked knex cannot arbitrate
 * (row locks, ON CONFLICT, two concurrent claimers).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const jobsMigration = require('../models/migrations/20260530000001_payment_plans_and_receipt_delivery_jobs');
const customerInitiatedMigration = require('../models/migrations/20260829000040_receipt_delivery_jobs_customer_initiated');
const {
  claimReceiptJobForOperatorSend,
  releaseOperatorReceiptClaim,
  claimDueReceiptDeliveryJobs,
  enqueueReceiptDelivery,
} = require('../services/receipt-delivery-queue');

const connection = process.env.RECEIPT_CLAIM_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `receipt_claim_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;
jest.setTimeout(30000);

const job = (invoiceId) => mockPg('receipt_delivery_jobs').where({ invoice_id: invoiceId }).first();
async function seedJob(over = {}) {
  const invoiceId = randomUUID();
  await mockPg('receipt_delivery_jobs').insert({ invoice_id: invoiceId, status: 'queued', next_attempt_at: new Date('2026-09-28T12:00:00Z'), ...over });
  return invoiceId;
}

postgres('operator receipt claim on PostgreSQL', () => {
  beforeAll(async () => {
    admin = knex({ client: 'pg', connection });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    await jobsMigration.up(mockPg);
    await customerInitiatedMigration.up(mockPg);
  });
  afterAll(async () => {
    await mockPg?.destroy();
    await admin?.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await admin?.destroy();
  });

  test('no job yet: the claim row blocks the drain and every enqueue; an undelivered email removes it', async () => {
    const invoiceId = randomUUID();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    expect(claim).toMatchObject({ id: expect.any(String), prior: null });
    expect(await job(invoiceId)).toMatchObject({ status: 'running', source: 'operator_send', locked_by: claim.token });

    expect((await claimDueReceiptDeliveryJobs({ limit: 50 })).map((j) => j.invoice_id)).not.toContain(invoiceId);
    expect(await enqueueReceiptDelivery({ invoiceId, source: 'ib_closeout_repair' })).toEqual({ enqueued: false, deduped: true });

    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    expect(await job(invoiceId)).toBeUndefined();
  });

  test('a delivered email completes the claim row, so a later enqueue still dedupes', async () => {
    const invoiceId = randomUUID();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    await releaseOperatorReceiptClaim(claim, { emailDelivered: true, smsResult: { ok: true }, emailResult: { ok: true } });
    expect(await job(invoiceId)).toMatchObject({ status: 'completed', locked_by: null, email_result: { ok: true } });
    expect(await enqueueReceiptDelivery({ invoiceId })).toEqual({ enqueued: false, deduped: true });
  });

  test('a queued job is held while the operator sends, then goes back exactly as it was when the email did not go out', async () => {
    const invoiceId = await seedJob({ status: 'retry_scheduled' });
    const before = await job(invoiceId);
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    expect(claim).toMatchObject({ id: before.id, prior: { status: 'retry_scheduled' } });
    expect(await job(invoiceId)).toMatchObject({ status: 'running', locked_by: claim.token });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    const after = await job(invoiceId);
    expect(after).toMatchObject({ status: 'retry_scheduled', locked_by: null, locked_at: null, attempts: before.attempts });
    expect(after.next_attempt_at.toISOString()).toBe(before.next_attempt_at.toISOString());
  });

  test('a queued job is completed by the operator send that delivered the email — the drain never repeats it', async () => {
    const invoiceId = await seedJob();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    await releaseOperatorReceiptClaim(claim, { emailDelivered: true, emailResult: { ok: true } });
    expect(await job(invoiceId)).toMatchObject({ status: 'completed', source: 'stripe_webhook' });
  });

  test('a job the drain is delivering right now refuses the operator send and is left alone', async () => {
    const invoiceId = await seedJob({ status: 'running', locked_at: new Date(), locked_by: 'worker-1' });
    expect(await claimReceiptJobForOperatorSend(invoiceId)).toEqual({ inFlight: true });
    expect(await job(invoiceId)).toMatchObject({ status: 'running', locked_by: 'worker-1' });
  });

  test('a stale running job (dead worker) is taken over and handed back due now', async () => {
    const invoiceId = await seedJob({ status: 'running', locked_at: new Date(Date.now() - 60 * 60 * 1000), locked_by: 'dead-worker' });
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    expect(claim).toMatchObject({ prior: { status: 'retry_scheduled' } });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    expect(await job(invoiceId)).toMatchObject({ status: 'retry_scheduled', locked_by: null });
  });

  test('a completed or failed job holds no claim and is not touched', async () => {
    for (const status of ['completed', 'failed']) {
      const invoiceId = await seedJob({ status });
      expect(await claimReceiptJobForOperatorSend(invoiceId)).toEqual({ id: null });
      await releaseOperatorReceiptClaim({ id: null });
      expect(await job(invoiceId)).toMatchObject({ status, locked_by: null });
    }
  });

  test('two operator sends racing on one queued job: exactly one claims it, the other is refused', async () => {
    const invoiceId = await seedJob();
    const results = await Promise.all([claimReceiptJobForOperatorSend(invoiceId), claimReceiptJobForOperatorSend(invoiceId)]);
    expect(results.filter((r) => r.id).length).toBe(1);
    expect(results.filter((r) => r.inFlight).length).toBe(1);
  });

  test('two operator sends racing with no job: exactly one inserts the claim, the other is refused', async () => {
    const invoiceId = randomUUID();
    const results = await Promise.all([claimReceiptJobForOperatorSend(invoiceId), claimReceiptJobForOperatorSend(invoiceId)]);
    expect(results.filter((r) => r.id).length).toBe(1);
    expect(results.filter((r) => r.inFlight).length).toBe(1);
  });

  test('a release only touches the claim it holds — a row re-owned since is left alone', async () => {
    const invoiceId = await seedJob();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    await mockPg('receipt_delivery_jobs').where({ id: claim.id }).update({ locked_by: 'worker-2' });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: true });
    expect(await job(invoiceId)).toMatchObject({ status: 'running', locked_by: 'worker-2' });
  });
});
