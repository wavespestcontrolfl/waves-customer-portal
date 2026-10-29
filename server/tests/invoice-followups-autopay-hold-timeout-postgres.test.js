/**
 * releaseStaleAutopayHolds (GATE_AUTOPAY_HOLD_TIMEOUT) on real PostgreSQL: the selection SQL (hold age, no
 * charge attempt and no Auto Pay payment since the hold began; a cash/check/Zelle tender a person recorded does
 * not count), the skips (open customer-level schedule, terminal invoice, active payment plan, payer-billed,
 * other statuses), the release (first touch no earlier than the next send-window run, one office alert per
 * released invoice), and the shadow audit rows with their once-per-ET-day dedupe. Disposable schema on a private QA / isolated CI database; skipped without
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
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

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
      invoice_number text, total numeric, credit_applied numeric DEFAULT 0, amount_paid numeric NOT NULL DEFAULT 0, sent_at timestamptz, sms_sent_at timestamptz, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE invoice_followup_sequences (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL, customer_id uuid NOT NULL, status text,
      step_index integer DEFAULT 0, next_touch_at timestamptz, anchor_at timestamptz,
      is_autopay_held boolean DEFAULT false, autopay_failures_observed integer DEFAULT 0,
      updated_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE stripe_invoice_charge_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, status text, next_retry_at timestamptz,
      description text, processor text, stripe_charge_id text, stripe_payment_intent_id text, created_at timestamptz DEFAULT now())`);
    await mockPg.raw('CREATE TABLE customers (id uuid PRIMARY KEY, first_name text, last_name text)');
    await mockPg.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY, status text)');
    await mockPg.raw('CREATE TABLE customer_dunning_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, status text)');
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
    await mockPg.raw('TRUNCATE customers, invoices, invoice_followup_sequences, stripe_invoice_charge_attempts, payments, payment_plans, scheduled_services, customer_dunning_schedules, audit_log');
    delete process.env.GATE_AUTOPAY_HOLD_TIMEOUT;
    mockNotify.mockClear();
  });

  // One held sequence. heldDaysAgo stamps updated_at, the hold start; anchorDaysAgo the invoice's send day,
  // both counted back from `at` (a test that pins the sweep's clock pins these too). A second invoice for the
  // same customer passes its customerId.
  async function held({
    heldDaysAgo = 4, anchorDaysAgo = 20, at = new Date(), invoiceStatus = 'sent', status = 'autopay_hold', payerId = null,
    visitStatus = null, sequenceId = randomUUID(), customerId = randomUUID(), total = 120,
  } = {}) {
    const invoiceId = randomUUID();
    const heldAt = new Date(at.getTime() - heldDaysAgo * DAY);
    const sentAt = new Date(at.getTime() - anchorDaysAgo * DAY);
    await mockPg('customers').insert({ id: customerId, first_name: 'Casey', last_name: 'Testwell' }).onConflict('id').ignore();
    let visitId = null;
    if (visitStatus) {
      visitId = randomUUID();
      await mockPg('scheduled_services').insert({ id: visitId, status: visitStatus });
    }
    await mockPg('invoices').insert({
      id: invoiceId, status: invoiceStatus, payer_id: payerId, scheduled_service_id: visitId, sent_at: sentAt, invoice_number: `WPC-${invoiceId.slice(0, 4)}`, total,
    });
    await mockPg('invoice_followup_sequences').insert({
      id: sequenceId,
      invoice_id: invoiceId,
      customer_id: customerId,
      status,
      is_autopay_held: status === 'autopay_hold',
      next_touch_at: null,
      anchor_at: sentAt,
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

    describe('the first reminder never goes out in the release run', () => {
      // Tue 2026-10-27 10:16 ET and Fri 2026-10-30 10:16 ET: the job's own run times.
      const TUESDAY = new Date('2026-10-27T14:16:00Z');
      const FRIDAY = new Date('2026-10-30T14:16:00Z');

      test('a step already due is dated at the next send-window run (Tuesday release: Wednesday 10 AM)', async () => {
        // sent 3 days before: the 3-day step falls today at 10 AM, 16 minutes ago, inside the stale grace.
        const h = await held({ at: TUESDAY, anchorDaysAgo: 3 });
        expect(await sweep({ now: TUESDAY })).toMatchObject({ released: 1 });
        const seq = await seqOf(h.invoiceId);
        expect(seq).toMatchObject({ status: 'active', step_index: 0 });
        expect(new Date(seq.next_touch_at).toISOString()).toBe('2026-10-28T14:00:00.000Z');
      });

      test('a Friday release waits for Tuesday, the next send-window day', async () => {
        const h = await held({ at: FRIDAY, anchorDaysAgo: 3 });
        expect(await sweep({ now: FRIDAY })).toMatchObject({ released: 1 });
        expect(new Date((await seqOf(h.invoiceId)).next_touch_at).toISOString()).toBe('2026-11-03T15:00:00.000Z');
      });

      test('steps whose day passed are walked over, never sent late; the first live step keeps its own date', async () => {
        const h = await held({ at: TUESDAY, anchorDaysAgo: 20 });
        await sweep({ now: TUESDAY });
        const seq = await seqOf(h.invoiceId);
        expect(seq.step_index).toBeGreaterThan(0);
        expect(new Date(seq.next_touch_at).getTime()).toBeGreaterThan(TUESDAY.getTime() + DAY);
      });
    });

    describe('the office alert', () => {
      const TUESDAY = new Date('2026-10-27T14:16:00Z');

      test('one alert per released invoice, naming first name and last initial, the invoice and the start day; none on a re-run', async () => {
        const a = await held({ at: TUESDAY, anchorDaysAgo: 3, total: 120 });
        const b = await held({ at: TUESDAY, anchorDaysAgo: 3, total: 1250.5 });
        await sweep({ now: TUESDAY });
        await sweep({ now: new Date(TUESDAY.getTime() + 1000) });
        expect(mockNotify).toHaveBeenCalledTimes(2);
        const calls = mockNotify.mock.calls.map(([category, title, body, opts]) => ({ category, title, body, opts }));
        const first = calls.find((c) => c.opts.metadata.invoice_id === a.invoiceId);
        expect(first.category).toBe('alert');
        expect(first.title).toBe('Billing — charge the card on file for Casey T.');
        expect(first.body).toBe(`Auto Pay did not charge invoice WPC-${a.invoiceId.slice(0, 4)} ($120.00); reminders start Wed, Oct 28.`);
        expect(first.opts.dedupeKey).toMatch(new RegExp(`^autopay-hold-timeout:${a.invoiceId}:`));
        expect(first.opts.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', who: 'person', customer_id: a.customerId });
        expect(calls.find((c) => c.opts.metadata.invoice_id === b.invoiceId).body).toContain('($1250.50)');
        expect(calls[0].opts.dedupeKey).not.toBe(calls[1].opts.dedupeKey);
      });

      test('an invoice with every step passed says so instead of promising reminders', async () => {
        const h = await held({ at: TUESDAY, anchorDaysAgo: 200 });
        await sweep({ now: TUESDAY });
        expect((await seqOf(h.invoiceId)).status).toBe('active');
        expect(mockNotify.mock.calls[0][2]).toContain('no reminder steps are left to send');
        expect(mockNotify.mock.calls[0][3].metadata.invoice_id).toBe(h.invoiceId);
      });

      test('a hold that is kept raises nothing', async () => {
        const h = await held({ heldDaysAgo: 2 });
        const skipped = await held();
        await mockPg('customer_dunning_schedules').insert({ customer_id: skipped.customerId, status: 'active' });
        await sweep();
        expect(mockNotify).not.toHaveBeenCalled();
        await untouched(h);
      });

      test('shadow mode writes no alert and releases nothing', async () => {
        process.env.GATE_AUTOPAY_HOLD_TIMEOUT = 'shadow';
        const h = await held();
        await sweep();
        expect(mockNotify).not.toHaveBeenCalled();
        await untouched(h);
      });
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

    test('a charge attempt from before the hold began keeps it too: Auto Pay acted on this invoice', async () => {
      const h = await held();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, created_at: new Date(Date.now() - 90 * DAY) });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test.each(['active', 'held', 'paused', 'autopay_hold'])('a customer on an open (%s) customer-level schedule is left to that engine', async (scheduleStatus) => {
      const h = await held();
      await mockPg('customer_dunning_schedules').insert({ customer_id: h.customerId, status: scheduleStatus });
      expect(await sweep()).toMatchObject({ candidates: 0, released: 0 });
      await untouched(h);
    });

    test.each(['completed', 'released'])('a customer whose customer-level schedule is %s is released', async (scheduleStatus) => {
      const h = await held();
      await mockPg('customer_dunning_schedules').insert({ customer_id: h.customerId, status: scheduleStatus });
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    test('a customer the live engine covers (gate on, no allowlist) but who has no open schedule is released', async () => {
      const FeatureGates = require('../config/feature-gates');
      const live = jest.spyOn(FeatureGates, 'dunningCustomerScheduleLive').mockReturnValue(true);
      const allow = jest.spyOn(FeatureGates, 'dunningCustomerScheduleAllowlist').mockReturnValue(null);
      const owned = await held();
      const free = await held();
      await mockPg('customer_dunning_schedules').insert({ customer_id: owned.customerId, status: 'autopay_hold' });
      try {
        expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      } finally {
        live.mockRestore();
        allow.mockRestore();
      }
      await untouched(owned);
      expect((await seqOf(free.invoiceId)).status).toBe('active');
    });

    test.each(['paid', 'failed', 'processing', 'upcoming'])('a %s Auto Pay payment for the customer since the hold began keeps the hold', async (status) => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: h.customerId, status, processor: 'stripe', created_at: new Date(Date.now() - 1 * DAY) });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      await untouched(h);
    });

    test.each([
      ['a paid row with only a Stripe charge id', { status: 'paid', stripe_charge_id: 'ch_test_1' }],
      ['a paid row with only a Stripe PaymentIntent id', { status: 'paid', stripe_payment_intent_id: 'pi_test_1' }],
      ['an off-gateway row that is not paid (billing-cron deferred monthly charge)', { status: 'failed' }],
    ])('%s keeps the hold', async (_name, fields) => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: h.customerId, created_at: new Date(Date.now() - 1 * DAY), ...fields });
      expect(await sweep()).toMatchObject({ candidates: 0 });
      await untouched(h);
    });

    // recordManualPayment writes status 'paid' with no processor, charge or PaymentIntent (cash, check, zelle,
    // venmo, paypal, other): a person took the money, so Auto Pay did not act and the hold must not freeze.
    test.each(['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'])('a %s tender the office recorded since the hold began does not keep the hold', async (method) => {
      const h = await held();
      const other = await held({ customerId: h.customerId });
      await mockPg('payments').insert({ customer_id: h.customerId, status: 'paid', created_at: new Date(Date.now() - 1 * DAY), description: `Invoice WPC-0001 — ${method}` });
      expect(await sweep()).toMatchObject({ candidates: 2, released: 2 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
      expect((await seqOf(other.invoiceId)).status).toBe('active');
    });

    test('a manual tender does not hide an Auto Pay charge recorded beside it', async () => {
      const h = await held();
      await mockPg('payments').insert({ customer_id: h.customerId, status: 'paid', created_at: new Date(Date.now() - 2 * DAY) });
      await mockPg('payments').insert({ customer_id: h.customerId, status: 'paid', processor: 'stripe', created_at: new Date(Date.now() - 1 * DAY) });
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

    test('a hold stamped to the microsecond is released (the stamp is compared as text, not a JS Date)', async () => {
      const h = await held();
      await mockPg.raw("UPDATE invoice_followup_sequences SET updated_at = now() - interval '4 days' + interval '123 microseconds' WHERE id = ?", [h.sequenceId]);
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
    });

    describe('the release re-checks the rule at the write', () => {
      let releaseOne;
      beforeAll(() => { ({ releaseStaleAutopayHold: releaseOne } = require('../services/invoice-followups')._test); });
      const observed = (h) => mockPg('invoice_followup_sequences as s').where('s.id', h.sequenceId)
        .first('s.id', 's.invoice_id', 's.customer_id', 's.updated_at', mockPg.raw('s.updated_at::text as hold_stamp'));
      const cutoffNow = () => new Date(Date.now() - TIMEOUT_DAYS * DAY);

      test('an unchanged hold is released', async () => {
        const h = await held();
        expect(await releaseOne(await observed(h), cutoffNow())).toBe(true);
        expect((await seqOf(h.invoiceId)).status).toBe('active');
      });

      test('an Auto Pay failure bump after the read keeps the hold', async () => {
        const h = await held();
        const row = await observed(h);
        await mockPg('invoice_followup_sequences').where({ id: h.sequenceId }).update({ updated_at: mockPg.fn.now(), autopay_failures_observed: 1 });
        expect(await releaseOne(row, cutoffNow())).toBe(false);
        expect((await seqOf(h.invoiceId)).status).toBe('autopay_hold');
      });

      test('any other write to the hold after the read keeps it, even one that leaves it old', async () => {
        const h = await held();
        const row = await observed(h);
        await mockPg('invoice_followup_sequences').where({ id: h.sequenceId }).update({ updated_at: new Date(h.heldAt.getTime() - 3600000) });
        expect(await releaseOne(row, cutoffNow())).toBe(false);
        expect((await seqOf(h.invoiceId)).status).toBe('autopay_hold');
      });

      test('a retry armed after the read keeps the hold', async () => {
        const h = await held();
        const row = await observed(h);
        await mockPg('payments').insert({
          customer_id: h.customerId, status: 'failed', created_at: new Date(Date.now() - 9 * DAY), next_retry_at: new Date(Date.now() + DAY),
        });
        expect(await releaseOne(row, cutoffNow())).toBe(false);
        await untouched(h);
      });

      test('a charge attempt, payment plan or customer schedule after the read keeps the hold', async () => {
        const a = await held();
        const b = await held();
        const c = await held();
        const rows = [await observed(a), await observed(b), await observed(c)];
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: a.invoiceId });
        await mockPg('payment_plans').insert({ invoice_id: b.invoiceId, status: 'active' });
        await mockPg('customer_dunning_schedules').insert({ customer_id: c.customerId, status: 'active' });
        for (const row of rows) expect(await releaseOne(row, cutoffNow())).toBe(false);
        for (const h of [a, b, c]) await untouched(h);
      });

      test('a combined schedule promoted after the read keeps the hold and raises no alert', async () => {
        const h = await held();
        const row = await observed(h);
        await mockPg('customer_dunning_schedules').insert({ customer_id: h.customerId, status: 'active' });
        expect(await releaseOne(row, cutoffNow())).toBe(false);
        await untouched(h);
        expect(mockNotify).not.toHaveBeenCalled();
      });

      test('an invoice paid after the read is not released', async () => {
        const h = await held();
        const row = await observed(h);
        await mockPg('invoices').where({ id: h.invoiceId }).update({ status: 'paid' });
        expect(await releaseOne(row, cutoffNow())).toBe(false);
        await untouched(h);
      });
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
