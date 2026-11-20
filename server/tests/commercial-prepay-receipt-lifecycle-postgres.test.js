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
  });
  if (unbookedSale) await require('../services/commercial-prepay-sale-record').recordUnbookedSale(trx, {
    invoiceId: ids.invoiceId, estimateId: ids.estimateId, customerId: ids.customerId, setupAmount: 55,
  });
  return ids;
}

async function insertCardPayment(ids, {
  paymentIntentId,
  chargeId = null,
  status = 'paid',
  refundStatus = null,
  refundAmount = 0,
  amount = 55,
  baseCents = 5500,
  surchargeCents = 0,
  refundedBaseCents = 0,
  refundedSurchargeCents = 0,
  invoiceId = null,
  payerId = null,
  metadata = {},
  createdAt = new Date(),
} = {}) {
  const [row] = await trx('payments').insert({
    customer_id: ids.customerId,
    payer_id: payerId,
    payment_date: etDateString(),
    amount,
    base_amount_cents: baseCents,
    surcharge_amount_cents: surchargeCents,
    refunded_base_cents: refundedBaseCents,
    refunded_surcharge_cents: refundedSurchargeCents,
    status,
    refund_status: refundStatus,
    refund_amount: refundAmount,
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: chargeId,
    processor: 'stripe',
    description: 'Synthetic commercial prepay receipt',
    metadata: { ...metadata, ...(invoiceId ? { invoice_id: invoiceId } : {}) },
    created_at: createdAt,
  }).returning('*');
  return row;
}

async function insertSavedCardAttempt(ids, {
  invoiceId = ids.invoiceId,
  paymentIntentId,
  status = 'succeeded',
  creditDelta = 15,
} = {}) {
  const attemptId = randomUUID();
  await trx('stripe_invoice_charge_attempts').insert({
    id: attemptId,
    invoice_id: invoiceId,
    stripe_payment_method_id: `pm_receipt_${attemptId.slice(0, 12)}`,
    idempotency_key: `receipt-proof:${attemptId}`,
    status,
    stripe_payment_intent_id: paymentIntentId,
    credit_applied_delta: creditDelta,
    credit_applied_total: creditDelta,
    resolved_at: new Date(),
  });
  return attemptId;
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
    // A later booking's refund can consume the claim and restore the setup
    // to a visit. Both receipt episodes still belong to this original sale.
    await trx('setup_fee_claims').where({ invoice_id: ids.invoiceId }).delete();
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
      invoiceId: ids.invoiceId, estimateId: ids.estimateId, amount: 55,
    });
    await expect(require('../services/commercial-prepay-dispatch-review').reconcileInvoice(trx, ids.invoiceId))
      .resolves.toBeNull();
    expect(await reviews(ids.invoiceId)).toHaveLength(0);
  });

  test.each(['estimateId', 'customerId'])('a sale record referring to another %s cannot open a card', async (field) => {
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

  test('an owner mismatch is accepted only through the active merge journal row that names this invoice', async () => {
    const pi = `pi_merged_sale_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'refunded', paymentIntentId: pi });
    await insertCardPayment(ids, {
      paymentIntentId: pi, status: 'refunded', refundStatus: 'full', refundAmount: 55,
      invoiceId: ids.invoiceId,
    });
    const winnerId = randomUUID();
    await trx('customers').insert({
      id: winnerId,
      first_name: 'Synthetic',
      last_name: 'Merge Winner',
      phone: `+1202555${String(parseInt(winnerId.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
      property_type: 'commercial',
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({ customer_id: winnerId });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ customer_id: winnerId });
    await trx('estimates').where({ id: ids.estimateId }).update({ customer_id: winnerId });
    await trx('payments').where({ stripe_payment_intent_id: pi }).update({ customer_id: winnerId });

    const saleRecord = require('../services/commercial-prepay-sale-record');
    await expect(saleRecord.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();

    const loser = await trx('customers').where({ id: ids.customerId }).first();
    const [journal] = await trx('customer_merge_journal').insert({
      winner_customer_id: winnerId,
      loser_customer_id: ids.customerId,
      loser_snapshot: loser,
      repointed: {},
      repointed_ids: { version: 1, tables: { 'annual_prepay_terms.customer_id': [ids.termId] } },
      winner_backfills: {},
      tier: 'manual',
      evidence: { synthetic: true },
      performed_by: 'test:commercial-prepay-merge',
      created_at: trx.raw('clock_timestamp()'),
    }).returning('*');
    // The pair really merged, but this journal does not claim the invoice.
    await expect(saleRecord.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();

    await trx('customer_merge_journal').where({ id: journal.id }).update({
      repointed_ids: {
        version: 1,
        tables: {
          'invoices.customer_id': [ids.invoiceId],
          'annual_prepay_terms.customer_id': [ids.termId],
        },
      },
    });
    await expect(saleRecord.findUnbookedSale(trx, ids.invoiceId)).resolves.toMatchObject({
      invoice: { id: ids.invoiceId, customer_id: winnerId },
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    expect(await reviews(ids.invoiceId)).toEqual([
      expect.objectContaining({
        resolved_at: null,
        payload: expect.objectContaining({ sourceInvoiceId: ids.invoiceId, customerId: winnerId }),
      }),
    ]);

    await trx('customer_merge_journal').where({ id: journal.id }).update({ undone_at: trx.fn.now() });
    await expect(saleRecord.findUnbookedSale(trx, ids.invoiceId)).resolves.toBeNull();
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
      stripe_charge_id: chargeId,
    });
    await require('../services/invoice-manual-payment').recordManualPayment(ids.invoiceId, {
      method: 'cash',
      recordedBy: 'Synthetic Office Writer',
      sendReceipt: false,
    });

    const repaid = await trx('invoices').where({ id: ids.invoiceId }).first();
    expect(repaid).toMatchObject({ status: 'paid', payment_method: 'cash', stripe_charge_id: chargeId, stripe_payment_intent_id: null });
    const review = require('../services/commercial-prepay-dispatch-review');
    await expect(review.readReceiptState(trx, repaid)).resolves.toBe('active');
    const damaged = await trx.transaction();
    try {
      const { MANUAL_PAYMENT_RECORDED_ACTION } = require('../services/invoice-manual-payment');
      await damaged('audit_log').where({ action: MANUAL_PAYMENT_RECORDED_ACTION, resource_id: ids.invoiceId }).del();
      await expect(review.readReceiptState(damaged, repaid)).resolves.not.toBe('active');
    } finally {
      await damaged.rollback();
    }

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

  test('an unresolved combined partial dispute keeps a later replacement receipt unconfirmed', async () => {
    const pi = `pi_combined_dispute_${randomUUID().slice(0, 12)}`;
    const chargeId = `ch_combined_dispute_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'paid', paymentIntentId: pi });
    await trx('invoices').where({ id: ids.invoiceId }).update({ stripe_charge_id: chargeId });
    await insertCardPayment(ids, {
      paymentIntentId: pi,
      chargeId,
      invoiceId: ids.invoiceId,
      metadata: { combined_payment: true, source: 'combined_payment' },
    });
    const [partialCase] = await trx('stripe_orphan_charges').insert({
      stripe_payment_intent_id: `${pi}:partial-dispute:${randomUUID()}`,
      stripe_charge_id: chargeId,
      customer_id: ids.customerId,
      invoice_id: null,
      amount: 10,
      source: 'combined_pay_webhook',
      original_db_error: 'Synthetic unattributed combined partial dispute',
    }).returning('*');
    const review = require('../services/commercial-prepay-dispatch-review');
    const invoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    await expect(review.readReceiptState(trx, invoice)).resolves.toBe('unconfirmed');

    await trx('stripe_orphan_charges').where({ id: partialCase.id }).update({
      resolved: true,
      resolved_at: new Date(),
      resolution_notes: 'Synthetic operator allocation complete',
    });
    await expect(review.readReceiptState(trx, invoice)).resolves.toBe('active');
  });

  test.each([
    ['payment split', { surchargeCents: 1 }],
    ['refund split', {
      status: 'refunded', refundStatus: 'full', refundAmount: 55, refundedBaseCents: 5499,
    }],
    ['fractional-cent metadata split', {
      baseCents: null,
      surchargeCents: null,
      metadata: { base_amount: 54.999, card_surcharge: 0.001 },
    }],
  ])('an inexact %s is unconfirmed', async (_label, payment) => {
    const pi = `pi_cent_mismatch_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: payment.status || 'paid', paymentIntentId: pi });
    await insertCardPayment(ids, { paymentIntentId: pi, ...payment });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
      .resolves.toBe('unconfirmed');
  });

  test.each([
    ['reserved by attempt', ({ attemptId }) => `Account credit reserved for saved-card reconciliation attempt ${attemptId}`],
    ['reserved by orphan PI', ({ paymentIntentId }) => `Account credit reserved for saved-card reconciliation orphan PI ${paymentIntentId}`],
    ['consumed on reconciled success', ({ attemptId }) => `Account credit consumed by reconciled saved-card attempt ${attemptId}`],
    ['consumed while processing', ({ attemptId }) => `Account credit consumed by processing saved-card attempt ${attemptId}`],
  ])('a saved-card credit %s is accepted with its exact settled evidence', async (_label, noteFor) => {
    const paymentIntentId = `pi_saved_credit_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'paid', paymentIntentId });
    await trx('invoices').where({ id: ids.invoiceId }).update({ credit_applied: 15 });
    await insertCardPayment(ids, {
      paymentIntentId,
      amount: 40,
      baseCents: 4000,
      invoiceId: ids.invoiceId,
      metadata: { source: 'admin_card_on_file' },
    });
    const attemptId = await insertSavedCardAttempt(ids, { paymentIntentId });
    await trx('customer_credit_ledger').insert({
      customer_id: ids.customerId,
      invoice_id: ids.invoiceId,
      delta: -15,
      balance_after: 0,
      source: 'adjustment',
      note: noteFor({ attemptId, paymentIntentId }),
      created_by: 'system:saved_card_reconciliation',
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
      .resolves.toBe('active');
  });

  test.each(['attempt', 'invoice', 'payer', 'amount'])(
    'saved-card credit with mismatched %s evidence stays unconfirmed',
    async (mismatch) => {
      const paymentIntentId = `pi_saved_mismatch_${randomUUID().slice(0, 12)}`;
      const ids = await seedOriginal({ status: 'paid', paymentIntentId });
      await trx('invoices').where({ id: ids.invoiceId }).update({ credit_applied: 15 });
      await insertCardPayment(ids, {
        paymentIntentId,
        amount: 40,
        baseCents: 4000,
        invoiceId: ids.invoiceId,
        metadata: {
          source: 'admin_card_on_file',
          ...(mismatch === 'payer' ? { payer_id: randomUUID() } : {}),
        },
      });
      let attemptInvoiceId = ids.invoiceId;
      if (mismatch === 'invoice') {
        const other = await seedOriginal({ status: 'paid', paymentIntentId: null });
        attemptInvoiceId = other.invoiceId;
      }
      const attemptId = await insertSavedCardAttempt(ids, {
        invoiceId: attemptInvoiceId,
        paymentIntentId,
      });
      await trx('customer_credit_ledger').insert({
        customer_id: ids.customerId,
        invoice_id: ids.invoiceId,
        delta: mismatch === 'amount' ? -14.99 : -15,
        balance_after: 0,
        source: 'adjustment',
        note: `Account credit reserved for saved-card reconciliation attempt ${
          mismatch === 'attempt' ? randomUUID() : attemptId
        }`,
        created_by: 'system:saved_card_reconciliation',
      });
      await expect(require('../services/commercial-prepay-dispatch-review')
        .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
        .resolves.toBe('unconfirmed');
    },
  );

  test.each([
    ['foreign payer', async (ids, paymentIntentId) => {
      const [payer] = await trx('payers').insert({
        display_name: 'Synthetic Foreign AP',
        payment_terms: 'net30',
      }).returning('*');
      await insertCardPayment(ids, {
        paymentIntentId,
        amount: 40,
        baseCents: 4000,
        invoiceId: ids.invoiceId,
        payerId: payer.id,
        metadata: { source: 'admin_card_on_file', payer_id: payer.id },
      });
    }],
    ['partial cash amount', async (ids, paymentIntentId) => {
      await insertCardPayment(ids, {
        paymentIntentId,
        amount: 39,
        baseCents: 3900,
        invoiceId: ids.invoiceId,
        metadata: { source: 'admin_card_on_file' },
      });
    }],
  ])('saved-card credit cannot use a %s payment as settled evidence', async (_label, insertPayment) => {
    const paymentIntentId = `pi_saved_unproven_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'paid', paymentIntentId });
    await trx('invoices').where({ id: ids.invoiceId }).update({ credit_applied: 15 });
    await insertPayment(ids, paymentIntentId);
    const attemptId = await insertSavedCardAttempt(ids, { paymentIntentId });
    await trx('customer_credit_ledger').insert({
      customer_id: ids.customerId,
      invoice_id: ids.invoiceId,
      delta: -15,
      balance_after: 0,
      source: 'adjustment',
      note: `Account credit consumed by reconciled saved-card attempt ${attemptId}`,
      created_by: 'system:saved_card_reconciliation',
    });
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
      .resolves.toBe('unconfirmed');
  });

  test('an exact failed saved-card reservation and release does not poison later credit proof', async () => {
    const paymentIntentId = `pi_saved_failed_${randomUUID().slice(0, 12)}`;
    const ids = await seedOriginal({ status: 'prepaid', paymentIntentId: null });
    await trx('invoices').where({ id: ids.invoiceId }).update({ credit_applied: 55 });
    const attemptId = await insertSavedCardAttempt(ids, {
      paymentIntentId,
      status: 'failed',
    });
    const startedAt = new Date(Date.now() - 120_000);
    await trx('customer_credit_ledger').insert([
      {
        customer_id: ids.customerId,
        invoice_id: ids.invoiceId,
        delta: -15,
        balance_after: 0,
        source: 'adjustment',
        note: `Account credit reserved for saved-card reconciliation attempt ${attemptId}`,
        created_by: 'system:saved_card_reconciliation',
        created_at: startedAt,
      },
      {
        customer_id: ids.customerId,
        invoice_id: ids.invoiceId,
        delta: 15,
        balance_after: 15,
        source: 'adjustment',
        note: `Account credit released after failed saved-card attempt ${attemptId}`,
        created_by: 'system:saved_card_reconciliation',
        created_at: new Date(startedAt.getTime() + 30_000),
      },
      {
        customer_id: ids.customerId,
        invoice_id: ids.invoiceId,
        delta: -55,
        balance_after: 0,
        source: 'invoice_prepaid',
        note: 'Synthetic later prepaid settlement',
        created_by: 'synthetic',
        created_at: new Date(startedAt.getTime() + 60_000),
      },
    ]);
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, await trx('invoices').where({ id: ids.invoiceId }).first()))
      .resolves.toBe('active');
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

  test('normal void proves only an exact invoice-specific full credit-only return', async () => {
    const ids = await seedOriginal({ status: 'sent', paymentIntentId: null });
    await trx('invoices').where({ id: ids.invoiceId }).update({
      payment_recorded_at: null,
      paid_at: null,
    });
    await require('../services/customer-credit').postCreditMovement({
      customerId: ids.customerId,
      delta: 55,
      source: 'manual',
      note: 'Synthetic credit-only void funding',
      createdBy: 'synthetic',
    }, trx);
    await expect(require('../services/customer-credit').applyAccountCreditToInvoice({
      invoiceId: ids.invoiceId,
      createdBy: 'synthetic',
      customerRequested: true,
    }, trx)).resolves.toMatchObject({ applied: 55, fullyCovered: true, status: 'prepaid' });

    await expect(require('../services/invoice').voidInvoice(ids.invoiceId))
      .resolves.toMatchObject({ id: ids.invoiceId, status: 'void' });
    const review = require('../services/commercial-prepay-dispatch-review');
    const voided = await trx('invoices').where({ id: ids.invoiceId }).first();
    await expect(review.readReceiptState(trx, voided)).resolves.toBe('cancelled');
    await expect(reviews(ids.invoiceId)).resolves.toEqual([
      expect.objectContaining({
        resolved_at: null,
        payload: expect.objectContaining({
          sourceInvoiceId: ids.invoiceId,
          customerId: ids.customerId,
          amount: 55,
        }),
      }),
    ]);

    const movements = await trx('customer_credit_ledger')
      .where({ invoice_id: ids.invoiceId })
      .orderBy('id', 'asc');
    expect(movements).toHaveLength(2);
    expect(movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ delta: '-55.00', source: 'invoice_application' }),
      expect.objectContaining({
        delta: '55.00',
        source: 'adjustment',
        note: `Account credit returned — invoice ${voided.invoice_number} voided`,
      }),
    ]));
    const applicationId = movements.find((row) => Number(row.delta) < 0).id;
    const returnId = movements.find((row) => Number(row.delta) > 0).id;

    const otherInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: otherInvoiceId,
      token: randomUUID(),
      invoice_number: `OTHER-${otherInvoiceId.slice(0, 8)}`,
      customer_id: ids.customerId,
      title: 'Synthetic other invoice',
      status: 'void',
      subtotal: 1,
      total: 1,
      due_date: etDateString(),
      line_items: JSON.stringify(setupLine(1)),
    });
    const [payer] = await trx('payers').insert({
      display_name: 'Synthetic Void AP',
      payment_terms: 'net30',
    }).returning('*');

    async function expectDamagedProofUnconfirmed(mutate) {
      const attempt = await trx.transaction();
      try {
        await mutate(attempt);
        const damaged = await attempt('invoices').where({ id: ids.invoiceId }).first();
        await expect(review.readReceiptState(attempt, damaged)).resolves.toBe('unconfirmed');
      } finally {
        await attempt.rollback();
      }
    }

    await expectDamagedProofUnconfirmed(async (attempt) => {
      await attempt('customer_credit_ledger').where({ id: applicationId }).update({ delta: -54 });
      await attempt('customer_credit_ledger').where({ id: returnId }).update({ delta: 54 });
    });
    await expectDamagedProofUnconfirmed((attempt) =>
      attempt('customer_credit_ledger').where({ id: returnId }).update({ invoice_id: otherInvoiceId }));
    await expectDamagedProofUnconfirmed((attempt) =>
      attempt('invoices').where({ id: ids.invoiceId }).update({ payer_id: payer.id }));
    await expectDamagedProofUnconfirmed((attempt) =>
      attempt('invoices').where({ id: ids.invoiceId }).update({
        line_items: JSON.stringify([
          ...setupLine(),
          {
            description: 'Synthetic deposit credit',
            quantity: 1,
            unit_price: -1,
            amount: -1,
            category: 'deposit_credit',
            estimate_id: ids.estimateId,
          },
        ]),
      }));
    await expectDamagedProofUnconfirmed(async (attempt) => {
      const paymentIntentId = `pi_mixed_void_${randomUUID().slice(0, 12)}`;
      await attempt('invoices').where({ id: ids.invoiceId })
        .update({ stripe_payment_intent_id: paymentIntentId });
      await attempt('payments').insert({
        customer_id: ids.customerId,
        payment_date: etDateString(),
        amount: 1,
        base_amount_cents: 100,
        surcharge_amount_cents: 0,
        status: 'paid',
        stripe_payment_intent_id: paymentIntentId,
        processor: 'stripe',
        description: 'Synthetic mixed credit/card receipt',
        metadata: { invoice_id: ids.invoiceId },
      });
    });
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
