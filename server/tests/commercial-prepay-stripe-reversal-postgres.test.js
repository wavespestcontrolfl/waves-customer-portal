'use strict';

// Stripe reversal integration proof for commercial setup sales. All Stripe
// reads are synthetic; PostgreSQL is the protected per-lane QA database.
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
const mockStripePaymentIntentRetrieve = jest.fn();
const mockStripeRefundList = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  charges: { retrieve: (...args) => mockStripeChargeRetrieve(...args) },
  paymentIntents: {
    retrieve: (...args) => mockStripePaymentIntentRetrieve(...args),
    cancel: jest.fn(async () => ({})),
  },
  refunds: { list: (...args) => mockStripeRefundList(...args) },
})));
jest.mock('../config/stripe-config', () => ({
  secretKey: 'sk_test_commercial_reversal',
  webhookSecret: 'whsec_test_commercial_reversal',
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
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => {}),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendRefundIssued: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: (...args) => mockStripePaymentIntentRetrieve(...args),
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

jest.setTimeout(120000);

function setupLine(amount) {
  return [{
    description: 'Bait Station Setup — one-time setup fee',
    quantity: 1,
    unit_price: amount,
    amount,
    category: 'Setup fee',
  }];
}

async function seedCustomer() {
  const customerId = randomUUID();
  await trx('customers').insert({
    id: customerId,
    first_name: 'Synthetic',
    last_name: 'Stripe Reversal',
    phone: `+1202555${String(parseInt(customerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    property_type: 'commercial',
  });
  return customerId;
}

async function seedSale({ customerId, amount = 55, paymentIntentId, chargeId }) {
  const ids = {
    customerId,
    invoiceId: randomUUID(),
    estimateId: randomUUID(),
    termId: randomUUID(),
  };
  await trx('estimates').insert({
    id: ids.estimateId,
    customer_id: customerId,
    status: 'accepted',
    estimate_data: { propertyType: 'commercial' },
  });
  await trx('invoices').insert({
    id: ids.invoiceId,
    token: randomUUID(),
    invoice_number: `STRIPE-${ids.invoiceId.slice(0, 8)}`,
    customer_id: customerId,
    title: 'Commercial Rodent Bait Stations — Annual Prepay',
    status: 'paid',
    paid_at: new Date(),
    payment_recorded_at: new Date(),
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: chargeId,
    subtotal: amount,
    total: amount,
    due_date: etDateString(),
    line_items: JSON.stringify(setupLine(amount)),
  });
  await trx('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: customerId,
    prepay_invoice_id: ids.invoiceId,
    source_estimate_id: ids.estimateId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: amount,
    prepay_amount: amount,
    term_start: etDateString(),
    term_end: '2099-12-31',
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
  });
  await require('../services/commercial-prepay-sale-record').recordUnbookedSale(trx, {
    invoiceId: ids.invoiceId,
    customerId,
    estimateId: ids.estimateId,
    setupAmount: amount,
  });
  return ids;
}

async function seedPayment(ids, {
  paymentIntentId,
  chargeId,
  amount = 55,
  metadata = {},
  statementId = null,
  payerId = null,
} = {}) {
  const [payment] = await trx('payments').insert({
    customer_id: statementId ? null : ids?.customerId,
    payer_id: payerId,
    statement_id: statementId,
    processor: 'stripe',
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: chargeId,
    payment_date: etDateString(),
    amount,
    base_amount_cents: Math.round(amount * 100),
    surcharge_amount_cents: 0,
    status: 'paid',
    description: 'Synthetic Stripe commercial prepay receipt',
    metadata: JSON.stringify(metadata),
  }).returning('*');
  return payment;
}

function reviews(invoiceId) {
  return trx('dispatch_alerts')
    .where({ type: 'commercial_prepay_setup_review' })
    .whereRaw("payload->>'sourceInvoiceId' = ?", [String(invoiceId)])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc');
}

function fullRefund({ chargeId, paymentIntentId, refundId, amountCents }) {
  return {
    id: chargeId,
    payment_intent: paymentIntentId,
    amount: amountCents,
    amount_refunded: amountCents,
    refunded: true,
    metadata: {},
    refunds: { data: [{
      id: refundId,
      amount: amountCents,
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000),
    }] },
  };
}

postgres('commercial prepay Stripe reversal writers', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Stripe reversal tests require a private local waves_qa_<32 hex> database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    mockPg = database;
    require('../services/annual-prepay-renewals');
    require('../routes/stripe-webhook');
  }, 240000);

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockPg = trx;
    mockStripePaymentIntentRetrieve.mockImplementation(async (id) => ({
      id,
      status: 'succeeded',
      metadata: {},
    }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  test('a combined full refund records every owned return in-transaction before a bounce records restoration', async () => {
    const customerId = await seedCustomer();
    const paymentIntentId = `pi_combined_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_combined_${randomUUID().slice(0, 12)}`;
    const refundId = `re_combined_${randomUUID().slice(0, 12)}`;
    const first = await seedSale({ customerId, paymentIntentId, chargeId });
    const second = await seedSale({ customerId, paymentIntentId, chargeId });
    for (const sale of [first, second]) {
      await seedPayment(sale, {
        paymentIntentId,
        chargeId,
        metadata: {
          invoice_id: sale.invoiceId,
          combined_payment: true,
          combined_anchor_invoice_id: first.invoiceId,
          payment_state: 'paid',
          settled_event_at: new Date().toISOString(),
          base_amount: 55,
          card_surcharge: 0,
        },
      });
    }
    const charge = fullRefund({ chargeId, paymentIntentId, refundId, amountCents: 11000 });
    mockStripeChargeRetrieve.mockResolvedValue({ id: chargeId, amount: 11000 });

    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewCalls = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      reviewCalls.push({ invoiceId, isTransaction: conn.isTransaction === true });
      return realReconcile(conn, invoiceId);
    });
    const webhook = require('../routes/stripe-webhook');

    await webhook._handleChargeRefunded(charge);

    expect(reviewCalls.filter(({ invoiceId }) => [first.invoiceId, second.invoiceId].includes(invoiceId)))
      .toEqual(expect.arrayContaining([
        { invoiceId: first.invoiceId, isTransaction: true },
        { invoiceId: second.invoiceId, isTransaction: true },
      ]));
    expect(await reviews(first.invoiceId)).toEqual([
      expect.objectContaining({ resolved_at: null, payload: expect.objectContaining({ sourceInvoiceId: first.invoiceId }) }),
    ]);
    expect(await reviews(second.invoiceId)).toEqual([
      expect.objectContaining({ resolved_at: null, payload: expect.objectContaining({ sourceInvoiceId: second.invoiceId }) }),
    ]);

    await webhook._handleRefundFailed({
      id: refundId,
      charge: chargeId,
      payment_intent: paymentIntentId,
      amount: 11000,
      status: 'failed',
      failure_reason: 'synthetic_bank_return',
    });

    for (const sale of [first, second]) {
      const episodes = await reviews(sale.invoiceId);
      expect(episodes).toHaveLength(2);
      expect(episodes.filter((row) => row.payload.paymentRestored !== true)).toEqual([
        expect.objectContaining({ resolved_at: expect.any(Date) }),
      ]);
      expect(episodes.filter((row) => row.payload.paymentRestored === true)).toEqual([
        expect.objectContaining({ resolved_at: null }),
      ]);
    }
  });

  test('lost dispute closure proves a whole invoice allocation, while a partial remains unconfirmed', async () => {
    const customerId = await seedCustomer();
    const webhook = require('../routes/stripe-webhook');

    const fullPi = `pi_dispute_full_${randomUUID().slice(0, 12)}`;
    const fullCharge = `ch_dispute_full_${randomUUID().slice(0, 12)}`;
    const full = await seedSale({ customerId, paymentIntentId: fullPi, chargeId: fullCharge });
    await seedPayment(full, {
      paymentIntentId: fullPi,
      chargeId: fullCharge,
      metadata: { invoice_id: full.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    await webhook._handleDisputeClosed({
      id: `dp_full_${randomUUID().slice(0, 12)}`,
      charge: fullCharge,
      payment_intent: fullPi,
      status: 'lost',
      amount: 5500,
    });

    const fullPayment = await trx('payments').where({ stripe_charge_id: fullCharge }).first('metadata');
    expect(fullPayment.metadata).toEqual(expect.objectContaining({
      dispute_final: 'lost',
      dispute_invoice_id: full.invoiceId,
      dispute_full_payment: true,
    }));
    expect(await reviews(full.invoiceId)).toHaveLength(1);

    const partialPi = `pi_dispute_partial_${randomUUID().slice(0, 12)}`;
    const partialCharge = `ch_dispute_partial_${randomUUID().slice(0, 12)}`;
    const partial = await seedSale({ customerId, paymentIntentId: partialPi, chargeId: partialCharge });
    await seedPayment(partial, {
      paymentIntentId: partialPi,
      chargeId: partialCharge,
      metadata: { invoice_id: partial.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    await webhook._handleDisputeClosed({
      id: `dp_partial_${randomUUID().slice(0, 12)}`,
      charge: partialCharge,
      payment_intent: partialPi,
      status: 'lost',
      amount: 1000,
    });

    const partialPayment = await trx('payments').where({ stripe_charge_id: partialCharge }).first('metadata');
    expect(partialPayment.metadata).toEqual(expect.objectContaining({
      dispute_final: 'lost',
      dispute_invoice_id: partial.invoiceId,
      dispute_full_payment: false,
    }));
    expect(await reviews(partial.invoiceId)).toEqual([]);
  });

  test('payer-statement dispute closure never writes commercial invoice receipt proof', async () => {
    const [payer] = await trx('payers').insert({
      display_name: 'Synthetic AP',
      payment_terms: 'net30',
    }).returning('*');
    const paymentIntentId = `pi_statement_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_statement_${randomUUID().slice(0, 12)}`;
    const [statement] = await trx('payer_statements').insert({
      payer_id: payer.id,
      period_start: etDateString(),
      period_end: etDateString(),
      status: 'paid',
      terms_snapshot: 'net30',
      total: 55,
      token: randomUUID(),
      stripe_payment_intent_id: paymentIntentId,
      stripe_charge_id: chargeId,
      paid_at: new Date(),
    }).returning('*');
    await seedPayment(null, {
      paymentIntentId,
      chargeId,
      statementId: statement.id,
      payerId: payer.id,
      metadata: { statement_id: statement.id, payer_id: payer.id, source: 'statement_payment' },
    });

    await require('../routes/stripe-webhook')._handleDisputeClosed({
      id: `dp_statement_${randomUUID().slice(0, 12)}`,
      charge: chargeId,
      payment_intent: paymentIntentId,
      status: 'lost',
      amount: 5500,
    });

    const row = await trx('payments').where({ stripe_charge_id: chargeId }).first('metadata');
    expect(row.metadata).toEqual(expect.objectContaining({ dispute_final: 'lost' }));
    expect(row.metadata).not.toHaveProperty('dispute_full_payment');
    expect(await trx('dispatch_alerts').where({ type: 'commercial_prepay_setup_review' })).toEqual([]);
  });
});
