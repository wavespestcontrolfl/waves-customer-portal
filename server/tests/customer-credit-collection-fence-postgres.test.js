// dunningDraw against real Postgres (disposable schema on a
// private QA / isolated CI database; skipped without APP_TEST_DATABASE_URL).
// The customer-dunning credit draw must not consume account credit while a
// saved-card attempt is submitted-but-unresolved (or an orphan charge exists):
// Stripe may already have taken the money. The fence runs under the invoice
// row lock in the apply's own transaction, and a stale submitted claim's
// promotion to 'ambiguous' COMMITS with that transaction because the refusal
// is a returned sentinel, not a throw. The received-deposit half of the fence
// is covered by the unit suite (its estimate/ledger tables are unrelated
// fixture weight here), so estimate-deposits' assertion is a no-op below.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const mockDepositReady = jest.fn(async () => undefined);
jest.mock('../services/estimate-deposits', () => ({
  ...jest.requireActual('../services/estimate-deposits'),
  assertInvoiceDepositSettlementReady: (...a) => mockDepositReady(...a),
}));

// The live payer resolve is replaced by a reader of scheduled_services.payer_id
// on the connection it is handed, so the tests prove WHICH connection (the
// apply's own transaction) and WHEN (under lock) it is asked, without the
// payer tables. The real resolver is covered by its own suites.
const mockPayerSeen = [];
jest.mock('../services/payer', () => ({
  resolveForInvoice: async ({ database, scheduledServiceId }) => {
    mockPayerSeen.push({ isTransaction: database.isTransaction === true });
    if (!scheduledServiceId) return { payerId: null };
    const row = await database('scheduled_services').where({ id: scheduledServiceId }).first('payer_id');
    return { payerId: row?.payer_id || null };
  },
}));

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `credit_fence_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(30000);

postgres('applyAccountCreditToInvoice dunningDraw (PostgreSQL)', () => {
  let admin;
  let app;
  let CustomerCredit;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
    await app.schema.createTable('customers', (t) => {
      t.uuid('id').primary();
      t.decimal('account_credits', 12, 2).defaultTo(0);
      t.boolean('auto_apply_account_credit').defaultTo(false);
      t.timestamp('updated_at');
    });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.decimal('total', 12, 2);
      t.decimal('credit_applied', 12, 2).defaultTo(0);
      t.uuid('payer_id');
      t.string('stripe_payment_intent_id');
      t.uuid('scheduled_service_id');
      t.string('scheduled_send_error');
      t.string('prepaid_prev_status');
      t.timestamp('prepaid_at');
      t.string('prepaid_by');
      t.timestamp('paid_at');
      t.timestamp('updated_at');
    });
    await app.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.uuid('payer_id');
    });
    await app.schema.createTable('invoice_followup_sequences', (t) => {
      t.uuid('id').primary();
      t.uuid('invoice_id');
      t.string('status');
    });
    await app.schema.createTable('payment_plans', (t) => {
      t.uuid('id');
      t.uuid('invoice_id');
      t.string('status');
    });
    await app.schema.createTable('customer_credit_ledger', (t) => {
      t.increments('id');
      t.uuid('customer_id');
      t.decimal('delta', 12, 2);
      t.decimal('balance_after', 12, 2);
      t.string('source');
      t.uuid('invoice_id');
      t.uuid('referral_id');
      t.text('note');
      t.string('created_by');
      t.timestamp('created_at').defaultTo(app.fn.now());
    });
    await app.schema.createTable('stripe_invoice_charge_attempts', (t) => {
      t.uuid('id').primary();
      t.uuid('invoice_id');
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.string('idempotency_key');
      t.text('error_message');
      t.timestamp('submitted_at');
      t.timestamp('resolved_at');
      t.timestamp('created_at');
      t.timestamp('updated_at');
    });
    await app.schema.createTable('stripe_orphan_charges', (t) => {
      t.uuid('invoice_id');
      t.boolean('resolved');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('payments', (t) => {
      t.uuid('id').primary();
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.jsonb('metadata');
      t.uuid('superseded_by_payment_id');
    });
    CustomerCredit = require('../services/customer-credit');
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  async function seed() {
    const f = { customerId: randomUUID(), invoiceId: randomUUID() };
    await app('customers').insert({ id: f.customerId, account_credits: 40, auto_apply_account_credit: true });
    await app('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, status: 'overdue', total: 100, credit_applied: 0 });
    return f;
  }
  async function attempt(f, { stale, submitted }) {
    const id = randomUUID();
    const at = stale ? new Date(Date.now() - 10 * 60 * 1000) : new Date();
    await app('stripe_invoice_charge_attempts').insert({
      id, invoice_id: f.invoiceId, status: 'claimed', idempotency_key: `inv_card_on_file_${f.invoiceId}_${id}`,
      submitted_at: submitted ? at : null, created_at: at, updated_at: at,
    });
    return id;
  }
  const state = async (f) => ({
    inv: await app('invoices').where({ id: f.invoiceId }).first('credit_applied'),
    cust: await app('customers').where({ id: f.customerId }).first('account_credits'),
    ledger: await app('customer_credit_ledger').where({ customer_id: f.customerId }),
  });
  const apply = (f, opts) => app.transaction((trx) => CustomerCredit.applyAccountCreditToInvoice({ invoiceId: f.invoiceId, ...opts }, trx));

  test('control: a clean invoice draws credit as before', async () => {
    const f = await seed();
    const out = await apply(f, { dunningDraw: true });
    expect(out).toMatchObject({ applied: 40 });
    const s = await state(f);
    expect(Number(s.inv.credit_applied)).toBe(40);
    expect(Number(s.cust.account_credits)).toBe(0);
  });

  test('a fresh in-progress saved-card claim: no credit consumed', async () => {
    const f = await seed();
    await attempt(f, { stale: false, submitted: true });
    const out = await apply(f, { dunningDraw: true });
    expect(out).toMatchObject({ applied: 0, skipped: 'collection_pending' });
    const s = await state(f);
    expect(Number(s.inv.credit_applied)).toBe(0);
    expect(Number(s.cust.account_credits)).toBe(40);
    expect(s.ledger).toHaveLength(0);
  });

  test('a stale SUBMITTED claim: no credit consumed AND its promotion to ambiguous commits (sentinel, not throw)', async () => {
    const f = await seed();
    const id = await attempt(f, { stale: true, submitted: true });
    const out = await apply(f, { dunningDraw: true });
    expect(out).toMatchObject({ applied: 0, skipped: 'collection_pending', pendingCode: 'STRIPE_AMBIGUOUS_OUTCOME' });
    expect((await app('stripe_invoice_charge_attempts').where({ id }).first('status')).status).toBe('ambiguous');
    const s = await state(f);
    expect(Number(s.cust.account_credits)).toBe(40);
  });

  test('an unresolved orphan charge: no credit consumed', async () => {
    const f = await seed();
    await app('stripe_orphan_charges').insert({ invoice_id: f.invoiceId, resolved: false, stripe_payment_intent_id: 'pi_synthetic_orphan' });
    const out = await apply(f, { dunningDraw: true });
    expect(out).toMatchObject({ applied: 0, skipped: 'collection_pending', pendingCode: 'STRIPE_CHARGED_DB_FAILED' });
    expect(Number((await state(f)).cust.account_credits)).toBe(40);
  });

  test('WITHOUT the option the same pending invoice still draws credit (every other caller unchanged)', async () => {
    const f = await seed();
    await attempt(f, { stale: false, submitted: true });
    const out = await apply(f, {});
    expect(out).toMatchObject({ applied: 40 });
  });

  test('the deposit check takes the estimate ledger lock: the draw WAITS for an in-flight receipt (markDepositReceived-shaped: advisory lock only) and then proceeds — no deadlock', async () => {
    const { acquireEstimateDepositLedgerLock } = jest.requireActual('../services/estimate-deposits');
    const estimateId = randomUUID();
    mockDepositReady.mockImplementationOnce(async (trx) => { await acquireEstimateDepositLedgerLock(trx, estimateId); });
    const f = await seed();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const receipt = app.transaction(async (trx) => {
      await acquireEstimateDepositLedgerLock(trx, estimateId); // what markDepositReceived holds while it inserts
      await held;
    });
    await new Promise((r) => setTimeout(r, 300)); // the receipt owns the lock
    let settled = false;
    const draw = apply(f, { dunningDraw: true }).then((out) => { settled = true; return out; });
    await new Promise((r) => setTimeout(r, 600));
    expect(settled).toBe(false); // blocked behind the receipt's ledger lock
    release();
    await receipt;
    expect(await draw).toMatchObject({ applied: 40 });
  });

  describe('eligibility is re-decided under the lock, not taken from the pre-read', () => {
    async function candidate({ sequence = 'active' } = {}) {
      const f = await seed();
      f.serviceId = randomUUID();
      await app('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, payer_id: null });
      await app('invoices').where({ id: f.invoiceId }).update({ scheduled_service_id: f.serviceId });
      if (sequence) await app('invoice_followup_sequences').insert({ id: randomUUID(), invoice_id: f.invoiceId, status: sequence });
      return f; // ...and the resolver's pre-read would have listed it as an active, self-pay candidate
    }

    test('control: an active, self-pay candidate draws, and the payer was re-resolved on the apply\'s own transaction', async () => {
      mockPayerSeen.length = 0;
      const f = await candidate();
      expect(await apply(f, { dunningDraw: true })).toMatchObject({ applied: 40 });
      expect(mockPayerSeen).toEqual([{ isTransaction: true }]);
    });

    test('a payer assigned to the visit AFTER the read: no credit consumed', async () => {
      const f = await candidate();
      await app('scheduled_services').where({ id: f.serviceId }).update({ payer_id: randomUUID() });
      expect(await apply(f, { dunningDraw: true })).toMatchObject({ applied: 0, skipped: 'payer_billed' });
      const s = await state(f);
      expect(Number(s.cust.account_credits)).toBe(40);
      expect(Number(s.inv.credit_applied)).toBe(0);
    });

    test.each(['stopped', 'paused', 'autopay_hold', 'completed'])('the sequence turned %s AFTER the read: no credit consumed', async (status) => {
      const f = await candidate();
      await app('invoice_followup_sequences').where({ invoice_id: f.invoiceId }).update({ status });
      const out = await apply(f, { dunningDraw: true });
      expect(out).toMatchObject({ applied: 0 });
      expect(out.skipped).toMatch(/dunning_/);
      expect(Number((await state(f)).cust.account_credits)).toBe(40);
    });

    test('no sequence row (a quiet member) still draws', async () => {
      const f = await candidate({ sequence: null });
      expect(await apply(f, { dunningDraw: true })).toMatchObject({ applied: 40 });
    });

    test('a PaymentIntent attached AFTER the read (a live pay session): no credit consumed', async () => {
      const f = await candidate();
      await app('invoices').where({ id: f.invoiceId }).update({ stripe_payment_intent_id: 'pi_synthetic_live' });
      expect(await apply(f, { dunningDraw: true })).toMatchObject({ applied: 0, skipped: 'has_payment_intent' });
      expect(Number((await state(f)).cust.account_credits)).toBe(40);
    });

    test('a withdrawal stamp on the locked row: no credit consumed', async () => {
      const f = await candidate();
      await app('invoices').where({ id: f.invoiceId }).update({ scheduled_send_error: 'payer_billed:payer-1' });
      expect(await apply(f, { dunningDraw: true })).toMatchObject({ applied: 0, skipped: 'payer_billed' });
    });

    test('a payer assignment that COMMITS while the draw waits on the visit lock is seen (the re-resolve is under the visit lock)', async () => {
      const f = await candidate();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const assigner = app.transaction(async (trx) => {
        await trx('scheduled_services').where({ id: f.serviceId }).forUpdate().first('id');
        await held;
        await trx('scheduled_services').where({ id: f.serviceId }).update({ payer_id: randomUUID() });
      });
      await new Promise((r) => setTimeout(r, 300));
      let settled = false;
      const draw = apply(f, { dunningDraw: true }).then((o) => { settled = true; return o; });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // waiting on the visit row
      release();
      await assigner;
      expect(await draw).toMatchObject({ applied: 0, skipped: 'payer_billed' });
    });
  });
});
