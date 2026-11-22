/**
 * Settled-card exact refund ids against a real PostgreSQL ledger.
 *
 * This lane is deliberately narrow: one fully-settled Stripe card payment,
 * one invoice it exactly owns, and synthetic Stripe history. The fixtures
 * carry redundant trusted card evidence so the gate never enrolls from a
 * description or caller-provided metadata alone.
 */
process.env.GATE_SETTLED_CARD_REFUND_IDS = 'true';

const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { isDeepStrictEqual } = require('node:util');

// Exact marker consumed by the native server-db sharded CI lane.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const mockRefundsCreate = jest.fn();
const mockRefundsList = jest.fn();
const mockChargesRetrieve = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  refunds: {
    create: (...args) => mockRefundsCreate(...args),
    list: (...args) => mockRefundsList(...args),
  },
  charges: { retrieve: (...args) => mockChargesRetrieve(...args) },
  webhooks: new (jest.requireActual('stripe'))('sk_test_settled_card').webhooks,
})));
jest.mock('../config/stripe-config', () => ({
  secretKey: 'sk_test_settled_card',
  publishableKey: 'pk_test_settled_card',
  webhookSecret: 'whsec_test_settled_card',
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendRefundIssued: jest.fn(async () => undefined),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ triggered: true })),
}));
jest.mock('../services/customer-health', () => ({
  scoreCustomer: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  withTermiteGateForCharge: jest.fn(async (_ctx, fn) => fn()),
  acquireTermiteGateForCharge: jest.fn(async () => []),
  assertParentDecisionLockAlive: jest.fn(),
  syncTermForRefundedPayment: jest.fn(async () => []),
  syncTermForInvoicePayment: jest.fn(async () => []),
}));

jest.setTimeout(60000);

postgres('settled Stripe card refund ids (real PostgreSQL)', () => {
  let db;
  let StripeService;
  let handleChargeRefunded;
  let server;
  const fixtures = [];
  const providerRefunds = [];
  const refundByKey = new Map();
  const createIds = [];
  let created = Math.floor(Date.now() / 1000) - 3600;

  const rowMeta = (row) => {
    if (!row?.metadata) return {};
    return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  };
  const dollars = (value) => Number(value || 0);
  const liveForCharge = (chargeId) => providerRefunds.filter((refund) => (
    refund.charge === chargeId && !['failed', 'canceled'].includes(refund.status)
  ));
  const totalForCharge = (chargeId) => liveForCharge(chargeId)
    .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);

  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && url.pathname === '/waves_test';
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (!privateQa && !ciTest)) {
      throw new Error('Use a verified, task-private QA database or the isolated CI database');
    }

    db = require('../models/db');
    StripeService = require('../services/stripe');
    const router = require('../routes/stripe-webhook');
    handleChargeRefunded = router._handleChargeRefunded;
    const app = require('express')();
    app.use('/api/stripe/webhook', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterAll(async () => {
    delete process.env.GATE_SETTLED_CARD_REFUND_IDS;
    if (server) await new Promise(resolve => server.close(resolve));
    await db?.destroy();
  });

  async function deliver(f, suffix, type, object) {
    const payload = JSON.stringify({
      id: `evt_settled_card_${f.paymentId}_${suffix}`, type, created: Math.floor(Date.now() / 1000), data: { object },
    });
    const signature = new (jest.requireActual('stripe'))('sk_test_settled_card').webhooks
      .generateTestHeaderString({ payload, secret: 'whsec_test_settled_card' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stripe/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
    });
    await response.text();
    return response.status;
  }

  beforeEach(() => {
    process.env.GATE_SETTLED_CARD_REFUND_IDS = 'true';
    providerRefunds.length = 0;
    refundByKey.clear();
    createIds.length = 0;
    created += 100;
    mockRefundsCreate.mockReset();
    mockRefundsList.mockReset();
    mockChargesRetrieve.mockReset();

    mockRefundsCreate.mockImplementation(async (params, options = {}) => {
      const key = options.idempotencyKey;
      const prior = refundByKey.get(key);
      if (prior) {
        if (!isDeepStrictEqual(params, prior.params)) throw new Error('Synthetic Stripe key reused with different parameters');
        return prior.refund;
      }
      const fixture = fixtures.find((item) => (
        item.chargeId === params.charge || item.paymentIntentId === params.payment_intent
      ));
      if (!fixture) throw new Error(`Unknown synthetic Stripe payment ${params.charge || params.payment_intent}`);
      const refund = addProviderRefund(fixture, {
        id: createIds.shift() || `re_card_admin_${providerRefunds.length + 1}`,
        amount: params.amount == null ? 10000 - totalForCharge(fixture.chargeId) : params.amount,
        status: 'succeeded',
        metadata: params.metadata,
      });
      refundByKey.set(key, { params, refund });
      return refund;
    });

    mockRefundsList.mockImplementation((params = {}) => {
      const newestFirst = providerRefunds
        .filter((refund) => (
          (params.charge && refund.charge === params.charge)
          || (params.payment_intent && refund.payment_intent === params.payment_intent)
        ))
        .slice()
        .reverse();
      const cursor = params.starting_after
        ? newestFirst.findIndex((refund) => refund.id === params.starting_after) + 1
        : 0;
      const limit = Number(params.limit) || 10;
      const data = newestFirst.slice(cursor, cursor + limit);
      // Stripe's list supports both awaiting a page and walking all pages.
      const response = Promise.resolve({ data, has_more: cursor + data.length < newestFirst.length });
      response.autoPagingToArray = async ({ limit: maximum }) => newestFirst.slice(0, maximum);
      return response;
    });

    mockChargesRetrieve.mockImplementation(async (chargeId) => {
      const fixture = fixtures.find((item) => item.chargeId === chargeId);
      return {
        id: chargeId,
        object: 'charge',
        paid: true,
        captured: true,
        status: 'succeeded',
        amount: 10000,
        amount_captured: 10000,
        amount_refunded: totalForCharge(chargeId),
        refunded: totalForCharge(chargeId) >= 10000,
        payment_intent: fixture?.paymentIntentId || null,
        payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', funding: 'credit' } },
      };
    });
  });

  afterEach(async () => {
    for (const refund of providerRefunds) {
      await db('notifications').where('body', 'like', `%${refund.id}%`).del().catch(() => {});
      await db('stripe_failed_refunds').where({ stripe_refund_id: refund.id }).del().catch(() => {});
    }
    for (const fixture of fixtures.splice(0).reverse()) {
      await db('stripe_webhook_events').where('id', 'like', `evt_settled_card_${fixture.paymentId}%`).del().catch(() => {});
      await db('customer_credit_ledger').where({ customer_id: fixture.customerId }).del().catch(() => {});
      await db('payments').where({ customer_id: fixture.customerId }).del();
      await db('invoices').where({ customer_id: fixture.customerId }).del();
      await db('payment_methods').where({ customer_id: fixture.customerId }).del();
      await db('customers').where({ id: fixture.customerId }).del();
    }
  });

  function addProviderRefund(fixture, { id, amount, status = 'succeeded', metadata = {} }) {
    const refund = {
      id,
      object: 'refund',
      amount,
      status,
      charge: fixture.chargeId,
      payment_intent: fixture.paymentIntentId,
      created: created++,
      reason: 'requested_by_customer',
      metadata: metadata || {},
    };
    providerRefunds.push(refund);
    return refund;
  }

  async function fixture(overrides = {}) {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const paymentId = randomUUID();
    const paymentMethodId = randomUUID();
    const token = randomUUID();
    const paymentIntentId = `pi_card_${token.replaceAll('-', '').slice(0, 18)}`;
    const chargeId = `ch_card_${token.replaceAll('-', '').slice(0, 18)}`;
    const methodType = overrides.methodType || 'card';
    const amount = overrides.amount ?? 100;
    const invoiceTotal = overrides.invoiceTotal ?? 100;
    const creditApplied = overrides.creditApplied ?? 0;
    const status = overrides.status || 'paid';
    const result = { customerId, invoiceId, paymentId, paymentMethodId, paymentIntentId, chargeId };
    fixtures.push(result);

    await db('customers').insert({
      id: customerId,
      first_name: 'Settled',
      last_name: 'Card',
      phone: `+1202555${token.replaceAll('-', '').slice(0, 4)}`,
      account_credits: 0,
    });
    await db('payment_methods').insert({
      id: paymentMethodId,
      customer_id: customerId,
      processor: 'stripe',
      stripe_payment_method_id: `pm_card_${token.replaceAll('-', '').slice(0, 18)}`,
      stripe_customer_id: `cus_card_${token.replaceAll('-', '').slice(0, 18)}`,
      method_type: methodType,
      card_brand: methodType === 'card' ? 'VISA' : null,
      last_four: methodType === 'card' ? '4242' : null,
      bank_name: methodType === 'card' ? null : 'Synthetic Bank',
      bank_last_four: methodType === 'card' ? null : '6789',
      ach_status: methodType === 'card' ? null : 'verified',
      is_default: true,
      autopay_enabled: false,
    });
    await db('invoices').insert({
      id: invoiceId,
      customer_id: customerId,
      token,
      invoice_number: `CARD-${invoiceId.slice(0, 8)}`,
      status: status === 'paid' ? 'paid' : 'processing',
      paid_at: status === 'paid' ? new Date() : null,
      subtotal: invoiceTotal + creditApplied,
      total: invoiceTotal,
      credit_applied: creditApplied,
      line_items: JSON.stringify([{ description: 'Synthetic settled service', amount: invoiceTotal }]),
      payment_method: overrides.invoicePaymentMethod || (methodType === 'card' ? 'card' : 'us_bank_account'),
      stripe_payment_intent_id: overrides.invoicePaymentIntentId || paymentIntentId,
      stripe_charge_id: overrides.invoiceChargeId || chargeId,
    });
    await db('payments').insert({
      id: paymentId,
      customer_id: customerId,
      payment_method_id: paymentMethodId,
      payment_method_type: methodType,
      processor: overrides.processor || 'stripe',
      payment_date: '2026-11-20',
      amount,
      status,
      card_brand: methodType === 'card' ? 'VISA' : null,
      card_last_four: methodType === 'card' ? '4242' : null,
      stripe_payment_intent_id: paymentIntentId,
      stripe_charge_id: chargeId,
      metadata: JSON.stringify({ invoice_id: invoiceId, ...(overrides.metadata || {}) }),
    });
    if (overrides.manualSiblingAmount) {
      await db('payments').insert({
        customer_id: customerId,
        processor: 'manual',
        payment_date: '2026-11-20',
        amount: overrides.manualSiblingAmount,
        status: 'paid',
        description: 'Synthetic manual part payment',
        metadata: JSON.stringify({ invoice_id: invoiceId, partial_payment: true, method: 'cash' }),
      });
    }
    return result;
  }

  async function payment(f) {
    return db('payments').where({ id: f.paymentId }).first();
  }

  function chargeSnapshot(f, amountRefundedCents, refund) {
    return {
      id: f.chargeId,
      object: 'charge',
      payment_intent: f.paymentIntentId,
      amount: 10000,
      amount_refunded: amountRefundedCents,
      refunded: amountRefundedCents >= 10000,
      metadata: {},
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', funding: 'credit' } },
      refunds: { data: refund ? [refund] : [] },
    };
  }

  test('admin and webhook preserve individual ids through an equal-value failed refund and replacement', async () => {
    const f = await fixture();
    createIds.push(`re_card_failed_a_${f.paymentId}`);
    await StripeService.refund(f.paymentId, { amount: 40 });
    const refundA = providerRefunds[0];
    expect(rowMeta(await payment(f)).stamped_refund_ids).toEqual([refundA.id]);

    refundA.status = 'failed';
    refundA.failure_reason = 'Synthetic issuer rejected refund A';
    const refundB = addProviderRefund(f, { id: `re_card_replacement_b_${f.paymentId}`, amount: 4000 });
    // On the pinned API a charge.refunded delivery usually has only the
    // cumulative amount. Both A and B have exactly that amount.
    const replacementCharge = { ...chargeSnapshot(f, 4000, refundB), refunds: { data: [] } };
    expect(await deliver(f, 'replacement', 'charge.refunded', replacementCharge)).toBe(500);

    let row = await payment(f);
    expect(row).toMatchObject({ status: 'paid', refund_amount: '40.00', stripe_refund_id: refundA.id });
    expect(rowMeta(row).stamped_refund_ids).toEqual([refundA.id]);

    expect(await deliver(f, 'failure', 'refund.failed', refundA)).toBe(200);
    expect(await deliver(f, 'replacement', 'charge.refunded', replacementCharge)).toBe(200);
    row = await payment(f);
    expect(row).toMatchObject({ status: 'paid', refund_amount: '40.00', stripe_refund_id: refundB.id });
    expect(rowMeta(row)).toMatchObject({
      settled_card_refund_ledger: 1,
      failed_refund_ids: [refundA.id],
      stamped_refund_ids: [refundB.id],
    });
    expect(require('../services/payment-lifecycle-email').sendRefundIssued).toHaveBeenCalledWith(expect.objectContaining({
      refundId: refundB.id, refundAmount: 40, refundDate: new Date(refundB.created * 1000),
    }));

    createIds.push(`re_card_admin_c_${f.paymentId}`);
    await StripeService.refund(f.paymentId, { amount: 10 });
    const refundC = providerRefunds.find((refund) => refund.id.startsWith('re_card_admin_c_'));
    await handleChargeRefunded(chargeSnapshot(f, 5000, refundC));
    row = await payment(f);
    expect(row).toMatchObject({ status: 'paid', refund_amount: '50.00', stripe_refund_id: refundC.id });
    expect(rowMeta(row).stamped_refund_ids).toEqual([refundB.id, refundC.id]);

    expect(await deliver(f, 'failure', 'refund.failed', refundA)).toBe(200);
    row = await payment(f);
    expect(row).toMatchObject({ refund_amount: '50.00', stripe_refund_id: refundC.id });
    expect(rowMeta(row).stamped_refund_ids).toEqual([refundB.id, refundC.id]);
  });

  test('an old partial webhook cannot regress a full refund verified from both ids', async () => {
    const f = await fixture();
    const earlier = addProviderRefund(f, { id: `re_card_40_${f.paymentId}`, amount: 4000 });
    await handleChargeRefunded(chargeSnapshot(f, 4000, earlier));
    const later = addProviderRefund(f, { id: `re_card_60_${f.paymentId}`, amount: 6000 });
    await handleChargeRefunded(chargeSnapshot(f, 10000, later));

    await handleChargeRefunded(chargeSnapshot(f, 4000, earlier));

    const row = await payment(f);
    expect(row).toMatchObject({ status: 'refunded', refund_amount: '100.00', stripe_refund_id: later.id });
    expect(rowMeta(row)).toMatchObject({
      settled_card_refund_ledger: 1,
      stamped_refund_ids: [earlier.id, later.id],
    });
    expect(await db('invoices').where({ id: f.invoiceId }).first('status')).toEqual({ status: 'refunded' });
  });

  test('overlapping admin requests share one provider identity and record it once', async () => {
    const f = await fixture();
    const createAtProvider = mockRefundsCreate.getMockImplementation();
    let enteredProvider;
    let releaseProvider;
    const entered = new Promise((resolve) => { enteredProvider = resolve; });
    const released = new Promise((resolve) => { releaseProvider = resolve; });
    mockRefundsCreate.mockImplementationOnce(async (...args) => {
      enteredProvider();
      await released;
      return createAtProvider(...args);
    });

    const first = StripeService.refund(f.paymentId, { amount: 20 });
    let second;
    try {
      await Promise.race([
        entered,
        first.then(() => { throw new Error('Expected the first request to enter synthetic Stripe'); }),
      ]);
      second = await StripeService.refund(f.paymentId, { amount: 20, reason: 'duplicate operator click' });
    } finally {
      releaseProvider();
      await first.catch(() => {});
    }

    expect((await first).refund_issued_amount).toBe(20);
    expect(second.refund_issued_amount).toBe(20);
    expect(providerRefunds).toHaveLength(1);
    expect(mockRefundsCreate.mock.calls[1]).toEqual(mockRefundsCreate.mock.calls[0]);
    const row = await payment(f);
    expect(dollars(row.refund_amount)).toBe(20);
    expect(rowMeta(row).stamped_refund_ids).toEqual([providerRefunds[0].id]);
  });

  test('retrying a legacy refund preserves the pending attempt when Stripe identifies a bank debit', async () => {
    const f = await fixture();
    const pending = {
      invoice_id: f.invoiceId,
      pending_refund_key: `refund_pay_${f.paymentId}_2500_0`,
      pending_refund_request: '2500',
      pending_refund_at: new Date().toISOString(),
    };
    await db('payments').where({ id: f.paymentId }).update({ metadata: JSON.stringify(pending) });
    mockChargesRetrieve.mockResolvedValueOnce({
      id: f.chargeId, payment_intent: f.paymentIntentId, status: 'succeeded',
      paid: true, captured: true, amount_captured: 10000, payment_method_details: { type: 'us_bank_account' },
    });

    await expect(StripeService.refund(f.paymentId, { amount: 25 }))
      .rejects.toThrow('Stripe did not confirm the original charge as a settled card payment');

    const after = await payment(f);
    expect(rowMeta(after)).toEqual(pending);
    expect(dollars(after.refund_amount)).toBe(0);
    expect(mockChargesRetrieve).toHaveBeenCalledWith(f.chargeId);
    expect(mockRefundsList).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  test('an aged admin attempt adopts only the refund carrying its durable identity', async () => {
    const f = await fixture();
    const attemptId = randomUUID();
    const refund = addProviderRefund(f, {
      id: `re_card_aged_${f.paymentId}`,
      amount: 2500,
      metadata: {
        waves_admin_refund_version: '1',
        waves_admin_refund_attempt: attemptId,
      },
    });
    const dashboardRefund = addProviderRefund(f, { id: `re_card_dashboard_${f.paymentId}`, amount: 2500 });
    await db('payments').where({ id: f.paymentId }).update({
      metadata: JSON.stringify({
        invoice_id: f.invoiceId,
        settled_card_refund_ledger: 1,
        pending_refund_key: `refund_pay_${f.paymentId}_2500_0`,
        pending_refund_version: 1,
        pending_refund_id: attemptId,
        pending_refund_charge_id: f.chargeId,
        pending_refund_request: '2500',
        pending_refund_base: '2500',
        pending_refund_gross: 2500,
        pending_refund_reason: 'requested_by_customer',
        pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      }),
    });

    await StripeService.refund(f.paymentId, { amount: 25 });

    expect(mockRefundsCreate).not.toHaveBeenCalled();
    const row = await payment(f);
    expect(row).toMatchObject({ status: 'paid', refund_amount: '50.00', stripe_refund_id: dashboardRefund.id });
    expect(rowMeta(row)).toMatchObject({
      settled_card_refund_ledger: 1,
      stamped_refund_ids: [refund.id, dashboardRefund.id],
      last_admin_refund: { id: refund.id },
    });
    expect(rowMeta(row).pending_refund_key).toBeUndefined();
  });

  test('eligibility is exact, dark by default, and enrollment survives gate rollback', async () => {
    const { usesSettledCardRefundLedger } = require('../services/settled-card-refunds');
    const ach = await fixture({ methodType: 'us_bank_account' });
    const processing = await fixture({ status: 'processing' });
    const creditMixed = await fixture({ amount: 90, invoiceTotal: 100, creditApplied: 10 });
    const manualMixed = await fixture({ amount: 80, invoiceTotal: 100, manualSiblingAmount: 20 });
    const otherProcessor = await fixture({ processor: 'manual', invoicePaymentMethod: 'cash' });
    const mismatched = await fixture({ invoiceChargeId: `ch_other_${randomUUID()}` });

    for (const f of [ach, processing, creditMixed, manualMixed, otherProcessor, mismatched]) {
      expect(await usesSettledCardRefundLedger(db, await payment(f))).toBe(false);
      expect(rowMeta(await payment(f)).settled_card_refund_ledger).toBeUndefined();
    }

    const dark = await fixture();
    process.env.GATE_SETTLED_CARD_REFUND_IDS = 'false';
    expect(await usesSettledCardRefundLedger(db, await payment(dark))).toBe(false);
    expect(rowMeta(await payment(dark)).settled_card_refund_ledger).toBeUndefined();

    process.env.GATE_SETTLED_CARD_REFUND_IDS = 'true';
    createIds.push(`re_dark_enroll_${dark.paymentId}`);
    await StripeService.refund(dark.paymentId, { amount: 10 });
    let enrolled = await payment(dark);
    expect(rowMeta(enrolled).settled_card_refund_ledger).toBe(1);

    process.env.GATE_SETTLED_CARD_REFUND_IDS = 'false';
    enrolled = await payment(dark);
    expect(await usesSettledCardRefundLedger(db, enrolled)).toBe(true);
    expect(rowMeta(await payment(dark)).settled_card_refund_ledger).toBe(1);
  });
});
