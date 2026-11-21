'use strict';

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
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/notification-service', () => ({
  create: jest.fn(async () => ({ id: 'synthetic-notification' })),
  notifyAdmin: jest.fn(async () => {}),
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

jest.setTimeout(120000);

function invoiceLines(estimateId, { subtotal = 55, deposit = 15 } = {}) {
  return [
    {
      description: 'Bait Station Setup — one-time setup fee',
      quantity: 1,
      unit_price: subtotal,
      amount: subtotal,
      category: 'Setup fee',
    },
    {
      description: 'Deposit credit (paid at acceptance)',
      quantity: 1,
      unit_price: -deposit,
      amount: -deposit,
      category: 'deposit_credit',
      estimate_id: estimateId,
    },
  ];
}

async function seedOriginal({
  subtotal = 55,
  depositCredit = 15,
  depositAmount = depositCredit,
  depositStatus = 'credited',
  depositBound = true,
  withDeposit = true,
  recordSale = true,
  status = 'paid',
  withPayment = true,
} = {}) {
  const ids = {
    customerId: randomUUID(),
    estimateId: randomUUID(),
    invoiceId: randomUUID(),
    termId: randomUUID(),
    paymentId: randomUUID(),
    paymentIntentId: `pi_deposit_proof_${randomUUID().replaceAll('-', '').slice(0, 18)}`,
  };
  const cardAmount = subtotal - depositCredit;
  await trx('customers').insert({
    id: ids.customerId,
    first_name: 'Synthetic',
    last_name: 'Deposit Proof',
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
    invoice_number: `DEP-${ids.invoiceId.slice(0, 8)}`,
    customer_id: ids.customerId,
    title: 'Commercial Rodent Bait Stations — Annual Prepay',
    status,
    paid_at: status === 'paid' ? new Date() : null,
    payment_recorded_at: withPayment ? new Date() : null,
    stripe_payment_intent_id: withPayment ? ids.paymentIntentId : null,
    subtotal,
    total: cardAmount,
    due_date: etDateString(),
    line_items: JSON.stringify(invoiceLines(ids.estimateId, { subtotal, deposit: depositCredit })),
  });
  await trx('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: ids.customerId,
    prepay_invoice_id: ids.invoiceId,
    source_estimate_id: ids.estimateId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: 55,
    prepay_amount: subtotal,
    term_start: etDateString(),
    term_end: '2099-12-31',
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
  });
  if (recordSale) {
    await require('../services/commercial-prepay-sale-record').recordUnbookedSale(trx, {
      invoiceId: ids.invoiceId,
      customerId: ids.customerId,
      estimateId: ids.estimateId,
      setupAmount: 55,
    });
  }
  if (withPayment) {
    await trx('payments').insert({
      id: ids.paymentId,
      customer_id: ids.customerId,
      payment_date: etDateString(),
      amount: cardAmount,
      base_amount_cents: cardAmount * 100,
      surcharge_amount_cents: 0,
      status: 'paid',
      refund_amount: 0,
      stripe_payment_intent_id: ids.paymentIntentId,
      processor: 'stripe',
      description: 'Synthetic deposit/card receipt',
      metadata: { invoice_id: ids.invoiceId },
      created_at: new Date(Date.now() - 60_000),
    });
  }
  if (withDeposit) {
    const [deposit] = await trx('estimate_deposits').insert({
      estimate_id: ids.estimateId,
      customer_id: ids.customerId,
      amount: depositAmount,
      credited_amount: depositCredit,
      refunded_amount: 0,
      status: depositStatus,
      stripe_payment_intent_id: `pi_original_deposit_${randomUUID().replaceAll('-', '').slice(0, 18)}`,
      credited_invoice_id: depositBound ? ids.invoiceId : null,
    }).returning('id');
    ids.depositId = deposit.id;
  }
  return { ...ids, cardAmount, subtotal, depositCredit };
}

async function stampFullCardRefund(ids, conn = trx) {
  await conn('payments').where({ id: ids.paymentId }).update({
    status: 'refunded',
    refund_status: 'full',
    refund_amount: ids.cardAmount,
    updated_at: conn.fn.now(),
  });
  return require('../services/customer-credit').returnAppliedCreditOnRefund({
    invoiceId: ids.invoiceId,
    createdBy: 'system:synthetic_refund',
  }, conn);
}

function reviews(invoiceId) {
  return trx('dispatch_alerts')
    .where({ type: 'commercial_prepay_setup_review' })
    .whereRaw("payload->>'sourceInvoiceId' = ?", [String(invoiceId)])
    .orderBy('created_at', 'asc');
}

postgres('commercial prepay deposit/card refund proof', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Deposit refund proof tests require a private local waves_qa_<32 hex> database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
    require('../services/annual-prepay-renewals');
    require('../services/customer-credit');
    require('../services/commercial-prepay-dispatch-review');
  }, 240000);

  beforeEach(async () => {
    trx = await database.transaction();
    mockPg = trx;
  });

  afterEach(async () => {
    if (trx && !(typeof trx.isCompleted === 'function' && trx.isCompleted())) await trx.rollback();
    trx = null;
  });

  afterAll(async () => database?.destroy());

  test('an exact bound deposit return plus its card refund creates one review and rolls back atomically', async () => {
    const ids = await seedOriginal();

    await expect(trx.transaction(async (attempt) => {
      await stampFullCardRefund(ids, attempt);
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    await expect(trx('invoices').where({ id: ids.invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'paid' });
    await expect(trx('estimate_deposits').where({ id: ids.depositId }).first())
      .resolves.toMatchObject({ status: 'credited', credited_invoice_id: ids.invoiceId });
    await expect(trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: ids.invoiceId,
    })).resolves.toHaveLength(0);

    await stampFullCardRefund(ids);
    const deposit = await trx('estimate_deposits').where({ id: ids.depositId }).first();
    expect(deposit).toMatchObject({ status: 'received', credited_invoice_id: null });
    expect(Number(deposit.credited_amount)).toBe(0);
    const [evidence] = await trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_type: 'invoices', resource_id: ids.invoiceId,
    });
    expect(evidence.metadata).toEqual(expect.objectContaining({
      version: 2,
      invoiceId: ids.invoiceId,
      customerId: ids.customerId,
      terminalStatus: 'refunded',
      terminalUpdatedAtMs: expect.any(Number),
      requestedCents: 1500,
      restoredCents: 1500,
      allocations: [{ depositId: ids.depositId, estimateId: ids.estimateId, returnedCents: 1500 }],
    }));

    const review = require('../services/commercial-prepay-dispatch-review');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('cancelled');
    const rows = await reviews(ids.invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(expect.objectContaining({
      sourceInvoiceId: ids.invoiceId,
      customerId: ids.customerId,
      estimateId: ids.estimateId,
      amount: 55,
    }));
  });

  test('an ordinary exact deposit return succeeds without Dispatch proof evidence', async () => {
    const ids = await seedOriginal({ recordSale: false });
    const saleRecords = require('../services/commercial-prepay-sale-record');
    await expect(saleRecords.hasRecordedUnbookedSale(trx, ids.invoiceId)).resolves.toBe(false);
    const lookup = jest.spyOn(saleRecords, 'hasRecordedUnbookedSale')
      .mockImplementationOnce((conn) => conn.raw('SELECT * FROM dispatch_optional_lookup_must_not_exist'));
    try {
      await expect(trx.transaction((attempt) => stampFullCardRefund(ids, attempt)))
        .resolves.toEqual(expect.any(Object));
    } finally {
      lookup.mockRestore();
    }
    await expect(trx('invoices').where({ id: ids.invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'refunded' });
    const deposit = await trx('estimate_deposits').where({ id: ids.depositId }).first();
    expect(deposit).toMatchObject({ status: 'received', credited_invoice_id: null });
    expect(Number(deposit.credited_amount)).toBe(0);
    await expect(trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: ids.invoiceId,
    })).resolves.toHaveLength(0);
  });

  test('the normal void entry point creates one review for an exact deposit-only return', async () => {
    const ids = await seedOriginal({
      subtotal: 55,
      depositCredit: 55,
      status: 'prepaid',
      withPayment: false,
    });
    await expect(trx.transaction(async (attempt) => {
      const parent = mockPg;
      mockPg = attempt;
      try {
        await expect(require('../services/invoice').voidInvoice(ids.invoiceId))
          .resolves.toMatchObject({ id: ids.invoiceId, status: 'void' });
        const rows = await attempt('dispatch_alerts')
          .where({ type: 'commercial_prepay_setup_review' })
          .whereRaw("payload->>'sourceInvoiceId' = ?", [String(ids.invoiceId)]);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toEqual(expect.objectContaining({
          sourceInvoiceId: ids.invoiceId,
          customerId: ids.customerId,
          estimateId: ids.estimateId,
          amount: 55,
        }));
        const review = require('../services/commercial-prepay-dispatch-review');
        await expect(review.reconcileInvoice(attempt, ids.invoiceId)).resolves.toBe('cancelled');
        await expect(review.reconcileInvoice(attempt, ids.invoiceId)).resolves.toBe('cancelled');
        await expect(attempt('dispatch_alerts')
          .where({ type: 'commercial_prepay_setup_review' })
          .whereRaw("payload->>'sourceInvoiceId' = ?", [String(ids.invoiceId)]))
          .resolves.toHaveLength(1);
      } finally {
        mockPg = parent;
      }
      throw new Error('roll back synthetic void');
    })).rejects.toThrow('roll back synthetic void');
    expect(await reviews(ids.invoiceId)).toEqual([]);
    await expect(trx('invoices').where({ id: ids.invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'prepaid' });
    await expect(trx('estimate_deposits').where({ id: ids.depositId }).first())
      .resolves.toMatchObject({ status: 'credited', credited_invoice_id: ids.invoiceId });
  });

  test('a returned deposit with other unpaid principal remains unconfirmed', async () => {
    const ids = await seedOriginal({
      subtotal: 75,
      depositCredit: 55,
      status: 'prepaid',
      withPayment: false,
    });
    const [voided] = await trx('invoices').where({ id: ids.invoiceId })
      .update({ status: 'void', updated_at: trx.fn.now() }).returning('*');
    await require('../services/estimate-deposits')
      .restoreDepositCreditForVoidedInvoice({ invoice: voided, trx });
    const fresh = await trx('invoices').where({ id: ids.invoiceId }).first();
    await expect(require('../services/commercial-prepay-dispatch-review')
      .readReceiptState(trx, fresh)).resolves.toBe('unconfirmed');
    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });

  test('an exact deposit-only return from a prior terminal episode is stale', async () => {
    const ids = await seedOriginal({
      subtotal: 55,
      depositCredit: 55,
      status: 'prepaid',
      withPayment: false,
    });
    const [voided] = await trx('invoices').where({ id: ids.invoiceId })
      .update({ status: 'void', updated_at: trx.fn.now() }).returning('*');
    const review = require('../services/commercial-prepay-dispatch-review');
    const reconcile = jest.spyOn(review, 'reconcileInvoice').mockResolvedValueOnce('cancelled');
    try {
      await require('../services/estimate-deposits')
        .restoreDepositCreditForVoidedInvoice({ invoice: voided, trx });
    } finally {
      reconcile.mockRestore();
    }
    await trx('invoices').where({ id: ids.invoiceId })
      .update({ updated_at: new Date(Date.now() + 60_000) });
    const laterEpisode = await trx('invoices').where({ id: ids.invoiceId }).first();
    await expect(review.readReceiptState(trx, laterEpisode)).resolves.toBe('unconfirmed');
    await expect(review.reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });

  test('a deposit released before this card-refund episode remains unconfirmed', async () => {
    const ids = await seedOriginal();
    const [invoice] = await trx('invoices').where({ id: ids.invoiceId })
      .update({ status: 'void', updated_at: trx.fn.now() }).returning('*');
    await require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice({ invoice, trx });
    const [evidence] = await trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: ids.invoiceId,
    });
    const laterEpisode = new Date(new Date(evidence.created_at).getTime() + 60_000);
    await trx('payments').where({ id: ids.paymentId }).update({
      status: 'refunded', refund_status: 'full', refund_amount: ids.cardAmount,
      created_at: laterEpisode, updated_at: laterEpisode,
    });
    await trx('invoices').where({ id: ids.invoiceId })
      .update({ status: 'refunded', updated_at: laterEpisode });

    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });

  test('an unbound $55 partial allocation from a $75 deposit cannot prove the refund', async () => {
    const ids = await seedOriginal({
      subtotal: 75,
      depositCredit: 55,
      depositAmount: 75,
      depositStatus: 'received',
      depositBound: false,
    });
    await stampFullCardRefund(ids);
    expect(await trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: ids.invoiceId,
    })).toEqual([]);

    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });

  test('a deposit return bound to another invoice cannot prove this invoice refund', async () => {
    const ids = await seedOriginal({ depositStatus: 'received', depositBound: false });
    const otherInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: otherInvoiceId,
      token: randomUUID(),
      invoice_number: `OTHER-${otherInvoiceId.slice(0, 8)}`,
      customer_id: ids.customerId,
      title: 'Other invoice',
      status: 'void',
      paid_at: new Date(),
      subtotal: ids.depositCredit,
      total: 0,
      due_date: etDateString(),
      line_items: JSON.stringify(invoiceLines(ids.estimateId, {
        subtotal: ids.depositCredit, deposit: ids.depositCredit,
      })),
    });
    await require('../services/commercial-prepay-sale-record').recordUnbookedSale(trx, {
      invoiceId: otherInvoiceId,
      customerId: ids.customerId,
      estimateId: ids.estimateId,
      setupAmount: 55,
    });
    await trx('estimate_deposits').where({ id: ids.depositId }).update({
      amount: ids.depositCredit,
      credited_amount: ids.depositCredit,
      status: 'credited',
      credited_invoice_id: otherInvoiceId,
    });
    const other = await trx('invoices').where({ id: otherInvoiceId }).first();
    await require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice({ invoice: other, trx });
    await trx('payments').where({ id: ids.paymentId }).update({
      status: 'refunded', refund_status: 'full', refund_amount: ids.cardAmount,
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'refunded' });
    await expect(trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: otherInvoiceId,
    })).resolves.toHaveLength(1);
    await expect(trx('audit_log').where({
      action: 'invoice.deposit_credit.returned', resource_id: ids.invoiceId,
    })).resolves.toHaveLength(0);

    await expect(require('../services/commercial-prepay-dispatch-review')
      .reconcileInvoice(trx, ids.invoiceId)).resolves.toBe('unconfirmed');
    expect(await reviews(ids.invoiceId)).toEqual([]);
  });
});
