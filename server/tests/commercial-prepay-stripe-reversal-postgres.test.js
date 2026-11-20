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
  baseCents = Math.round(amount * 100),
  surchargeCents = 0,
  metadata = {},
  statementId = null,
  payerId = null,
  status = 'paid',
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
    base_amount_cents: baseCents,
    surcharge_amount_cents: surchargeCents,
    status,
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

function succeededIntent({ invoiceId, paymentIntentId, chargeId, amountCents = 5500 }) {
  return {
    id: paymentIntentId,
    status: 'succeeded',
    amount: amountCents,
    amount_received: amountCents,
    latest_charge: chargeId,
    payment_method_types: ['card'],
    metadata: {
      waves_invoice_id: invoiceId,
      base_amount: String(amountCents / 100),
      card_surcharge: '0',
      surcharge_policy_version: 'synthetic-debit-v1',
    },
  };
}

function mockSucceededCard(intent) {
  mockStripePaymentIntentRetrieve.mockResolvedValue(intent);
  mockStripeChargeRetrieve.mockResolvedValue({
    id: intent.latest_charge,
    amount: intent.amount,
    receipt_url: 'https://example.invalid/synthetic-receipt',
    balance_transaction: { created: Math.floor(Date.now() / 1000) },
    payment_method_details: {
      type: 'card',
      card: { brand: 'visa', last4: '4242', funding: 'debit' },
    },
  });
}

async function refundAndAcknowledge(webhook, sale, { paymentIntentId, chargeId }) {
  await webhook._handleChargeRefunded(fullRefund({
    chargeId,
    paymentIntentId,
    refundId: `re_initial_${randomUUID().slice(0, 12)}`,
    amountCents: 5500,
  }));
  const [returned] = await reviews(sale.invoiceId);
  expect(returned).toEqual(expect.objectContaining({
    resolved_at: null,
    payload: expect.objectContaining({ sourceInvoiceId: sale.invoiceId }),
  }));
  await require('../services/dispatch-alerts').resolveAlert({ trx, id: returned.id });
  return returned;
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

  test('a combined full refund preserves a surcharged anchor split before a bounce and replay', async () => {
    const customerId = await seedCustomer();
    const paymentIntentId = `pi_combined_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_combined_${randomUUID().slice(0, 12)}`;
    const refundId = `re_combined_${randomUUID().slice(0, 12)}`;
    const first = await seedSale({ customerId, paymentIntentId, chargeId });
    const second = await seedSale({ customerId, paymentIntentId, chargeId });
    for (const [index, sale] of [first, second].entries()) {
      const anchor = index === 0;
      await seedPayment(sale, {
        paymentIntentId,
        chargeId,
        amount: anchor ? 56.6 : 55,
        baseCents: 5500,
        surchargeCents: anchor ? 160 : 0,
        metadata: {
          invoice_id: sale.invoiceId,
          combined_payment: true,
          combined_anchor_invoice_id: first.invoiceId,
          payment_state: 'paid',
          settled_event_at: new Date().toISOString(),
          base_amount: 55,
          card_surcharge: anchor ? 1.6 : 0,
        },
      });
    }
    const charge = fullRefund({ chargeId, paymentIntentId, refundId, amountCents: 11160 });
    mockStripeChargeRetrieve.mockResolvedValue({ id: chargeId, amount: 11160 });

    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewCalls = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      reviewCalls.push({ invoiceId, isTransaction: conn.isTransaction === true });
      return realReconcile(conn, invoiceId);
    });
    const webhook = require('../routes/stripe-webhook');

    await webhook._handleChargeRefunded(charge);

    const refundedRows = await trx('payments').where({ stripe_charge_id: chargeId }).orderBy('amount', 'desc');
    expect(refundedRows).toHaveLength(2);
    expect(refundedRows.map((row) => ({
      invoiceId: row.metadata.invoice_id,
      status: row.status,
      refundAmount: Number(row.refund_amount),
      refundedBaseCents: Number(row.refunded_base_cents),
      refundedSurchargeCents: Number(row.refunded_surcharge_cents),
    }))).toEqual([
      {
        invoiceId: first.invoiceId,
        status: 'refunded',
        refundAmount: 56.6,
        refundedBaseCents: 5500,
        refundedSurchargeCents: 160,
      },
      {
        invoiceId: second.invoiceId,
        status: 'refunded',
        refundAmount: 55,
        refundedBaseCents: 5500,
        refundedSurchargeCents: 0,
      },
    ]);

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
      amount: 11160,
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

    const restoredRows = await trx('payments').where({ stripe_charge_id: chargeId }).orderBy('amount', 'desc');
    expect(restoredRows.map((row) => ({
      status: row.status,
      refundAmount: Number(row.refund_amount),
      refundStatus: row.refund_status,
      refundedBaseCents: Number(row.refunded_base_cents),
      refundedSurchargeCents: Number(row.refunded_surcharge_cents),
    }))).toEqual([
      {
        status: 'paid', refundAmount: 0, refundStatus: null,
        refundedBaseCents: 0, refundedSurchargeCents: 0,
      },
      {
        status: 'paid', refundAmount: 0, refundStatus: null,
        refundedBaseCents: 0, refundedSurchargeCents: 0,
      },
    ]);

    // A late charge.refunded replay loses to the durable failed-refund fence:
    // it cannot restamp either half or create a third review episode.
    await webhook._handleChargeRefunded(charge);
    expect((await trx('payments').where({ stripe_charge_id: chargeId }).orderBy('amount', 'desc'))
      .map((row) => ({
        status: row.status,
        refundAmount: Number(row.refund_amount),
        refundedBaseCents: Number(row.refunded_base_cents),
        refundedSurchargeCents: Number(row.refunded_surcharge_cents),
      }))).toEqual([
      { status: 'paid', refundAmount: 0, refundedBaseCents: 0, refundedSurchargeCents: 0 },
      { status: 'paid', refundAmount: 0, refundedBaseCents: 0, refundedSurchargeCents: 0 },
    ]);
    await expect(reviews(first.invoiceId)).resolves.toHaveLength(2);
    await expect(reviews(second.invoiceId)).resolves.toHaveLength(2);
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

  test('a close-first lost combined dispute binds full proof to every owned invoice allocation', async () => {
    const customerId = await seedCustomer();
    const paymentIntentId = `pi_dispute_combined_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_dispute_combined_${randomUUID().slice(0, 12)}`;
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
          base_amount: 55,
          card_surcharge: 0,
        },
      });
    }
    mockStripeChargeRetrieve.mockResolvedValue({ id: chargeId, amount: 11000 });
    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewConnections = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      if ([first.invoiceId, second.invoiceId].includes(invoiceId)) {
        reviewConnections.push({ invoiceId, isTransaction: conn.isTransaction === true });
      }
      return realReconcile(conn, invoiceId);
    });

    await require('../routes/stripe-webhook')._handleDisputeClosed({
      id: `dp_combined_${randomUUID().slice(0, 12)}`,
      charge: chargeId,
      payment_intent: paymentIntentId,
      status: 'lost',
      amount: 11000,
    });

    const rows = await trx('payments').where({ stripe_charge_id: chargeId }).orderBy('id');
    expect(rows).toHaveLength(2);
    for (const sale of [first, second]) {
      const row = rows.find((candidate) => candidate.metadata.invoice_id === sale.invoiceId);
      expect(row.metadata).toEqual(expect.objectContaining({
        dispute_final: 'lost',
        dispute_invoice_id: sale.invoiceId,
        dispute_full_payment: true,
      }));
      expect(await reviews(sale.invoiceId)).toEqual([
        expect.objectContaining({
          resolved_at: null,
          payload: expect.objectContaining({ sourceInvoiceId: sale.invoiceId }),
        }),
      ]);
    }
    expect(reviewConnections).toEqual(expect.arrayContaining([
      { invoiceId: first.invoiceId, isTransaction: true },
      { invoiceId: second.invoiceId, isTransaction: true },
    ]));
  });

  test('a replacement that lands before the combined-loss invoice lock owns the invoice and suppresses the old loss review', async () => {
    const customerId = await seedCustomer();
    const paymentIntentId = `pi_dispute_race_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_dispute_race_${randomUUID().slice(0, 12)}`;
    const replacementPi = `pi_replacement_${randomUUID().slice(0, 12)}`;
    const sale = await seedSale({ customerId, paymentIntentId, chargeId });
    await seedPayment(sale, {
      paymentIntentId,
      chargeId,
      metadata: {
        invoice_id: sale.invoiceId,
        combined_payment: true,
        combined_anchor_invoice_id: sale.invoiceId,
        base_amount: 55,
        card_surcharge: 0,
      },
    });
    mockStripeChargeRetrieve.mockResolvedValue({ id: chargeId, amount: 5500 });

    const renewals = require('../services/annual-prepay-renewals');
    const realGate = renewals.acquireTermiteGateAtEntry;
    let replacementInjected = false;
    jest.spyOn(renewals, 'acquireTermiteGateAtEntry').mockImplementation(async (conn, args) => {
      const result = await realGate(conn, args);
      if (!replacementInjected && args?.invoiceIds?.includes(sale.invoiceId)) {
        replacementInjected = true;
        await conn('invoices').where({ id: sale.invoiceId }).update({
          status: 'paid',
          paid_at: new Date(),
          stripe_payment_intent_id: replacementPi,
          stripe_charge_id: `ch_replacement_${randomUUID().slice(0, 12)}`,
        });
      }
      return result;
    });
    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewed = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      reviewed.push(invoiceId);
      return realReconcile(conn, invoiceId);
    });

    await require('../routes/stripe-webhook')._handleDisputeClosed({
      id: `dp_race_${randomUUID().slice(0, 12)}`,
      charge: chargeId,
      payment_intent: paymentIntentId,
      status: 'lost',
      amount: 5500,
    });

    expect(replacementInjected).toBe(true);
    expect(await trx('invoices').where({ id: sale.invoiceId }).first('status', 'stripe_payment_intent_id'))
      .toMatchObject({ status: 'paid', stripe_payment_intent_id: replacementPi });
    expect(reviewed).not.toContain(sale.invoiceId);
    expect(await reviews(sale.invoiceId)).toEqual([]);
  });

  test('synchronous confirm records restoration before a later refund starts a new returned episode', async () => {
    const customerId = await seedCustomer();
    const originalPi = `pi_confirm_original_${randomUUID().slice(0, 12)}`;
    const originalCharge = `ch_confirm_original_${randomUUID().slice(0, 12)}`;
    const sale = await seedSale({ customerId, paymentIntentId: originalPi, chargeId: originalCharge });
    await seedPayment(sale, {
      paymentIntentId: originalPi,
      chargeId: originalCharge,
      metadata: { invoice_id: sale.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    const webhook = require('../routes/stripe-webhook');
    const returnedEpisode = await refundAndAcknowledge(webhook, sale, {
      paymentIntentId: originalPi, chargeId: originalCharge,
    });

    const replacementPi = `pi_confirm_replacement_${randomUUID().slice(0, 12)}`;
    const replacementCharge = `ch_confirm_replacement_${randomUUID().slice(0, 12)}`;
    await trx('invoices').where({ id: sale.invoiceId }).update({
      status: 'overdue',
      paid_at: null,
      stripe_payment_intent_id: replacementPi,
      stripe_charge_id: null,
    });
    const intent = succeededIntent({ invoiceId: sale.invoiceId, paymentIntentId: replacementPi, chargeId: replacementCharge });
    mockSucceededCard(intent);

    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewConnections = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      if (invoiceId === sale.invoiceId) reviewConnections.push(conn.isTransaction === true);
      return realReconcile(conn, invoiceId);
    });
    await require('../services/stripe').confirmInvoicePayment(sale.invoiceId, replacementPi);

    expect(reviewConnections).toContain(true);
    let episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(2);
    expect(episodes.find((row) => row.id === returnedEpisode.id)).toEqual(expect.objectContaining({
      resolved_at: expect.any(Date),
      payload: expect.objectContaining({ superseded_at: expect.any(String) }),
    }));
    const restoredEpisode = episodes.find((row) => row.id !== returnedEpisode.id);
    expect(restoredEpisode).toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.objectContaining({ paymentRestored: true }),
    }));

    await webhook._handleChargeRefunded(fullRefund({
      chargeId: replacementCharge,
      paymentIntentId: replacementPi,
      refundId: `re_replacement_${randomUUID().slice(0, 12)}`,
      amountCents: 5500,
    }));
    episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(3);
    expect(episodes.find((row) => row.id === restoredEpisode.id))
      .toEqual(expect.objectContaining({ resolved_at: expect.any(Date) }));
    expect(episodes.find((row) => ![returnedEpisode.id, restoredEpisode.id].includes(row.id)))
      .toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.not.objectContaining({ paymentRestored: true }),
      }));
  });

  test('webhook first-delivery settlement records restoration inside its transaction', async () => {
    const customerId = await seedCustomer();
    const originalPi = `pi_webhook_original_${randomUUID().slice(0, 12)}`;
    const originalCharge = `ch_webhook_original_${randomUUID().slice(0, 12)}`;
    const sale = await seedSale({ customerId, paymentIntentId: originalPi, chargeId: originalCharge });
    await seedPayment(sale, {
      paymentIntentId: originalPi,
      chargeId: originalCharge,
      metadata: { invoice_id: sale.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    const webhook = require('../routes/stripe-webhook');
    const returnedEpisode = await refundAndAcknowledge(webhook, sale, {
      paymentIntentId: originalPi, chargeId: originalCharge,
    });

    const replacementPi = `pi_webhook_replacement_${randomUUID().slice(0, 12)}`;
    const replacementCharge = `ch_webhook_replacement_${randomUUID().slice(0, 12)}`;
    await trx('invoices').where({ id: sale.invoiceId }).update({
      status: 'overdue',
      paid_at: null,
      stripe_payment_intent_id: replacementPi,
      stripe_charge_id: null,
    });
    const intent = succeededIntent({ invoiceId: sale.invoiceId, paymentIntentId: replacementPi, chargeId: replacementCharge });
    mockSucceededCard(intent);

    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewConnections = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      if (invoiceId === sale.invoiceId) reviewConnections.push(conn.isTransaction === true);
      return realReconcile(conn, invoiceId);
    });
    await webhook._handlePaymentIntentSucceeded(intent, Math.floor(Date.now() / 1000));

    expect(reviewConnections).toContain(true);
    const episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(2);
    expect(episodes.find((row) => row.id === returnedEpisode.id))
      .toEqual(expect.objectContaining({ resolved_at: expect.any(Date) }));
    expect(episodes.find((row) => row.id !== returnedEpisode.id)).toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.objectContaining({ paymentRestored: true }),
    }));
  });

  test('ambiguous saved-card credit recovery stamps its source, resolves its attempt, and replays once', async () => {
    const customerId = await seedCustomer();
    const originalPi = `pi_saved_credit_original_${randomUUID().slice(0, 12)}`;
    const originalCharge = `ch_saved_credit_original_${randomUUID().slice(0, 12)}`;
    const sale = await seedSale({ customerId, paymentIntentId: originalPi, chargeId: originalCharge });
    await seedPayment(sale, {
      paymentIntentId: originalPi,
      chargeId: originalCharge,
      metadata: { invoice_id: sale.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    const webhook = require('../routes/stripe-webhook');
    const returnedEpisode = await refundAndAcknowledge(webhook, sale, {
      paymentIntentId: originalPi,
      chargeId: originalCharge,
    });

    await require('../services/customer-credit').postCreditMovement({
      customerId,
      delta: 15,
      source: 'manual',
      note: 'Synthetic saved-card recovery funding',
      createdBy: 'synthetic',
    }, trx);
    await trx('invoices').where({ id: sale.invoiceId }).update({
      status: 'sent',
      paid_at: null,
      payment_recorded_at: null,
      stripe_payment_intent_id: null,
      stripe_charge_id: null,
      credit_applied: 0,
      total: 55,
    });

    const attemptId = randomUUID();
    const replacementPi = `pi_saved_credit_recovery_${randomUUID().slice(0, 12)}`;
    const replacementCharge = `ch_saved_credit_recovery_${randomUUID().slice(0, 12)}`;
    const paymentMethodId = `pm_saved_credit_${randomUUID().slice(0, 12)}`;
    await trx('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: sale.invoiceId,
      stripe_payment_method_id: paymentMethodId,
      idempotency_key: `synthetic-saved-credit:${attemptId}`,
      status: 'ambiguous',
      stripe_payment_intent_id: replacementPi,
      amount: 40,
      credit_applied_delta: 15,
      credit_applied_total: 15,
      error_message: 'Synthetic timeout after Stripe accepted the charge',
      resolved_at: null,
    });
    const intent = {
      id: replacementPi,
      status: 'succeeded',
      amount: 4000,
      amount_received: 4000,
      latest_charge: replacementCharge,
      payment_method: paymentMethodId,
      payment_method_types: ['card'],
      metadata: {
        saved_card_attempt_id: attemptId,
        waves_invoice_id: sale.invoiceId,
        waves_customer_id: customerId,
        source: 'admin_card_on_file',
        base_amount: '40',
        card_surcharge: '0',
        surcharge_policy_version: 'synthetic-debit-v1',
      },
    };
    mockSucceededCard(intent);

    const review = require('../services/commercial-prepay-dispatch-review');
    const realReconcile = review.reconcileInvoice;
    const reviewConnections = [];
    jest.spyOn(review, 'reconcileInvoice').mockImplementation(async (conn, invoiceId) => {
      if (invoiceId === sale.invoiceId) reviewConnections.push(conn.isTransaction === true);
      return realReconcile(conn, invoiceId);
    });

    await webhook._handlePaymentIntentSucceeded(intent, Math.floor(Date.now() / 1000));

    expect(reviewConnections).toContain(true);
    await expect(trx('invoices').where({ id: sale.invoiceId }).first())
      .resolves.toMatchObject({
        status: 'paid',
        stripe_payment_intent_id: replacementPi,
        stripe_charge_id: replacementCharge,
        credit_applied: '15.00',
      });
    await expect(trx('stripe_invoice_charge_attempts').where({ id: attemptId }).first())
      .resolves.toMatchObject({
        status: 'succeeded',
        stripe_payment_intent_id: replacementPi,
        amount: '40.00',
        resolved_at: expect.any(Date),
      });
    const [replacement] = await trx('payments')
      .where({ stripe_payment_intent_id: replacementPi });
    expect(replacement).toMatchObject({
      customer_id: customerId,
      payer_id: null,
      status: 'paid',
      amount: '40.00',
      base_amount_cents: 4000,
      metadata: expect.objectContaining({
        invoice_id: sale.invoiceId,
        source: 'admin_card_on_file',
      }),
    });
    await expect(trx('customer_credit_ledger').where({ invoice_id: sale.invoiceId }))
      .resolves.toEqual([
        expect.objectContaining({
          customer_id: customerId,
          delta: '-15.00',
          note: `Account credit consumed by reconciled saved-card attempt ${attemptId}`,
        }),
      ]);
    let episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(2);
    expect(episodes.find((row) => row.id === returnedEpisode.id))
      .toEqual(expect.objectContaining({ resolved_at: expect.any(Date) }));
    expect(episodes.find((row) => row.id !== returnedEpisode.id)).toEqual(expect.objectContaining({
      resolved_at: null,
      payload: expect.objectContaining({ paymentRestored: true }),
    }));

    await webhook._handlePaymentIntentSucceeded(intent, Math.floor(Date.now() / 1000));
    await expect(trx('payments').where({ stripe_payment_intent_id: replacementPi }))
      .resolves.toHaveLength(1);
    await expect(trx('customer_credit_ledger').where({ invoice_id: sale.invoiceId }))
      .resolves.toHaveLength(1);
    episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(2);
    expect(episodes.filter((row) => row.payload.paymentRestored === true)).toHaveLength(1);
  });

  test('a wrong-payer processing row cannot create a restored review during webhook settlement', async () => {
    const customerId = await seedCustomer();
    const originalPi = `pi_wrong_payer_original_${randomUUID().slice(0, 12)}`;
    const originalCharge = `ch_wrong_payer_original_${randomUUID().slice(0, 12)}`;
    const sale = await seedSale({ customerId, paymentIntentId: originalPi, chargeId: originalCharge });
    await seedPayment(sale, {
      paymentIntentId: originalPi,
      chargeId: originalCharge,
      metadata: { invoice_id: sale.invoiceId, base_amount: 55, card_surcharge: 0 },
    });
    const webhook = require('../routes/stripe-webhook');
    const returnedEpisode = await refundAndAcknowledge(webhook, sale, {
      paymentIntentId: originalPi, chargeId: originalCharge,
    });

    const [wrongPayer] = await trx('payers').insert({
      display_name: 'Synthetic Wrong AP',
      payment_terms: 'net30',
    }).returning('*');
    const replacementPi = `pi_wrong_payer_replacement_${randomUUID().slice(0, 12)}`;
    const replacementCharge = `ch_wrong_payer_replacement_${randomUUID().slice(0, 12)}`;
    await trx('invoices').where({ id: sale.invoiceId }).update({
      status: 'processing',
      paid_at: null,
      stripe_payment_intent_id: replacementPi,
      stripe_charge_id: replacementCharge,
    });
    await seedPayment(sale, {
      paymentIntentId: replacementPi,
      chargeId: replacementCharge,
      payerId: wrongPayer.id,
      status: 'processing',
      metadata: {
        invoice_id: sale.invoiceId,
        payer_id: wrongPayer.id,
        base_amount: 55,
        card_surcharge: 0,
        payment_state: 'processing',
      },
    });
    const intent = succeededIntent({ invoiceId: sale.invoiceId, paymentIntentId: replacementPi, chargeId: replacementCharge });
    mockSucceededCard(intent);
    await webhook._handlePaymentIntentSucceeded(intent, Math.floor(Date.now() / 1000));

    const episodes = await reviews(sale.invoiceId);
    expect(episodes).toHaveLength(1);
    expect(episodes.find((row) => row.id === returnedEpisode.id)).toEqual(expect.objectContaining({
      resolved_at: expect.any(Date),
      payload: expect.not.objectContaining({ paymentRestored: true }),
    }));
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
