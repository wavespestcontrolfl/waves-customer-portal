/**
 * releaseStaleAutopayHolds (GATE_AUTOPAY_HOLD_TIMEOUT) on real PostgreSQL: the selection SQL (hold age, no
 * charge attempt and no payment since the hold began), the skips (terminal invoice, active payment plan,
 * payer-billed, other statuses), the release through releaseFromAutopayHold, and the shadow audit rows with
 * their once-per-ET-day dedupe. Disposable schema on a private QA / isolated CI database; skipped without
 * APP_TEST_DATABASE_URL, run for real in CI.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `autopay_hold_timeout_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

const DAY = 86400000;

postgres('releaseStaleAutopayHolds on PostgreSQL', () => {
  let sweep;
  let TIMEOUT_DAYS;
  const savedGate = process.env.GATE_AUTOPAY_HOLD_TIMEOUT;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.raw(`CREATE TABLE invoices (
      id uuid PRIMARY KEY, status text, payer_id uuid, scheduled_send_error text, scheduled_service_id uuid,
      sent_at timestamptz, sms_sent_at timestamptz, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE invoice_followup_sequences (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL, customer_id uuid NOT NULL, status text,
      step_index integer DEFAULT 0, next_touch_at timestamptz, anchor_at timestamptz,
      is_autopay_held boolean DEFAULT false, autopay_failures_observed integer DEFAULT 0,
      updated_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE stripe_invoice_charge_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, status text, next_retry_at timestamptz,
      created_at timestamptz DEFAULT now())`);
    await mockPg.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY, status text)');
    await mockPg.raw('CREATE TABLE payment_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, status text)');
    await mockPg.raw(`CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text NOT NULL, actor_id uuid, action text NOT NULL,
      resource_type text, resource_id uuid, metadata jsonb, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now())`);
    ({ releaseStaleAutopayHolds: sweep, AUTOPAY_HOLD_TIMEOUT_DAYS: TIMEOUT_DAYS } = require('../services/invoice-followups'));
  });

  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
    else process.env.GATE_AUTOPAY_HOLD_TIMEOUT = savedGate;
    if (mockPg) await mockPg.destroy();
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (admin) await admin.destroy();
  });

  beforeEach(async () => {
    await mockPg.raw('TRUNCATE invoices, invoice_followup_sequences, stripe_invoice_charge_attempts, payments, payment_plans, scheduled_services, audit_log');
    delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
  });

  // One held sequence. heldDaysAgo stamps updated_at, the hold start.
  async function held({ heldDaysAgo = 4, invoiceStatus = 'sent', status = 'autopay_hold', payerId = null, visitStatus = null, sequenceId = randomUUID() } = {}) {
    const invoiceId = randomUUID();
    const customerId = randomUUID();
    const heldAt = new Date(Date.now() - heldDaysAgo * DAY);
    let visitId = null;
    if (visitStatus) {
      visitId = randomUUID();
      await mockPg('scheduled_services').insert({ id: visitId, status: visitStatus });
    }
    await mockPg('invoices').insert({ id: invoiceId, status: invoiceStatus, payer_id: payerId, scheduled_service_id: visitId, sent_at: new Date(Date.now() - 20 * DAY) });
    await mockPg('invoice_followup_sequences').insert({
      id: sequenceId,
      invoice_id: invoiceId,
      customer_id: customerId,
      status,
      is_autopay_held: status === 'autopay_hold',
      next_touch_at: null,
      anchor_at: new Date(Date.now() - 20 * DAY),
      updated_at: heldAt,
    });
    return { invoiceId, customerId, sequenceId, heldAt };
  }
  const seqOf = (invoiceId) => mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  const shadowRows = () => mockPg('audit_log').where({ action: 'invoice_followup.autopay_hold_timeout_shadow' });
  const untouched = async (h) => {
    const seq = await seqOf(h.invoiceId);
    expect(seq.status).toBe('autopay_hold');
    expect(seq.next_touch_at).toBeNull();
    expect(new Date(seq.updated_at).getTime()).toBe(h.heldAt.getTime());
  };

  test('the timeout is 3 days', () => {
    expect(TIMEOUT_DAYS).toBe(3);
  });

  describe('gate true', () => {
    beforeEach(() => { process.env.GATE_AUTOPAY_HOLD_TIMEOUT = 'true'; });

    test('held 4 days with no attempt and no payment is released to active with a next touch', async () => {
      const h = await held();
      const result = await sweep();
      expect(result).toMatchObject({ mode: 'true', candidates: 1, released: 1 });
      const seq = await seqOf(h.invoiceId);
      expect(seq.status).toBe('active');
      expect(seq.is_autopay_held).toBe(false);
      expect(seq.next_touch_at).not.toBeNull();
      expect(await shadowRows()).toHaveLength(0);
    });

    test('held 2 days is left alone', async () => {
      const h = await held({ heldDaysAgo: 2 });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test('a charge attempt since the hold began keeps the hold', async () => {
      const h = await held();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, created_at: new Date(Date.now() - 1 * DAY) });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      await untouched(h);
    });

    test('a charge attempt from before the hold began does not keep it', async () => {
      const h = await held();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, created_at: new Date(Date.now() - 9 * DAY) });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
    });

    test.each(['paid', 'failed', 'processing', 'upcoming'])('a %s payment for the customer since the hold began keeps the hold', async (status) => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: h.customerId, status, created_at: new Date(Date.now() - 1 * DAY) });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      await untouched(h);
    });

    test('a failed payment still on the Auto Pay retry ladder keeps the hold, even from before the hold', async () => {
      const h = await held();
      await mockPg('payments').insert({
        customer_id: h.customerId, status: 'failed', created_at: new Date(Date.now() - 9 * DAY), next_retry_at: new Date(Date.now() + 1 * DAY),
      });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test('a failed payment whose retries ended does not keep the hold', async () => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: h.customerId, status: 'failed', created_at: new Date(Date.now() - 9 * DAY), next_retry_at: null });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    test('rows the skips pass over on one page never hide an eligible row on a later page', async () => {
      const skipped = [];
      for (const n of [1, 2, 3]) {
        skipped.push(await held({ visitStatus: 'confirmed', sequenceId: `00000000-0000-4000-8000-00000000000${n}` }));
      }
      const last = await held({ sequenceId: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      expect(await sweep({ pageSize: 2 })).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(last.invoiceId)).status).toBe('active');
      for (const h of skipped) await untouched(h);
    });

    test('a page that ends exactly on the page size still reads the next page', async () => {
      const a = await held({ sequenceId: '00000000-0000-4000-8000-000000000001' });
      const b = await held({ sequenceId: '00000000-0000-4000-8000-000000000002' });
      expect(await sweep({ pageSize: 2 })).toMatchObject({ candidates: 2, released: 2 });
      expect((await seqOf(a.invoiceId)).status).toBe('active');
      expect((await seqOf(b.invoiceId)).status).toBe('active');
    });

    test('another customer\'s payment and another invoice\'s attempt do not keep the hold', async () => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: randomUUID(), status: 'paid', created_at: new Date() });
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: randomUUID(), created_at: new Date() });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    test.each(['paid', 'void', 'prepaid', 'refunded', 'draft'])('a %s invoice is left alone', async (invoiceStatus) => {
      const h = await held({ invoiceStatus });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test('a payer-billed invoice is left alone', async () => {
      const h = await held({ payerId: randomUUID() });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      await untouched(h);
    });

    test('an active payment plan keeps the hold; a completed plan does not', async () => {
      const a = await held();
      const b = await held();
      await mockPg('payment_plans').insert({ invoice_id: a.invoiceId, status: 'active' });
      await mockPg('payment_plans').insert({ invoice_id: b.invoiceId, status: 'completed' });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      await untouched(a);
      expect((await seqOf(b.invoiceId)).status).toBe('active');
    });

    test('a sequence in any other status is left alone', async () => {
      const rows = [];
      for (const status of ['active', 'paused', 'stopped', 'completed']) rows.push(await held({ status }));
      expect(await sweep()).toMatchObject({ candidates: 0 });
      for (const [i, status] of ['active', 'paused', 'stopped', 'completed'].entries()) {
        expect((await seqOf(rows[i].invoiceId)).status).toBe(status);
      }
    });

    test.each(['pending', 'confirmed', 'en_route', 'on_site'])('an invoice whose linked visit is still %s is left alone', async (visitStatus) => {
      const h = await held({ visitStatus });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test.each(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'])('an invoice whose linked visit is %s is released', async (visitStatus) => {
      const h = await held({ visitStatus });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    test('an invoice with no linked visit is released', async () => {
      const h = await held();
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    test('an Auto Pay failure counter bump (updated_at now) restarts the clock', async () => {
      const h = await held();
      await mockPg('invoice_followup_sequences').where({ id: h.sequenceId }).update({ updated_at: new Date(), autopay_failures_observed: 1 });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      expect((await seqOf(h.invoiceId)).status).toBe('autopay_hold');
    });

    test('a second run releases nothing more', async () => {
      await held();
      await sweep();
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
    });
  });

  describe('gate shadow', () => {
    beforeEach(() => { process.env.GATE_AUTOPAY_HOLD_TIMEOUT = 'shadow'; });

    test('records one audit row per would-release invoice and writes nothing to the sequence', async () => {
      const h = await held({ heldDaysAgo: 4 });
      await held({ heldDaysAgo: 1 });
      const result = await sweep();
      expect(result).toMatchObject({ mode: 'shadow', candidates: 1, released: 0, recorded: 1 });
      await untouched(h);
      const rows = await shadowRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: 'system', resource_type: 'invoice', resource_id: h.invoiceId });
      expect(rows[0].metadata).toMatchObject({ sequence_id: h.sequenceId, days_held: 4 });
      expect(new Date(rows[0].metadata.held_since).getTime()).toBe(h.heldAt.getTime());
    });

    test('two runs on the same ET day record the invoice once', async () => {
      await held();
      const now = new Date();
      await sweep({ now });
      const second = await sweep({ now });
      expect(second).toMatchObject({ candidates: 1, recorded: 0 });
      expect(await shadowRows()).toHaveLength(1);
    });

    test('a run the next ET day records it again', async () => {
      await held();
      const now = new Date();
      await sweep({ now });
      await sweep({ now: new Date(now.getTime() + 24 * 3600000) });
      expect(await shadowRows()).toHaveLength(2);
    });
  });

  describe('gate off', () => {
    test.each([undefined, '', 'false', 'on', '1'])('GATE_AUTOPAY_HOLD_TIMEOUT=%p changes nothing', async (value) => {
      if (value !== undefined) process.env.GATE_AUTOPAY_HOLD_TIMEOUT = value;
      const h = await held();
      expect(await sweep()).toMatchObject({ mode: 'off', candidates: 0 });
      await untouched(h);
      expect(await shadowRows()).toHaveLength(0);
    });
  });
});
