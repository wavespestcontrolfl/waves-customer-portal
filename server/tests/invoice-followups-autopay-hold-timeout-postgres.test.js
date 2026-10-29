/**
 * releaseStaleAutopayHolds (GATE_AUTOPAY_HOLD_TIMEOUT) on real PostgreSQL: the selection SQL (hold age, no
 * charge attempt and no payment since the hold began), the skips (terminal invoice, active payment plan,
 * payer-billed, other statuses), the release through releaseFromAutopayHold, and the shadow audit rows with
 * their once-per-ET-day dedupe, and the 'charge' mode (a stale hold charges the saved Auto Pay method first;
 * a decline releases it, an unclear outcome keeps it; the Stripe, method and bell calls are spies).
 * Disposable schema on a private QA / isolated CI database; skipped without
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
jest.mock('../services/customer-dunning/wiring', () => ({ liveForCustomer: jest.fn(() => false) }));

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
      id uuid PRIMARY KEY, status text, invoice_number text, payer_id uuid, scheduled_send_error text, scheduled_service_id uuid,
      sent_at timestamptz, sms_sent_at timestamptz, created_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE invoice_followup_sequences (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL, customer_id uuid NOT NULL, status text,
      step_index integer DEFAULT 0, next_touch_at timestamptz, anchor_at timestamptz,
      is_autopay_held boolean DEFAULT false, autopay_failures_observed integer DEFAULT 0,
      updated_at timestamptz DEFAULT now())`);
    await mockPg.raw(`CREATE TABLE stripe_invoice_charge_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, status text, decline_code text, created_at timestamptz DEFAULT now())`);
    await mockPg.raw('CREATE TABLE customers (id uuid PRIMARY KEY, first_name text, last_name text)');
    await mockPg.raw(`CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, status text, next_retry_at timestamptz,
      created_at timestamptz DEFAULT now())`);
    await mockPg.raw('CREATE TABLE scheduled_services (id uuid PRIMARY KEY, status text)');
    await mockPg.raw('CREATE TABLE customer_dunning_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, status text)');
    await mockPg.raw('CREATE TABLE payment_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL, status text)');
    await mockPg.raw(`CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text NOT NULL, actor_id uuid, action text NOT NULL,
      resource_type text, resource_id uuid, metadata jsonb, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now())`);
    // Lets a test make the release UPDATE fail while a row sits in fail_release: insert the row, run, delete it.
    await mockPg.raw('CREATE TABLE fail_release (id int)');
    await mockPg.raw(`CREATE FUNCTION fail_release_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'active' AND EXISTS (SELECT 1 FROM fail_release) THEN RAISE EXCEPTION 'release failed (test)'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await mockPg.raw('CREATE TRIGGER fail_release_trg BEFORE UPDATE ON invoice_followup_sequences FOR EACH ROW EXECUTE FUNCTION fail_release_fn()');
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
    await mockPg.raw('TRUNCATE customers, invoices, invoice_followup_sequences, stripe_invoice_charge_attempts, payments, payment_plans, scheduled_services, customer_dunning_schedules, audit_log, fail_release');
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
    await mockPg('invoices').insert({ id: invoiceId, status: invoiceStatus, invoice_number: 'WPC-TEST-1', payer_id: payerId, scheduled_service_id: visitId, sent_at: new Date(Date.now() - 20 * DAY) });
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
    return { invoiceId, customerId, sequenceId, heldAt, visitId };
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

    test('a customer the live customer-level engine covers is left to it; one it does not cover is released', async () => {
      const FeatureGates = require('../config/feature-gates');
      const { liveForCustomer } = require('../services/customer-dunning/wiring');
      const covered = await held();
      const other = await held();
      const live = jest.spyOn(FeatureGates, 'dunningCustomerScheduleLive').mockReturnValue(true);
      liveForCustomer.mockImplementation((customerId) => customerId === covered.customerId);
      try {
        expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      } finally {
        live.mockRestore();
        liveForCustomer.mockImplementation(() => false);
      }
      await untouched(covered);
      expect((await seqOf(other.invoiceId)).status).toBe('active');
    });

    test('with the customer-level engine off, its coverage check is never asked', async () => {
      const { liveForCustomer } = require('../services/customer-dunning/wiring');
      liveForCustomer.mockClear();
      await held();
      expect(await sweep()).toMatchObject({ candidates: 1, released: 1 });
      expect(liveForCustomer).not.toHaveBeenCalled();
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

  describe('gate charge', () => {
    const StripeService = require('../services/stripe');
    const Eligibility = require('../services/autopay-eligibility');
    const NotificationService = require('../services/notification-service');
    const chargeAuditRows = () => mockPg('audit_log').where({ action: 'invoice_followup.autopay_hold_timeout_charge' });
    const METHOD = { id: 'pm-1', method_type: 'card' };
    let quote;
    let chargeCall;
    let notify;

    beforeEach(() => {
      process.env.GATE_AUTOPAY_HOLD_TIMEOUT = 'charge';
      jest.spyOn(Eligibility, 'getChargeableAutopayMethod').mockResolvedValue(METHOD);
      quote = jest.spyOn(StripeService, 'quoteInvoiceSavedCardCharge').mockResolvedValue({ base: 100, surcharge: 3.09, total: 103.09 });
      chargeCall = jest.spyOn(StripeService, 'chargeInvoiceWithSavedCard').mockResolvedValue({ status: 'paid', amount: 103.09 });
      notify = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'bell-1' });
    });
    afterEach(() => {
      // Restore each spy by hand: restoreAllMocks would also reset the jest.fn() mocks above.
      for (const spy of [Eligibility.getChargeableAutopayMethod, quote, chargeCall, notify]) spy.mockRestore();
    });

    // What the real charge path leaves behind on a decline: its attempt claim (failed) and a failed payments row.
    const leaveDeclineRows = async (h) => {
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'failed' });
      await mockPg('payments').insert({ customer_id: h.customerId, status: 'failed', next_retry_at: null });
    };
    const decline = (declineCode = 'insufficient_funds') => Object.assign(new Error('Your card was declined.'), {
      wavesCardDecline: { attemptedAmount: 103.09, declineCode },
    });

    test('charge success: the hold is kept, the sequence is closed, one audit row, no alert, and the sweep does not pick it again', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'succeeded' });
        await mockPg('invoices').where({ id: h.invoiceId }).update({ status: 'paid' });
        return { status: 'paid', amount: 103.09 };
      });
      const result = await sweep();
      expect(result).toMatchObject({ mode: 'charge', candidates: 1, charged: 1, declined_released: 0, ambiguous: 0, released: 0 });
      const seq = await seqOf(h.invoiceId);
      expect(seq.status).toBe('completed');
      expect(seq.next_touch_at).toBeNull();
      const rows = await chargeAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_type: 'system', resource_type: 'invoice', resource_id: h.invoiceId });
      expect(rows[0].metadata).toEqual({
        sequence_id: h.sequenceId, customer_id: h.customerId, outcome: 'paid', reason: null, error_code: null,
        amount_cents: 10309, method_type: 'card', released: false,
      });
      expect(notify).not.toHaveBeenCalled();
      expect(await sweep()).toMatchObject({ candidates: 0, charged: 0 });
      expect(chargeCall).toHaveBeenCalledTimes(1);
    });

    test('quotes the method, then charges it with the surcharge-inclusive quote total and the Auto Pay guards', async () => {
      const h = await held();
      await sweep();
      expect(Eligibility.getChargeableAutopayMethod).toHaveBeenCalledWith({ id: h.customerId }, expect.anything(), { rethrow: true });
      expect(quote).toHaveBeenCalledWith(h.invoiceId, 'pm-1');
      expect(chargeCall).toHaveBeenCalledTimes(1);
      // toEqual on the whole options object: no operatorOverride, no other guard slips in. An unbound
      // invoice must still be unbound under the charge transaction's lock.
      expect(chargeCall.mock.calls[0]).toEqual([h.invoiceId, 'pm-1', {
        expectedTotal: 103.09,
        maxAuthorizedTotalCents: 10309,
        requireAutopayForCustomerId: h.customerId,
        refuseWhenDunningStopped: true,
        requireUnboundInvoice: true,
        requireSelfPayCustomerId: h.customerId,
      }]);
    });

    test('an unbound invoice whose customer gained a default payer after the read: the payer refusal means no charge, the refused path', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await leaveDeclineRows(h);
        throw Object.assign(new Error('This bill routes to a third-party payer. The saved card must not be charged.'), { code: 'PAYER_BILLED_GUARD' });
      });
      expect(await sweep()).toMatchObject({ candidates: 1, charged: 0, ambiguous: 0, declined_released: 1 });
      expect(chargeCall).toHaveBeenCalledTimes(1);
      expect(chargeCall.mock.calls[0][2]).toMatchObject({ requireUnboundInvoice: true, requireSelfPayCustomerId: h.customerId });
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_released', reason: 'refused', error_code: 'PAYER_BILLED_GUARD' });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    test('an invoice bound to a closed visit is charged with the visit guards: visit completed, invoice still bound to it', async () => {
      const h = await held({ visitStatus: 'completed' });
      expect(await sweep()).toMatchObject({ candidates: 1, charged: 1 });
      expect(chargeCall.mock.calls[0]).toEqual([h.invoiceId, 'pm-1', {
        expectedTotal: 103.09,
        maxAuthorizedTotalCents: 10309,
        requireAutopayForCustomerId: h.customerId,
        refuseWhenDunningStopped: true,
        requireSelfPayScheduledServiceId: h.visitId,
        requireCompletedVisit: true,
        requireInvoiceScheduledServiceBinding: true,
      }]);
    });

    test('a linked visit reopened during the quote: the charge path refuses, the hold is kept, one alert, no release', async () => {
      const h = await held({ visitStatus: 'completed' });
      quote.mockImplementation(async () => {
        await mockPg('scheduled_services').where({ id: h.visitId }).update({ status: 'confirmed' });
        return { base: 100, surcharge: 3.09, total: 103.09 };
      });
      chargeCall.mockImplementation(async () => {
        throw Object.assign(new Error('The visit is no longer completed. Review before charging.'), { code: 'VISIT_NOT_COMPLETED' });
      });
      expect(await sweep()).toMatchObject({ candidates: 1, release_failed: 1, declined_released: 0, ambiguous: 0, charged: 0 });
      await untouched(h);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][3].dedupeKey).toBe(`autopay_hold_charge:declined:${h.invoiceId}`);
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_not_released', reason: 'refused', error_code: 'VISIT_NOT_COMPLETED', released: false });
    });

    test('a bank charge that is processing keeps the hold open for the webhook and writes one audit row', async () => {
      const h = await held();
      Eligibility.getChargeableAutopayMethod.mockResolvedValue({ id: 'pm-bank', method_type: 'us_bank_account' });
      quote.mockResolvedValue({ base: 100, surcharge: 0, total: 100 });
      chargeCall.mockImplementation(async () => {
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'claimed' });
        return { status: 'processing', amount: 100 };
      });
      expect(await sweep()).toMatchObject({ charged: 1, declined_released: 0 });
      expect((await seqOf(h.invoiceId)).status).toBe('autopay_hold');
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'processing', amount_cents: 10000, method_type: 'us_bank_account', released: false });
      expect(notify).not.toHaveBeenCalled();
    });

    test('an invoice the account credit covered closes the sequence and records a zero charge', async () => {
      const h = await held();
      quote.mockResolvedValue({ base: 0, surcharge: 0, total: 0, coveredByCredit: true });
      chargeCall.mockResolvedValue({ covered_by_credit: true, status: 'prepaid', paymentId: null, paymentIntentId: null });
      expect(await sweep()).toMatchObject({ charged: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('completed');
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'covered_by_credit', amount_cents: 0 });
      expect(chargeCall.mock.calls[0][2]).toMatchObject({ expectedTotal: 0, maxAuthorizedTotalCents: 0 });
    });

    test('a decline releases the hold even though the charge left an attempt and a failed payment, and posts one alert', async () => {
      const h = await held();
      await mockPg('customers').insert({ id: h.customerId, first_name: 'Test', last_name: 'Customer' });
      chargeCall.mockImplementation(async () => { await leaveDeclineRows(h); throw decline(); });
      const result = await sweep();
      expect(result).toMatchObject({ mode: 'charge', candidates: 1, charged: 0, declined_released: 1, released: 1, ambiguous: 0 });
      const seq = await seqOf(h.invoiceId);
      expect(seq.status).toBe('active');
      expect(seq.is_autopay_held).toBe(false);
      expect(seq.next_touch_at).not.toBeNull();

      expect(notify).toHaveBeenCalledTimes(1);
      const [category, headline, why, opts] = notify.mock.calls[0];
      expect(category).toBe('billing');
      expect(headline).toBe("Billing — check Test Customer's failed Auto Pay charge");
      expect(why).toBe('$103.09 on invoice WPC-TEST-1 was not charged (the card was declined); reminders start.');
      expect(opts).toMatchObject({
        bell: true, dedupeKey: `autopay_hold_charge:declined:${h.invoiceId}`, link: `/admin/invoices?invoice=${h.invoiceId}`,
        metadata: { subject: { type: 'invoice', id: h.invoiceId }, severity: 'needs-you', reason: 'declined' },
      });

      const [row] = await chargeAuditRows();
      expect(row.metadata).toEqual({
        sequence_id: h.sequenceId, customer_id: h.customerId, outcome: 'declined_released', reason: 'declined', error_code: null,
        amount_cents: 10309, method_type: 'card', released: true,
      });
      expect(await chargeAuditRows()).toHaveLength(1);
    });

    test('no chargeable method releases the hold and posts one alert, with no quote and no charge', async () => {
      const h = await held();
      Eligibility.getChargeableAutopayMethod.mockResolvedValue(null);
      expect(await sweep()).toMatchObject({ candidates: 1, declined_released: 1, released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
      expect(quote).not.toHaveBeenCalled();
      expect(chargeCall).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][2]).toContain('no Auto Pay card or bank is on file');
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_released', reason: 'no_method', method_type: null, released: true });
    });

    test('a guard refusal before any charge (plain error, no attempt row) releases the hold and posts one alert', async () => {
      const h = await held();
      chargeCall.mockRejectedValue(new Error('Auto Pay is no longer active for this customer.'));
      expect(await sweep()).toMatchObject({ declined_released: 1, ambiguous: 0 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][2]).toContain('Auto Pay refused the charge');
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_released', reason: 'refused' });
    });

    test('a method lookup that throws is not "no method": hold kept, skipped, no quote, charge, alert or audit row', async () => {
      const h = await held();
      Eligibility.getChargeableAutopayMethod.mockRejectedValue(new Error('connection reset'));
      expect(await sweep()).toMatchObject({ candidates: 1, skipped: 1, declined_released: 0, released: 0, charged: 0 });
      await untouched(h);
      expect(Eligibility.getChargeableAutopayMethod).toHaveBeenCalledWith({ id: h.customerId }, expect.anything(), { rethrow: true });
      expect(quote).not.toHaveBeenCalled();
      expect(chargeCall).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(await chargeAuditRows()).toHaveLength(0);
      // The next run retries.
      Eligibility.getChargeableAutopayMethod.mockResolvedValue(METHOD);
      expect(await sweep()).toMatchObject({ charged: 1 });
    });

    test('a quote refusal (no charge called) keeps the hold when a paid payment appeared since the hold began', async () => {
      const h = await held();
      quote.mockImplementation(async () => {
        await mockPg('payments').insert({ customer_id: h.customerId, status: 'paid' });
        throw new Error('Invoice is billed to a third-party payer');
      });
      expect(await sweep()).toMatchObject({ candidates: 1, declined_released: 0, release_failed: 1 });
      await untouched(h);
      expect(chargeCall).not.toHaveBeenCalled();
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_not_released', reason: 'refused', released: false });
    });

    test('no method found keeps the hold when the hold itself changed since the read (stamp equality still applies)', async () => {
      const h = await held();
      Eligibility.getChargeableAutopayMethod.mockImplementation(async () => {
        await mockPg('invoice_followup_sequences').where({ invoice_id: h.invoiceId }).update({ updated_at: new Date(Date.now() - 3.5 * DAY) });
        return null;
      });
      expect(await sweep()).toMatchObject({ declined_released: 0, release_failed: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('autopay_hold');
    });

    test('a decline keeps the hold when a processing payment (not our failed row) exists since the hold began', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await leaveDeclineRows(h);
        await mockPg('payments').insert({ customer_id: h.customerId, status: 'processing' });
        throw decline();
      });
      expect(await sweep()).toMatchObject({ declined_released: 0, release_failed: 1, ambiguous: 0 });
      await untouched(h);
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'declined_not_released', released: false });
    });

    test('a plain decline that leaves a non-failed attempt is read as unclear: kept, one check-Stripe alert', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'succeeded' });
        throw decline();
      });
      expect(await sweep()).toMatchObject({ ambiguous: 1, declined_released: 0 });
      await untouched(h);
    });

    test('a quote that fails moves no money: the hold is released and the charge is never called', async () => {
      const h = await held();
      quote.mockRejectedValue(new Error('Invoice is billed to a third-party payer'));
      expect(await sweep()).toMatchObject({ declined_released: 1 });
      expect((await seqOf(h.invoiceId)).status).toBe('active');
      expect(chargeCall).not.toHaveBeenCalled();
    });

    test.each(['STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED', 'STRIPE_CHARGE_IN_PROGRESS'])('%s keeps the hold, retries nothing and posts one check-Stripe alert', async (code) => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'ambiguous' });
        throw Object.assign(new Error('unclear'), { code });
      });
      const result = await sweep();
      expect(result).toMatchObject({ candidates: 1, ambiguous: 1, declined_released: 0, released: 0, charged: 0 });
      await untouched(h);
      expect(chargeCall).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      const [category, headline, why, opts] = notify.mock.calls[0];
      expect(category).toBe('billing');
      expect(headline).toContain('check Stripe first');
      expect(why).toContain('check Stripe before anything else');
      expect(opts.dedupeKey).toBe(`autopay_hold_charge:ambiguous:${h.invoiceId}`);
      expect(opts.detail).toContain(code);
      const [row] = await chargeAuditRows();
      expect(row.metadata).toMatchObject({ outcome: 'ambiguous', error_code: code, released: false });
      // The next run does not touch it either: the attempt row fences it.
      expect(await sweep()).toMatchObject({ candidates: 0 });
      expect(chargeCall).toHaveBeenCalledTimes(1);
    });

    test('a plain error that leaves an open charge attempt is ambiguous, not a refusal', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => {
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'claimed' });
        throw new Error('socket hang up');
      });
      expect(await sweep()).toMatchObject({ ambiguous: 1, declined_released: 0 });
      await untouched(h);
      expect(notify.mock.calls[0][3].dedupeKey).toBe(`autopay_hold_charge:ambiguous:${h.invoiceId}`);
    });

    test('a decline that asks the customer to authenticate is ambiguous: the live PaymentIntent may still be completed', async () => {
      const h = await held();
      chargeCall.mockImplementation(async () => { await leaveDeclineRows(h); throw decline('authentication_required'); });
      expect(await sweep()).toMatchObject({ ambiguous: 1, declined_released: 0 });
      await untouched(h);
    });

    test('an alert that cannot be filed leaves the attempt unfinished (no release, no final row) and the sweep goes on to the next hold', async () => {
      const first = await held({ sequenceId: '00000000-0000-4000-8000-000000000001' });
      const second = await held({ sequenceId: '00000000-0000-4000-8000-000000000002' });
      notify.mockRejectedValue(new Error('bell down'));
      chargeCall.mockImplementation(async () => { throw decline(); });
      expect(await sweep()).toMatchObject({ candidates: 2, errors: 2, declined_released: 0 });
      expect(chargeCall).toHaveBeenCalledTimes(2);
      await untouched(first);
      await untouched(second);
      expect(await chargeAuditRows()).toHaveLength(0);
    });

    test('a hold that changed after the read is skipped before any quote or charge', async () => {
      const a = await held({ sequenceId: '00000000-0000-4000-8000-000000000001' });
      const b = await held({ sequenceId: '00000000-0000-4000-8000-000000000002' });
      chargeCall.mockImplementation(async () => {
        // While A is charged, B's customer pays: B's hold is no longer stale.
        await mockPg('payments').insert({ customer_id: b.customerId, status: 'paid' });
        return { status: 'paid', amount: 103.09 };
      });
      expect(await sweep()).toMatchObject({ candidates: 2, charged: 1, skipped: 1 });
      expect(chargeCall).toHaveBeenCalledTimes(1);
      expect(chargeCall.mock.calls[0][0]).toBe(a.invoiceId);
      await untouched(b);
      expect(await chargeAuditRows()).toHaveLength(1);
    });

    test('every skip the sweep has for true applies to charge: a held-over candidate is never charged', async () => {
      const visit = await held({ visitStatus: 'confirmed' });
      const plan = await held();
      await mockPg('payment_plans').insert({ invoice_id: plan.invoiceId, status: 'active' });
      const attempted = await held();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: attempted.invoiceId, status: 'failed' });
      const young = await held({ heldDaysAgo: 2 });
      const paid = await held({ invoiceStatus: 'paid' });
      const payer = await held({ payerId: randomUUID() });
      expect(await sweep()).toMatchObject({ candidates: 0, charged: 0 });
      expect(chargeCall).not.toHaveBeenCalled();
      for (const h of [visit, plan, attempted, young, paid, payer]) await untouched(h);
    });

    test.each(['true', 'shadow', 'off'])('GATE_AUTOPAY_HOLD_TIMEOUT=%s never asks for a method, a quote or a charge', async (value) => {
      process.env.GATE_AUTOPAY_HOLD_TIMEOUT = value;
      await held();
      const result = await sweep();
      expect(result.mode).toBe(value);
      expect(Eligibility.getChargeableAutopayMethod).not.toHaveBeenCalled();
      expect(quote).not.toHaveBeenCalled();
      expect(chargeCall).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(await chargeAuditRows()).toHaveLength(0);
    });

    describe('recovery of an attempt that did not finish', () => {
      const STARTED = 'invoice_followup.autopay_hold_timeout_charge_started';
      const startedRows = () => mockPg('audit_log').where({ action: STARTED });
      const markStarted = (h) => mockPg('audit_log').insert({
        actor_type: 'system', action: STARTED, resource_type: 'invoice', resource_id: h.invoiceId,
        metadata: { sequence_id: h.sequenceId, customer_id: h.customerId, hold_stamp: h.heldAt.toISOString(), amount_cents: 10309 },
      });

      test('the marker is written right before the charge, with the hold stamp and amount', async () => {
        const h = await held();
        let markerAtChargeTime = null;
        chargeCall.mockImplementation(async () => { markerAtChargeTime = await startedRows(); return { status: 'paid', amount: 103.09 }; });
        await sweep();
        expect(markerAtChargeTime).toHaveLength(1);
        expect(markerAtChargeTime[0]).toMatchObject({ actor_type: 'system', resource_type: 'invoice', resource_id: h.invoiceId });
        expect(markerAtChargeTime[0].metadata).toMatchObject({ sequence_id: h.sequenceId, customer_id: h.customerId, amount_cents: 10309 });
        expect(typeof markerAtChargeTime[0].metadata.hold_stamp).toBe('string');
        // The final row is written after the marker.
        const [final] = await chargeAuditRows();
        expect(new Date(final.created_at).getTime()).toBeGreaterThanOrEqual(new Date(markerAtChargeTime[0].created_at).getTime());
      });

      test('(a) a decline whose release throws once: no final row, the next run releases, alerts once, writes recovered, and never charges again', async () => {
        const h = await held();
        chargeCall.mockImplementation(async () => { await leaveDeclineRows(h); throw decline(); });
        await mockPg('fail_release').insert({ id: 1 });
        const first = await sweep();
        expect(first).toMatchObject({ candidates: 1, errors: 1, declined_released: 0 });
        await untouched(h);
        expect(await chargeAuditRows()).toHaveLength(0);
        // The alert goes out before the release, so it was filed once already.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(await startedRows()).toHaveLength(1);

        await mockPg('fail_release').del();
        const second = await sweep();
        expect(second).toMatchObject({ recovered: 1, errors: 0, charged: 0 });
        expect(chargeCall).toHaveBeenCalledTimes(1);
        const seq = await seqOf(h.invoiceId);
        expect(seq.status).toBe('active');
        expect(seq.next_touch_at).not.toBeNull();
        // Recovery raises it again under the SAME dedupe key, so the office sees one open alert.
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1][3].dedupeKey).toBe(notify.mock.calls[0][3].dedupeKey);
        expect(notify.mock.calls[0][3].dedupeKey).toBe(`autopay_hold_charge:declined:${h.invoiceId}`);
        const rows = await chargeAuditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toMatchObject({ outcome: 'declined_released', reason: 'recovered', amount_cents: 10309, released: true });

        // Done: a third run finds nothing to recover and still does not charge.
        expect(await sweep()).toMatchObject({ recovered: 0, candidates: 0 });
        expect(chargeCall).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(2);
      });

      test('(b) a marker with a succeeded attempt on a paid invoice: sequence closed, final row charged, no alert, no charge', async () => {
        const h = await held();
        await markStarted(h);
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'succeeded' });
        await mockPg('invoices').where({ id: h.invoiceId }).update({ status: 'paid' });
        expect(await sweep()).toMatchObject({ recovered: 1, charged: 0 });
        expect((await seqOf(h.invoiceId)).status).toBe('completed');
        const [row] = await chargeAuditRows();
        expect(row.metadata).toMatchObject({ outcome: 'charged', reason: null, released: false });
        expect(notify).not.toHaveBeenCalled();
        expect(chargeCall).not.toHaveBeenCalled();
      });

      test('(c) a marker with a claimed (open) attempt: one ambiguous alert, hold kept, nothing charged, and the alert is not repeated', async () => {
        const h = await held();
        await markStarted(h);
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'claimed' });
        expect(await sweep()).toMatchObject({ recovered: 1 });
        await untouched(h);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][3].dedupeKey).toBe(`autopay_hold_charge:ambiguous:${h.invoiceId}`);
        const [row] = await chargeAuditRows();
        expect(row.metadata).toMatchObject({ outcome: 'ambiguous', reason: 'ambiguous', released: false });
        expect(await sweep()).toMatchObject({ recovered: 0 });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(chargeCall).not.toHaveBeenCalled();
      });

      test('(d) a marker with no attempt after it: final row abandoned, no charge in that run, the next run charges normally', async () => {
        const h = await held();
        await markStarted(h);
        const first = await sweep();
        expect(first).toMatchObject({ recovered: 1, charged: 0, candidates: 0 });
        expect(chargeCall).not.toHaveBeenCalled();
        const [row] = await chargeAuditRows();
        expect(row.metadata).toMatchObject({ outcome: 'abandoned', released: false });
        await untouched(h);
        expect(notify).not.toHaveBeenCalled();

        const second = await sweep();
        expect(second).toMatchObject({ recovered: 0, charged: 1 });
        expect(chargeCall).toHaveBeenCalledTimes(1);
        expect(await startedRows()).toHaveLength(2);
      });

      test('(1) a failed attempt with decline_code authentication_required after the marker is ambiguous: one alert, hold kept, no release', async () => {
        const h = await held();
        await markStarted(h);
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'failed', decline_code: 'authentication_required' });
        expect(await sweep()).toMatchObject({ recovered: 1, declined_released: 0 });
        await untouched(h);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][3].dedupeKey).toBe(`autopay_hold_charge:ambiguous:${h.invoiceId}`);
        const [row] = await chargeAuditRows();
        expect(row.metadata).toMatchObject({ outcome: 'ambiguous', released: false });
        expect(chargeCall).not.toHaveBeenCalled();
      });

      test('(2) the own-charge release never releases a hold whose attempt asks the customer to authenticate', async () => {
        const { releaseStaleAutopayHold: releaseOne } = require('../services/invoice-followups')._test;
        const observed = async (h) => mockPg('invoice_followup_sequences as s').where('s.id', h.sequenceId)
          .first('s.id', 's.invoice_id', 's.customer_id', mockPg.raw('s.updated_at::text as hold_stamp'));
        const cutoff = new Date(Date.now() - TIMEOUT_DAYS * DAY);
        const auth = await held();
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: auth.invoiceId, status: 'failed', decline_code: 'authentication_required' });
        expect(await releaseOne(await observed(auth), cutoff, { afterOwnCharge: true })).toBe(false);
        await untouched(auth);
        // The same failed attempt with a plain decline code is still released.
        const plain = await held();
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: plain.invoiceId, status: 'failed', decline_code: 'insufficient_funds' });
        expect(await releaseOne(await observed(plain), cutoff, { afterOwnCharge: true })).toBe(true);
      });

      test('(3) a live ambiguous outcome whose alert fails: no final row, hold kept; the next run raises the alert and finishes', async () => {
        const h = await held();
        chargeCall.mockImplementation(async () => {
          await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'ambiguous' });
          throw Object.assign(new Error('unclear'), { code: 'STRIPE_AMBIGUOUS_OUTCOME' });
        });
        notify.mockResolvedValue(null);
        expect(await sweep()).toMatchObject({ candidates: 1, errors: 1, ambiguous: 0 });
        await untouched(h);
        expect(await chargeAuditRows()).toHaveLength(0);

        notify.mockResolvedValue({ id: 'bell-2' });
        expect(await sweep()).toMatchObject({ recovered: 1, errors: 0 });
        await untouched(h);
        expect(notify).toHaveBeenCalledTimes(2);
        const [row] = await chargeAuditRows();
        expect(row.metadata).toMatchObject({ outcome: 'ambiguous', released: false });
        expect(chargeCall).toHaveBeenCalledTimes(1);
      });

      test('(4) a live decline whose alert fails: no release, no final row; the next run alerts, releases, finishes, and never charges again', async () => {
        const h = await held();
        chargeCall.mockImplementation(async () => { await leaveDeclineRows(h); throw decline(); });
        notify.mockRejectedValue(new Error('bell down'));
        expect(await sweep()).toMatchObject({ candidates: 1, errors: 1, declined_released: 0 });
        await untouched(h);
        expect(await chargeAuditRows()).toHaveLength(0);

        notify.mockResolvedValue({ id: 'bell-2' });
        expect(await sweep()).toMatchObject({ recovered: 1, errors: 0 });
        expect((await seqOf(h.invoiceId)).status).toBe('active');
        const rows = await chargeAuditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toMatchObject({ outcome: 'declined_released', reason: 'recovered', released: true });
        expect(chargeCall).toHaveBeenCalledTimes(1);
      });

      test('(e) a failed attempt without our marker (Auto Pay itself) is never touched by recovery', async () => {
        const h = await held();
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'failed' });
        expect(await sweep()).toMatchObject({ recovered: 0, candidates: 0, errors: 0 });
        await untouched(h);
        expect(notify).not.toHaveBeenCalled();
        expect(await chargeAuditRows()).toHaveLength(0);
        expect(chargeCall).not.toHaveBeenCalled();
      });

      test('true, shadow and off never run recovery', async () => {
        const h = await held();
        await markStarted(h);
        await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: h.invoiceId, status: 'failed' });
        for (const value of ['true', 'shadow', 'off']) {
          process.env.GATE_AUTOPAY_HOLD_TIMEOUT = value;
          await sweep();
        }
        await untouched(h);
        expect(await chargeAuditRows()).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
      });

      test('a marker that cannot be written means no charge', async () => {
        const h = await held();
        await mockPg.raw('ALTER TABLE audit_log ADD CONSTRAINT no_marker CHECK (action <> \'invoice_followup.autopay_hold_timeout_charge_started\')');
        try {
          expect(await sweep()).toMatchObject({ candidates: 1, skipped: 1, charged: 0 });
        } finally {
          await mockPg.raw('ALTER TABLE audit_log DROP CONSTRAINT no_marker');
        }
        expect(chargeCall).not.toHaveBeenCalled();
        await untouched(h);
      });
    });

    test.each([['charge', 'charge'], [' Charge ', 'charge'], ['CHARGE', 'charge'], ['chargeit', 'off'], ['true ', 'true'], ['shadow', 'shadow'], ['yes', 'off']])('the gate reads %p as %s', (value, expected) => {
      process.env.GATE_AUTOPAY_HOLD_TIMEOUT = value;
      expect(require('../config/feature-gates').autopayHoldTimeoutMode()).toBe(expected);
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
