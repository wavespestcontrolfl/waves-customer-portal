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
  recordOperatorReceiptDelivered,
  _internals: { recoverStaleLocks },
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
    await mockPg.schema.createTable('invoices', (t) => { t.uuid('id').primary(); t.timestamp('receipt_sent_at'); });
  });
  afterAll(async () => {
    await mockPg?.destroy();
    await admin?.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await admin?.destroy();
  });

  test('no job yet: the claim row blocks the drain; an undelivered email removes it', async () => {
    const invoiceId = randomUUID();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    expect(claim).toMatchObject({ id: expect.any(String), prior: null });
    expect(await job(invoiceId)).toMatchObject({ status: 'running', source: 'operator_send', locked_by: claim.token });
    expect((await claimDueReceiptDeliveryJobs({ limit: 50 })).map((j) => j.invoice_id)).not.toContain(invoiceId);

    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    expect(await job(invoiceId)).toBeUndefined();
  });

  test('an enqueue during a claim the operator created is kept: still held from the drain, then queued when the email did not go out', async () => {
    const invoiceId = randomUUID();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    const queued = await enqueueReceiptDelivery({ invoiceId, source: 'ib_closeout_repair', customerInitiated: true });
    expect(queued).toMatchObject({ enqueued: true, job: { status: 'running', locked_by: claim.token, source: 'ib_closeout_repair' } });
    expect((await claimDueReceiptDeliveryJobs({ limit: 50 })).map((j) => j.invoice_id)).not.toContain(invoiceId);

    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    expect(await job(invoiceId)).toMatchObject({ status: 'queued', source: 'ib_closeout_repair', customer_initiated: true, locked_by: null });
    const drained = await claimDueReceiptDeliveryJobs({ limit: 50 });
    expect(drained.map((j) => j.invoice_id)).toContain(invoiceId);
  });

  test('an enqueue during an operator claim whose email went out is completed with it — no second email', async () => {
    const invoiceId = randomUUID();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    await enqueueReceiptDelivery({ invoiceId, source: 'stripe_webhook' });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: true, emailResult: { ok: true } });
    expect(await job(invoiceId)).toMatchObject({ status: 'completed', source: 'stripe_webhook' });
  });

  test('an enqueue while an operator holds an existing queued job still dedupes — that job is restored as it was', async () => {
    const invoiceId = await seedJob();
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    expect(await enqueueReceiptDelivery({ invoiceId, source: 'ib_closeout_repair' })).toEqual({ enqueued: false, deduped: true });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: false });
    expect(await job(invoiceId)).toMatchObject({ status: 'queued', source: 'stripe_webhook' });
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
    expect(await claimReceiptJobForOperatorSend(invoiceId)).toEqual({ inFlight: true, byOperator: false });
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

  test('stale operator claims: own email recorded → invoice stamped + closed; claim-created row → removed; anything else → requeued', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const age = (claim) => mockPg('receipt_delivery_jobs').where({ id: claim.id }).update({ locked_at: stale });
    // The operator's email went out (evidence recorded), then it died before
    // stamping the invoice or releasing.
    const sentId = await seedJob();
    await mockPg('invoices').insert({ id: sentId, receipt_sent_at: null });
    const sentClaim = await claimReceiptJobForOperatorSend(sentId);
    await recordOperatorReceiptDelivered(sentClaim, 'email');
    await age(sentClaim);
    // A job whose earlier drain attempt texted (its email still owed): the
    // operator claimed it and died before sending — no evidence for this claim.
    const owedId = await seedJob({ status: 'retry_scheduled', email_result: { ok: true } });
    await age(await claimReceiptJobForOperatorSend(owedId));
    // Evidence from a DIFFERENT (earlier) claim does not count for this one.
    const otherId = await seedJob({ status: 'running', locked_at: stale, locked_by: 'operator:host:1:new', email_result: { ok: true, operator_claim: 'operator:host:1:old' } });
    // A row the claim created, nothing sent, no enqueue took it over: no receipt was ever owed.
    const syntheticId = randomUUID();
    await age(await claimReceiptJobForOperatorSend(syntheticId));
    // The same, but an enqueue took it over: that automatic receipt is owed.
    const takenId = randomUUID();
    const takenClaim = await claimReceiptJobForOperatorSend(takenId);
    await enqueueReceiptDelivery({ invoiceId: takenId, source: 'stripe_webhook' });
    await age(takenClaim);
    const workerId = await seedJob({ status: 'running', locked_at: stale, locked_by: 'worker-9' });

    await recoverStaleLocks();
    expect(await job(sentId)).toMatchObject({ status: 'completed', locked_by: null, last_error: expect.stringMatching(/email was sent/) });
    expect((await mockPg('invoices').where({ id: sentId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(owedId)).toMatchObject({ status: 'retry_scheduled', locked_by: null });
    expect(await job(otherId)).toMatchObject({ status: 'retry_scheduled' });
    expect(await job(syntheticId)).toBeUndefined();
    expect(await job(takenId)).toMatchObject({ status: 'retry_scheduled', source: 'stripe_webhook' });
    expect(await job(workerId)).toMatchObject({ status: 'retry_scheduled' });
  });

  test('a new operator send on a stale claim settles it by the recovery rules first — never inherits it', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    // A stale claim-created row, nothing sent: removed, so a text-only
    // resend then leaves no automatic email behind.
    const syntheticId = randomUUID();
    const first = await claimReceiptJobForOperatorSend(syntheticId);
    await mockPg('receipt_delivery_jobs').where({ id: first.id }).update({ locked_at: stale });
    const second = await claimReceiptJobForOperatorSend(syntheticId);
    expect(second).toMatchObject({ id: expect.any(String), prior: null });
    expect(second.id).not.toBe(first.id);
    await releaseOperatorReceiptClaim(second, { emailDelivered: false });
    expect(await job(syntheticId)).toBeUndefined();

    // A stale claim whose own email was recorded: closed (and the invoice
    // stamped), and THIS send is refused — the receipt already went out.
    const sentId = await seedJob();
    await mockPg('invoices').insert({ id: sentId, receipt_sent_at: null });
    const sentClaim = await claimReceiptJobForOperatorSend(sentId);
    await recordOperatorReceiptDelivered(sentClaim, 'email');
    await mockPg('receipt_delivery_jobs').where({ id: sentClaim.id }).update({ locked_at: stale });
    expect(await claimReceiptJobForOperatorSend(sentId)).toEqual({ alreadySent: true });
    expect((await mockPg('invoices').where({ id: sentId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(sentId)).toMatchObject({ status: 'completed', email_result: { operator_claim: sentClaim.token } });
  });

  test('a delivered release stamps the invoice itself — the caller\'s own stamp may have failed', async () => {
    const invoiceId = await seedJob();
    await mockPg('invoices').insert({ id: invoiceId, receipt_sent_at: null });
    const claim = await claimReceiptJobForOperatorSend(invoiceId);
    await releaseOperatorReceiptClaim(claim, { emailDelivered: true, emailResult: { ok: true } });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(invoiceId)).toMatchObject({ status: 'completed' });
  });

  test('the drain recovered a delivered claim between the caller\'s read and this claim: refused when the caller saw it unsent, allowed as a deliberate resend otherwise', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const invoiceId = await seedJob();
    await mockPg('invoices').insert({ id: invoiceId, receipt_sent_at: null });
    const crashed = await claimReceiptJobForOperatorSend(invoiceId);
    await recordOperatorReceiptDelivered(crashed, 'email');
    await mockPg('receipt_delivery_jobs').where({ id: crashed.id }).update({ locked_at: stale });
    // The route reads the invoice (unstamped)… then the drain's own recovery runs first.
    await recoverStaleLocks();
    expect(await job(invoiceId)).toMatchObject({ status: 'completed' });
    expect(await claimReceiptJobForOperatorSend(invoiceId, { sawUnsent: true })).toEqual({ alreadySent: true });
    // An operator who saw it already receipted is resending on purpose.
    expect(await claimReceiptJobForOperatorSend(invoiceId, { sawUnsent: false })).toEqual({ id: null });
  });

  test('the drain completes the job while the claim waits on its lock: the claim re-reads the stamp after locking and refuses', async () => {
    const invoiceId = await seedJob();
    await mockPg('invoices').insert({ id: invoiceId, receipt_sent_at: null });
    // The drain holds the job row; the route has already read the invoice unstamped.
    let release;
    const drainDone = new Promise((r) => { release = r; });
    const drain = mockPg.transaction(async (trx) => {
      await trx('receipt_delivery_jobs').where({ invoice_id: invoiceId }).forUpdate().first();
      await drainDone;
      await trx('invoices').where({ id: invoiceId }).update({ receipt_sent_at: new Date() });
      await trx('receipt_delivery_jobs').where({ invoice_id: invoiceId }).update({ status: 'completed' });
    });
    const claiming = claimReceiptJobForOperatorSend(invoiceId, { sawUnsent: true });
    await new Promise((r) => { setTimeout(r, 300); }); // the claim is now blocked on the job lock
    release();
    await drain;
    expect(await claiming).toEqual({ alreadySent: true });
  });

  test('a claim row inserted for an invoice that turns out already stamped is rolled back', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, receipt_sent_at: new Date() });
    expect(await claimReceiptJobForOperatorSend(invoiceId, { sawUnsent: true })).toEqual({ alreadySent: true });
    expect(await job(invoiceId)).toBeUndefined();
  });

  test('a text-only delivery stamps the invoice before the queued job is handed back (it still owes the email)', async () => {
    const invoiceId = await seedJob();
    await mockPg('invoices').insert({ id: invoiceId, receipt_sent_at: null });
    const claim = await claimReceiptJobForOperatorSend(invoiceId, { sawUnsent: true });
    await releaseOperatorReceiptClaim(claim, { emailDelivered: false, smsDelivered: true });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(invoiceId)).toMatchObject({ status: 'queued', locked_by: null });
  });

  test('a stale operator claim whose TEXT went out: invoice stamped (the requeued job never texts again); a queued job still owes its email, a claim-created row goes away', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const heldId = await seedJob();
    await mockPg('invoices').insert({ id: heldId, receipt_sent_at: null });
    const held = await claimReceiptJobForOperatorSend(heldId, { sawUnsent: true });
    await recordOperatorReceiptDelivered(held, 'sms');
    await mockPg('receipt_delivery_jobs').where({ id: held.id }).update({ locked_at: stale });
    const synthId = randomUUID();
    await mockPg('invoices').insert({ id: synthId, receipt_sent_at: null });
    const synth = await claimReceiptJobForOperatorSend(synthId, { sawUnsent: true });
    await recordOperatorReceiptDelivered(synth, 'sms');
    await mockPg('receipt_delivery_jobs').where({ id: synth.id }).update({ locked_at: stale });

    await recoverStaleLocks();
    expect((await mockPg('invoices').where({ id: heldId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(heldId)).toMatchObject({ status: 'retry_scheduled', locked_by: null });
    expect((await mockPg('invoices').where({ id: synthId }).first()).receipt_sent_at).toBeInstanceOf(Date);
    expect(await job(synthId)).toBeUndefined();
  });

  test('an in-flight refusal says whether another operator send or the drain holds the job', async () => {
    const operatorHeld = randomUUID();
    await claimReceiptJobForOperatorSend(operatorHeld);
    expect(await claimReceiptJobForOperatorSend(operatorHeld)).toEqual({ inFlight: true, byOperator: true });
    const drainHeld = await seedJob({ status: 'running', locked_at: new Date(), locked_by: 'host:123' });
    expect(await claimReceiptJobForOperatorSend(drainHeld)).toEqual({ inFlight: true, byOperator: false });
  });
});
