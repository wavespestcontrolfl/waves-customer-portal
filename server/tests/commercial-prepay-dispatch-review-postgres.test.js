jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) {
    db[name] = (...args) => mockPg[name](...args);
  }
  for (const name of ['schema', 'fn', 'client']) {
    Object.defineProperty(db, name, { get: () => mockPg[name] });
  }
  return db;
});
const mockStripeChargeRetrieve = jest.fn();
const mockStripeRefundCreate = jest.fn();
const mockStripeRefundList = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  charges: { retrieve: (...args) => mockStripeChargeRetrieve(...args) },
  refunds: {
    create: (...args) => mockStripeRefundCreate(...args),
    list: (...args) => mockStripeRefundList(...args),
  },
})));
jest.mock('../config/stripe-config', () => ({
  secretKey: 'sk_test_dispatch_review', webhookSecret: 'whsec_test_dispatch_review',
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/notification-service', () => ({
  create: jest.fn(async () => ({ id: 'synthetic-notification' })),
  notifyAdmin: jest.fn(async () => {}),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendRefundIssued: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
let trx;

jest.setTimeout(60000);

function setupLine(amount = 55) {
  return [{
    description: 'Bait Station Setup — one-time setup fee',
    quantity: 1,
    unit_price: amount,
    amount,
    category: 'Setup fee',
  }];
}

async function seedOriginal({ status = 'paid', paymentIntentId = null, unbookedSale = true } = {}) {
  const ids = {
    customerId: randomUUID(),
    invoiceId: randomUUID(),
    termId: randomUUID(),
    estimateId: randomUUID(),
  };
  await trx('customers').insert({
    id: ids.customerId,
    first_name: 'Synthetic',
    last_name: 'Dispatch Review',
    phone: `+1202555${String(parseInt(ids.customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    property_type: 'commercial',
  });
  await trx('estimates').insert({
    id: ids.estimateId,
    customer_id: ids.customerId,
    status: 'accepted',
    estimate_data: { propertyType: 'commercial' },
  });
  await trx('invoices').insert({
    id: ids.invoiceId,
    token: randomUUID(),
    invoice_number: `OBS-${ids.invoiceId.slice(0, 8)}`,
    customer_id: ids.customerId,
    title: 'Commercial Rodent Bait Stations — Annual Prepay',
    status,
    paid_at: status === 'paid' || status === 'prepaid' ? new Date() : null,
    payment_recorded_at: new Date(),
    stripe_payment_intent_id: paymentIntentId,
    subtotal: 55,
    total: 55,
    due_date: etDateString(),
    line_items: JSON.stringify(setupLine()),
  });
  await trx('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: ids.customerId,
    prepay_invoice_id: ids.invoiceId,
    source_estimate_id: ids.estimateId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: 55,
    prepay_amount: 55,
    term_start: etDateString(),
    term_end: '2099-12-31',
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
  });
  await require('../services/secure-appointment-plans').recordSetupFeeClaimForInvoice(trx, {
    invoiceId: ids.invoiceId, estimateId: ids.estimateId, amount: 55,
    unbookedSaleCustomerId: unbookedSale ? ids.customerId : null,
  });
  return ids;
}

async function insertCardPayment(ids, {
  paymentIntentId,
  status = 'paid',
  refundStatus = null,
  refundAmount = 0,
  amount = 55,
  baseCents = 5500,
  surchargeCents = 0,
  refundedSurchargeCents = 0,
  invoiceId = null,
  createdAt = new Date(),
} = {}) {
  const [row] = await trx('payments').insert({
    customer_id: ids.customerId,
    payment_date: etDateString(),
    amount,
    base_amount_cents: baseCents,
    surcharge_amount_cents: surchargeCents,
    refunded_surcharge_cents: refundedSurchargeCents,
    status,
    refund_status: refundStatus,
    refund_amount: refundAmount,
    stripe_payment_intent_id: paymentIntentId,
    processor: 'stripe',
    description: 'Synthetic commercial prepay receipt',
    metadata: invoiceId ? { invoice_id: invoiceId } : {},
    created_at: createdAt,
  }).returning('*');
  return row;
}

function reviews(invoiceId) {
  return trx('dispatch_alerts')
    .where({ type: 'commercial_prepay_setup_review' })
    .whereRaw("payload->>'sourceInvoiceId' = ?", [String(invoiceId)])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc');
}

postgres('commercial prepay Dispatch review observes only recovered receipt proof', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Dispatch review tests require a private local waves_qa_<32 hex> database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
    // Load the real writers before timing individual payment transactions.
    require('../services/secure-appointment-plans');
    require('../services/annual-prepay-renewals');
    require('../routes/stripe-webhook');
    require('../routes/admin-invoices');
    require('../services/invoice-manual-payment');
  }, 240000);

  beforeEach(async () => {
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  test('acknowledgement survives replay and an opposite episode supersedes it exactly once', async () => {
    const firstPi = `pi_returned_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: firstPi });
    await insertCardPayment(ids, {
      paymentIntentId: firstPi,
      status: 'refunded',
      refundStatus: 'full',
      refundAmount: 55,
    });
    const review = require('../services/commercial-prepay-dispatch-review');

    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    let [returned] = await reviews(ids.invoiceId);
    expect(returned).toEqual(expect.objectContaining({ resolved_at: null }));
    await require('../services/dispatch-alerts').resolveAlert({ trx, id: returned.id, resolvedBy: null });
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    expect(await reviews(ids.invoiceId)).toHaveLength(1);

    const repaymentPi = `pi_restored_${randomUUID().slice(0, 12)}`;
    await trx('invoices').where({ id: ids.invoiceId }).update({
      status: 'paid',
      paid_at: new Date(),
      payment_recorded_at: new Date(),
      stripe_payment_intent_id: repaymentPi,
    });
    await insertCardPayment(ids, { paymentIntentId: repaymentPi });
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('active');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('active');

    const alerts = await reviews(ids.invoiceId);
    expect(alerts).toHaveLength(2);
    returned = alerts.find((row) => row.payload.paymentRestored !== true);
    const restored = alerts.find((row) => row.payload.paymentRestored === true);
    expect(returned.resolved_at).not.toBeNull();
    expect(returned.payload.superseded_at).toBeTruthy();
    expect(restored).toEqual(expect.objectContaining({ resolved_at: null }));
    expect(restored.payload).toEqual(expect.objectContaining({
      sourceInvoiceId: ids.invoiceId,
      customerId: ids.customerId,
      estimateId: ids.estimateId,
      amount: 55,
      paymentRestored: true,
    }));
  });

  test('a historical zero-visit conversion and a replayed claim cannot certify what the office promised at the sale', async () => {
    const pi = `pi_legacy_${randomUUID()}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi, unbookedSale: false });
    await trx('activity_log').insert({
      customer_id: ids.customerId, action: 'estimate_converted',
      description: `Estimate #${ids.estimateId} converted: 0 scheduled`,
      metadata: { estimateId: ids.estimateId, scheduledCount: 0, firstScheduledServiceId: null },
    });
    await insertCardPayment(ids, { paymentIntentId: pi, status: 'refunded', refundStatus: 'full', refundAmount: 55 });
    await require('../services/secure-appointment-plans').recordSetupFeeClaimForInvoice(trx, {
      invoiceId: ids.invoiceId, estimateId: ids.estimateId, amount: 55, unbookedSaleCustomerId: ids.customerId,
    });
    await expect(require('../services/commercial-prepay-dispatch-review').reconcileInvoice(trx, ids.invoiceId))
      .resolves.toBeNull();
    expect(await reviews(ids.invoiceId)).toHaveLength(0);
  });

  test.each(['claimId', 'customerId'])('a sale record referring to another %s cannot open a card', async (field) => {
    const pi = `pi_wrong_sale_${randomUUID()}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi });
    const audit = trx('audit_log').where({ action: 'commercial_setup_sold_without_visit', resource_id: ids.invoiceId });
    const { metadata } = await audit.clone().first('metadata');
    await audit.update({ metadata: { ...metadata, [field]: randomUUID() } });
    await insertCardPayment(ids, { paymentIntentId: pi, status: 'refunded', refundStatus: 'full', refundAmount: 55 });
    await expect(require('../services/commercial-prepay-dispatch-review').reconcileInvoice(trx, ids.invoiceId))
      .resolves.toBeNull();
    expect(await reviews(ids.invoiceId)).toHaveLength(0);
  });

  test('the real full-refund webhook, office cash repayment, and old replay keep one current original-invoice card', async () => {
    const pi = `pi_e2e_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_e2e_${randomUUID().slice(0, 12)}`;
    const refundId = `re_e2e_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'paid', paymentIntentId: pi });
    await trx('invoices').where({ id: ids.invoiceId }).update({ stripe_charge_id: chargeId });
    await insertCardPayment(ids, { paymentIntentId: pi, invoiceId: ids.invoiceId });
    await trx('payments').where({ stripe_payment_intent_id: pi }).update({ stripe_charge_id: chargeId });
    const charge = {
      id: chargeId,
      payment_intent: pi,
      amount: 5500,
      amount_refunded: 5500,
      refunded: true,
      metadata: {},
      refunds: {
        data: [{
          id: refundId,
          amount: 5500,
          status: 'succeeded',
          created: Math.floor(Date.now() / 1000),
        }],
      },
    };
    const webhook = require('../routes/stripe-webhook');
    await webhook._handleChargeRefunded(charge);
    await webhook._handleChargeRefunded(charge);

    let alerts = await reviews(ids.invoiceId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toEqual(expect.objectContaining({
      sourceInvoiceId: ids.invoiceId,
      customerId: ids.customerId,
      amount: 55,
    }));
    expect(alerts[0].payload.paymentRestored).toBeUndefined();
    await require('../services/dispatch-alerts').resolveAlert({ trx, id: alerts[0].id });

    // The office deliberately reopens the returned original invoice, then
    // uses the production cash/check recorder rather than a fixture insert.
    await trx('invoices').where({ id: ids.invoiceId }).update({
      status: 'sent',
      paid_at: null,
      payment_recorded_at: null,
      stripe_payment_intent_id: null,
      stripe_charge_id: null,
    });
    await require('../services/invoice-manual-payment').recordManualPayment(ids.invoiceId, {
      method: 'cash',
      recordedBy: 'Synthetic Office Writer',
      sendReceipt: false,
    });

    // A late replay of the old provider refund cannot reclaim the invoice or
    // replace the current repayment episode.
    await webhook._handleChargeRefunded(charge);
    alerts = await reviews(ids.invoiceId);
    expect(alerts).toHaveLength(2);
    expect(alerts.filter((row) => row.payload.superseded_at == null)).toHaveLength(1);
    expect(alerts.find((row) => row.payload.paymentRestored === true)).toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.objectContaining({
        sourceInvoiceId: ids.invoiceId,
        amount: 55,
        paymentRestored: true,
      }),
    }));
  }, 120000);

  test.each([
    ['partial principal refund', {
      payment: { status: 'paid', refundStatus: 'partial', refundAmount: 10 },
    }],
    ['full status with only a partial return in the ledger', {
      payment: { status: 'refunded', refundStatus: 'full', refundAmount: 10 },
    }],
    ['surcharge-only refund', {
      payment: {
        status: 'paid', refundStatus: 'partial', refundAmount: 1.6,
        amount: 56.6, baseCents: 5500, surchargeCents: 160, refundedSurchargeCents: 160,
      },
    }],
    ['payment tagged to the wrong invoice', {
      payment: { status: 'refunded', refundStatus: 'full', refundAmount: 55, invoiceId: randomUUID() },
    }],
  ])('%s does not create a review', async (_label, fixture) => {
    const pi = `pi_negative_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'paid', paymentIntentId: pi });
    await insertCardPayment(ids, { paymentIntentId: pi, ...fixture.payment });
    const state = await require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId);
    expect(['active', 'unconfirmed']).toContain(state);
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });

  test('applying office credit and reversing it moves the same review through three episodes once', async () => {
    const pi = `pi_credit_${randomUUID()}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi });
    await insertCardPayment(ids, { paymentIntentId: pi, status: 'refunded', refundStatus: 'full', refundAmount: 55 });
    const review = require('../services/commercial-prepay-dispatch-review');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    await require('../services/customer-credit').postCreditMovement({
      customerId: ids.customerId, delta: 55, source: 'manual', createdBy: 'Synthetic funding',
    }, trx);
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ status: 'payment_pending' });
    await trx('invoices').where({ id: ids.invoiceId }).update({
      status: 'sent', paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null,
      credit_applied: 0, annual_prepay_term_id: ids.termId,
    });

    async function officeAction(path) {
      const { route } = require('../routes/admin-invoices').stack.find((layer) => layer.route?.path === path);
      const req = { params: { id: ids.invoiceId }, body: { note: 'Synthetic office transaction' } };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
      await route.stack.at(-1).handle(req, res, (err) => { throw err; });
      return res.statusCode;
    }
    await expect(officeAction('/:id/apply-credit')).resolves.toBe(200);
    expect((await reviews(ids.invoiceId)).filter((row) => !row.resolved_at).map((row) => row.payload.paymentRestored))
      .toEqual([true]);
    await expect(officeAction('/:id/reverse-prepaid')).resolves.toBe(200);
    await expect(officeAction('/:id/reverse-prepaid')).resolves.toBe(400);
    const episodes = await reviews(ids.invoiceId);
    expect(episodes).toHaveLength(3);
    expect(episodes.filter((row) => !row.resolved_at)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ sourceInvoiceId: ids.invoiceId }) }),
    ]);
    expect(episodes.find((row) => !row.resolved_at).payload.paymentRestored).toBeUndefined();
    expect((await trx('customer_credit_ledger').where({ invoice_id: ids.invoiceId }).pluck('delta')).map(Number).sort((x, y) => x - y))
      .toEqual([-55, 55]);
  });

  test('mixed card and invoice credit requires both exact returns before alerting', async () => {
    const pi = `pi_mixed_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi });
    const invoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    const providerAt = new Date(Date.now() - 60_000);
    await insertCardPayment(ids, {
      paymentIntentId: pi,
      status: 'refunded',
      refundStatus: 'full',
      refundAmount: 40,
      amount: 40,
      baseCents: 4000,
      createdAt: providerAt,
    });
    await trx('customer_credit_ledger').insert({
      customer_id: ids.customerId,
      invoice_id: ids.invoiceId,
      delta: -15,
      balance_after: 0,
      source: 'invoice_application',
      created_by: 'synthetic',
      created_at: new Date(providerAt.getTime() - 60_000),
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);

    await trx('customer_credit_ledger').insert({
      customer_id: ids.customerId,
      invoice_id: ids.invoiceId,
      delta: 15,
      balance_after: 15,
      source: 'adjustment',
      note: `Account credit returned — invoice ${invoice.invoice_number} fully refunded`,
      created_by: 'system:refund',
      created_at: new Date(providerAt.getTime() + 60_000),
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    expect(await reviews(ids.invoiceId)).toHaveLength(1);
  });

  test.each([false, true])('legacy/current Customer 360 receipt proof is recovered (current=%s)', async (current) => {
    const ids = await seedOriginal({ status: 'paid', paymentIntentId: null });
    const recordedAt = new Date('2026-11-19T18:00:00.000Z');
    await trx('invoices').where({ id: ids.invoiceId }).update({
      payment_method: 'check',
      payment_recorded_at: recordedAt,
    });
    await trx('payments').insert({
      customer_id: ids.customerId,
      amount: 55,
      status: 'paid',
      payment_date: etDateString(),
      description: 'Customer 360 annual prepay receipt',
      created_at: recordedAt,
      metadata: {
        source: 'customer360_annual_prepay',
        invoice_id: ids.invoiceId,
        annual_prepay_term_id: ids.termId,
        method: 'check',
        ...(current ? { payer_id: null, principal_cents: 5500 } : {}),
      },
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
      .resolves.toBe('active');
  });

  test('reading deposit evidence does not acquire a settlement lock', async () => {
    const ids = await seedOriginal();
    const invoice = {
      id: ids.invoiceId, customer_id: ids.customerId,
      line_items: [{ category: 'deposit_credit', estimate_id: ids.estimateId, amount: -55 }],
    };
    await database.transaction(async (holder) => {
      // EXCLUSIVE allows plain reads, and would block SELECT FOR UPDATE even
      // for a missing allocation. This database is private to the suite.
      await holder.raw("SET LOCAL lock_timeout = '5s'");
      await holder.raw('LOCK TABLE estimate_deposits IN EXCLUSIVE MODE');
      await trx.raw("SET LOCAL lock_timeout = '500ms'");
      await expect(require('../services/estimate-deposits')
        .invoiceDepositCreditIsBacked(invoice, trx, { exactSourceBinding: true })).resolves.toBe(false);
    });
  });

  test('a partial deposit allocation without an invoice binding stays unconfirmed', async () => {
    const ids = await seedOriginal({ status: 'prepaid', paymentIntentId: null });
    await trx('invoices').where({ id: ids.invoiceId }).update({
      total: 0,
      payment_recorded_at: null,
      line_items: JSON.stringify([
        ...setupLine(),
        {
          description: 'Deposit credit', quantity: 1, unit_price: -55, amount: -55,
          category: 'deposit_credit', estimate_id: ids.estimateId,
        },
      ]),
    });
    const [deposit] = await trx('estimate_deposits').insert({
      estimate_id: ids.estimateId,
      customer_id: ids.customerId,
      amount: 75,
      credited_amount: 0,
      refunded_amount: 0,
      status: 'received',
      stripe_payment_intent_id: `pi_deposit_${randomUUID().slice(0, 12)}`,
      credited_invoice_id: null,
    }).returning('*');
    const deposits = require('../services/estimate-deposits');
    await expect(deposits.consumeDepositCredit({
      estimateId: ids.estimateId, invoiceId: ids.invoiceId, amount: 55, trx,
    })).resolves.toBe(55);
    const review = require('../services/commercial-prepay-dispatch-review');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
    await expect(deposits.pendingDepositCredit(ids.estimateId, trx)).resolves.toMatchObject({ amount: 20 });
    const renewals = require('../services/annual-prepay-renewals');
    await expect(renewals.annualPrepayCoversVisit({
      customer_id: ids.customerId, service_type: 'Commercial Rodent Bait Stations',
      annual_prepay_term_id: ids.termId, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 55,
    }, trx, { throwOnError: true })).resolves.toBe(true);

    // Exhaustion supplies the durable invoice binding the current ledger can
    // prove; this is accepted without pretending the earlier partial had one.
    await trx('estimate_deposits').where({ id: deposit.id }).update({
      amount: 55,
      credited_amount: 55,
      status: 'credited',
      credited_invoice_id: ids.invoiceId,
    });
    await expect(review.readReceiptState(trx,
      await trx('invoices').where({ id: ids.invoiceId }).first())).resolves.toBe('active');
  });

  test('bulk queue clear does not substitute for this card\'s staff acknowledgement', async () => {
    const pi = `pi_returned_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi });
    await insertCardPayment(ids, {
      paymentIntentId: pi, status: 'refunded', refundStatus: 'full', refundAmount: 55,
    });
    await require('../services/commercial-prepay-dispatch-review').reconcileInvoice(trx, ids.invoiceId);
    await require('../services/dispatch-alerts').resolveAllOpenAlerts({ trx });
    expect((await reviews(ids.invoiceId))[0].resolved_at).toBeNull();
  });
});
