/** Real PostgreSQL ordering tests for historical deposit receipts and invoice mints. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => 'Deposit receipt') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const InvoiceService = require('../services/invoice');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  acquireEstimateDepositLedgerLock,
  assertInvoiceDepositSettlementReady,
  handleDepositIntentSucceeded,
  reconcileReceivedDepositToInvoice,
  _private: { markDepositReceived },
} = require('../services/estimate-deposits');
const Deposits = require('../services/estimate-deposits');
const { mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
let mockPg;
let f;
jest.setTimeout(90000);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reached(barrier) {
  let timer;
  try {
    await Promise.race([
      barrier.promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected competing transaction never reached its lock')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function insertInvoice({ total = 100, status = 'sent', payerId = null, lines = null, createdAt = null } = {}) {
  const id = randomUUID();
  await mockPg('invoices').insert({
    id, customer_id: f.customerId, scheduled_service_id: f.serviceId,
    token: randomUUID().replace(/-/g, ''), invoice_number: `TEST-${id.slice(0, 24)}`,
    line_items: JSON.stringify(lines || [{ description: 'Service', quantity: 1, amount: total, unit_price: total }]),
    subtotal: total, discount_amount: 0, tax_amount: 0, total, status,
    ...(payerId ? { payer_id: payerId } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  });
  return id;
}

async function addReceived(amount = 49) {
  await mockPg('estimate_deposits').insert({
    estimate_id: f.estimateId, customer_id: f.customerId,
    stripe_payment_intent_id: `pi_${randomUUID().replace(/-/g, '')}`,
    amount, status: 'received', received_at: mockPg.fn.now(),
  });
}

(connection ? describe : describe.skip)('late deposit settlement on isolated PostgreSQL', () => {
  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    f = { customerId: randomUUID(), estimateId: randomUUID(), serviceId: randomUUID() };
    await mockPg('customers').insert({
      id: f.customerId, first_name: 'Deposit', last_name: 'Fixture',
      email: `deposit-${f.customerId}@example.invalid`,
      phone: `+1999${String(parseInt(f.customerId.slice(0, 12).replace(/-/g, ''), 16)).padStart(10, '0').slice(-10)}`,
      address_line1: '1 Example Plaza', city: 'Fictional', state: 'FL', zip: '00000',
    });
    await mockPg('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'accepted' });
    await mockPg('scheduled_services').insert({
      id: f.serviceId, customer_id: f.customerId, source_estimate_id: f.estimateId,
      service_type: 'Pest control', scheduled_date: '2099-01-01', status: 'confirmed', estimated_price: 100,
    });
  });
  afterEach(async () => {
    await mockPg('invoices').where({ customer_id: f.customerId }).del();
    await mockPg('scheduled_services').where({ id: f.serviceId }).del();
    await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).del();
    await mockPg('estimates').where({ id: f.estimateId }).del();
    await mockPg('customers').where({ id: f.customerId }).del();
  });

  test('receipt transaction wins: real service mint waits and consumes the committed credit once', async () => {
    const locked = deferred();
    const release = deferred();
    const attempted = deferred();
    const receipt = mockPg.transaction(async (trx) => {
      await acquireEstimateDepositLedgerLock(trx, f.estimateId);
      await trx('estimate_deposits').insert({
        estimate_id: f.estimateId, customer_id: f.customerId,
        stripe_payment_intent_id: `pi_${randomUUID().replace(/-/g, '')}`,
        amount: 49, status: 'received', received_at: trx.fn.now(),
      });
      locked.resolve();
      await release.promise;
    });
    await reached(locked);
    const actualLock = Deposits.acquireEstimateDepositLedgerLock;
    const lockSpy = jest.spyOn(Deposits, 'acquireEstimateDepositLedgerLock').mockImplementation((...args) => {
      attempted.resolve();
      return actualLock(...args);
    });
    const mint = mintScheduledServiceInvoiceWithDeposit({
      svc: { id: f.serviceId, customer_id: f.customerId, source_estimate_id: f.estimateId, estimated_price: 100 },
      buildCreateParams: () => ({
        customerId: f.customerId, scheduledServiceId: f.serviceId,
        lineItems: [{ description: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
      }),
    });
    let result;
    try {
      await reached(attempted);
      release.resolve();
      await receipt;
      result = await mint;
    } finally {
      release.resolve();
      lockSpy.mockRestore();
    }
    const invoice = await mockPg('invoices').where({ id: result.invoice.id }).first();
    expect(Number(invoice.total)).toBe(51);
    expect(invoice.line_items.filter((line) => line.category === 'deposit_credit')).toHaveLength(1);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount)).toBe(49);
  });

  test('mint transaction wins: later receipt waits, then appends credit to the minted invoice', async () => {
    const entered = deferred();
    const release = deferred();
    const actualCreate = InvoiceService.create;
    const createSpy = jest.spyOn(InvoiceService, 'create').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return actualCreate.apply(InvoiceService, args);
    });
    try {
      const mint = mintScheduledServiceInvoiceWithDeposit({
        svc: { id: f.serviceId, customer_id: f.customerId, source_estimate_id: f.estimateId, estimated_price: 100 },
        buildCreateParams: () => ({
          customerId: f.customerId, scheduledServiceId: f.serviceId,
          lineItems: [{ description: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
        }),
      });
      await reached(entered);
      const receiptAttempted = deferred();
      const onQuery = (query) => {
        if (query.sql.includes('pg_advisory_xact_lock')
          && query.bindings?.[0] === 'estimate.deposit.ledger') receiptAttempted.resolve();
      };
      mockPg.on('query', onQuery);
      const receipt = markDepositReceived({ paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`, estimateId: f.estimateId, amountDollars: 49 });
      await reached(receiptAttempted);
      mockPg.removeListener('query', onQuery);
      release.resolve();
      const minted = await mint;
      await receipt;
      const invoice = await mockPg('invoices').where({ id: minted.invoice.id }).first();
      expect(Number(invoice.total)).toBe(51);
      expect(invoice.line_items.filter((line) => line.category === 'deposit_credit')).toHaveLength(1);
      expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('done');
    } finally {
      release.resolve();
      createSpy.mockRestore();
    }
  });

  test('recorded receipt fences collection through the invoice-lock gap, then settles after release', async () => {
    const id = await insertInvoice();
    const release = deferred();
    const locked = deferred();
    const collector = mockPg.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id }).forUpdate().first();
      locked.resolve();
      await release.promise;
      await expect(assertInvoiceDepositSettlementReady(trx, invoice)).rejects.toMatchObject({
        code: 'DEPOSIT_RECONCILIATION_REQUIRED', status: 409,
      });
    });
    await reached(locked);
    await addReceived();
    const reconcileAttempted = deferred();
    const onQuery = (query) => {
      if (query.sql.includes('from "invoices"') && query.sql.includes('for update')) reconcileAttempted.resolve();
    };
    mockPg.on('query', onQuery);
    const reconcile = reconcileReceivedDepositToInvoice(f.estimateId);
    await reached(reconcileAttempted);
    mockPg.removeListener('query', onQuery);
    release.resolve();
    await collector;
    expect((await reconcile).state).toBe('applied');
    expect(Number((await mockPg('invoices').where({ id }).first()).total)).toBe(51);
  });

  test('claimed saved-card charge with null PI parks the deposit; replay does not mutate the invoice', async () => {
    const id = await insertInvoice();
    await addReceived();
    await mockPg('stripe_invoice_charge_attempts').insert({
      invoice_id: id, stripe_payment_method_id: 'pm_fixture', idempotency_key: `test:${randomUUID()}`,
      status: 'claimed', stripe_payment_intent_id: null,
    });
    expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('park');
    expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('park');
    expect(Number((await mockPg('invoices').where({ id }).first()).total)).toBe(100);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount)).toBe(0);
  });

  test('a deposit fully closes the first invoice and rolls its remainder to the next existing bill', async () => {
    const firstId = await insertInvoice({ total: 49, createdAt: new Date('2026-01-01T00:00:00Z') });
    const secondId = await insertInvoice({ total: 80, createdAt: new Date('2026-01-02T00:00:00Z') });
    await addReceived(99);
    const result = await reconcileReceivedDepositToInvoice(f.estimateId);
    expect(result).toMatchObject({ state: 'applied', amount: 99 });
    const [first, second] = await Promise.all([
      mockPg('invoices').where({ id: firstId }).first(),
      mockPg('invoices').where({ id: secondId }).first(),
    ]);
    expect(Number(first.total)).toBe(0);
    expect(first.status).toBe('prepaid');
    expect(Number(second.total)).toBe(30);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount)).toBe(99);
  });

  test('receipt dispatch sees an exact-coverage invoice after the reconciliation attempt', async () => {
    const id = await insertInvoice({ total: 49 });
    const sentSnapshots = [];
    sendCustomerMessage.mockImplementation(async () => {
      const invoice = await mockPg('invoices').where({ id }).first();
      sentSnapshots.push({ status: invoice.status, total: Number(invoice.total) });
      return { sent: true };
    });
    await markDepositReceived({ paymentIntentId: `pi_${randomUUID().replace(/-/g, '')}`, estimateId: f.estimateId, amountDollars: 49 });
    expect(sentSnapshots).toEqual([{ status: 'prepaid', total: 0 }]);
  });

  test('credited webhook replay settles an exhausted zero-balance invoice after transient close refusal', async () => {
    const invoiceId = await insertInvoice({ total: 49 });
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '')}`;
    const settleSpy = jest.spyOn(InvoiceService, 'settleZeroBalance')
      .mockResolvedValueOnce({ settled: false, reason: 'followup_in_flight', retryable: true });
    try {
      await markDepositReceived({ paymentIntentId, estimateId: f.estimateId, amountDollars: 49 });
      const before = await mockPg('invoices').where({ id: invoiceId }).first();
      const ledgerBefore = await mockPg('estimate_deposits').where({ stripe_payment_intent_id: paymentIntentId }).first();
      expect(before.status).toBe('sent');
      expect(Number(before.total)).toBe(0);
      expect(before.line_items.filter((line) => line.category === 'deposit_credit')).toHaveLength(1);
      expect(ledgerBefore.status).toBe('credited');
      expect(Number(ledgerBefore.credited_amount)).toBe(49);

      await expect(handleDepositIntentSucceeded({ id: paymentIntentId, metadata: { estimate_id: f.estimateId } }))
        .resolves.toMatchObject({ handled: true, replay: true });
      const after = await mockPg('invoices').where({ id: invoiceId }).first();
      const ledgerAfter = await mockPg('estimate_deposits').where({ stripe_payment_intent_id: paymentIntentId }).first();
      expect(after.status).toBe('prepaid');
      expect(after.line_items.filter((line) => line.category === 'deposit_credit')).toHaveLength(1);
      expect(Number(ledgerAfter.credited_amount)).toBe(49);
      expect(settleSpy).toHaveBeenCalledTimes(2);
    } finally {
      settleSpy.mockRestore();
    }
  });

  test('exhausted credit still finds a later stamped zero-balance invoice', async () => {
    await insertInvoice({ total: 100, createdAt: new Date('2026-01-01T00:00:00Z') });
    const coveredId = await insertInvoice({
      total: 0, createdAt: new Date('2026-01-02T00:00:00Z'),
      lines: [
        { description: 'Service', quantity: 1, amount: 49, unit_price: 49 },
        { category: 'deposit_credit', estimate_id: f.estimateId, quantity: 1, amount: -49, unit_price: -49 },
      ],
    });
    await mockPg('invoices').where({ id: coveredId }).update({ subtotal: 49 });
    await addReceived(49);
    await mockPg('estimate_deposits').where({ estimate_id: f.estimateId })
      .update({ credited_amount: 49, status: 'credited', credited_invoice_id: coveredId });

    expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('done');
    expect((await mockPg('invoices').where({ id: coveredId }).first()).status).toBe('prepaid');
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount)).toBe(49);
  });

  test('exact deposit coverage of an annual-prepay invoice parks before consuming the pending term credit', async () => {
    const invoiceId = await insertInvoice({ total: 49 });
    const termId = randomUUID();
    await mockPg('annual_prepay_terms').insert({
      id: termId, customer_id: f.customerId, source_estimate_id: f.estimateId,
      prepay_invoice_id: invoiceId, term_start: '2099-01-01', term_end: '2099-12-31',
      status: 'payment_pending',
    });
    await mockPg('invoices').where({ id: invoiceId }).update({ annual_prepay_term_id: termId });
    await addReceived(49);

    const first = await reconcileReceivedDepositToInvoice(f.estimateId);
    const replay = await reconcileReceivedDepositToInvoice(f.estimateId);
    expect(first).toMatchObject({ state: 'park', invoiceId, reason: 'annual_prepay_full_coverage' });
    expect(replay).toMatchObject({ state: 'park', invoiceId, reason: 'annual_prepay_full_coverage' });
    const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
    const term = await mockPg('annual_prepay_terms').where({ id: termId }).first();
    const ledger = await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first();
    expect(invoice.status).toBe('sent');
    expect(Number(invoice.total)).toBe(49);
    expect(invoice.line_items.some((line) => line.category === 'deposit_credit')).toBe(false);
    expect(term.status).toBe('payment_pending');
    expect(Number(ledger.credited_amount)).toBe(0);
  });

  test('a paid first invoice parks; a payer-billed invoice never takes homeowner credit', async () => {
    const id = await insertInvoice({ status: 'paid' });
    await addReceived();
    expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('park');
    await mockPg('invoices').where({ id }).update({ status: 'void' });
    const payer = await mockPg('payers').insert({ display_name: 'Fixture AP', active: true }).returning('id');
    const payerId = payer[0].id;
    try {
      const payerInvoice = await insertInvoice({ payerId });
      expect((await reconcileReceivedDepositToInvoice(f.estimateId)).state).toBe('park');
      expect(Number((await mockPg('invoices').where({ id: payerInvoice }).first()).total)).toBe(100);
    } finally {
      await mockPg('invoices').where({ customer_id: f.customerId }).del();
      await mockPg('payers').where({ id: payerId }).del();
    }
  });

  test('a withdrawn packet invoice with null payer_id never takes homeowner credit', async () => {
    const id = await insertInvoice({ status: 'draft' });
    await mockPg('invoices').where({ id }).update({ scheduled_send_error: 'payer_billed:123' });
    await addReceived(49);
    const result = await reconcileReceivedDepositToInvoice(f.estimateId);
    expect(result).toMatchObject({ state: 'park', invoiceId: id, reason: 'payer_billed' });
    const invoice = await mockPg('invoices').where({ id }).first();
    expect(invoice.payer_id).toBeNull();
    expect(invoice.scheduled_send_error).toBe('payer_billed:123');
    expect(Number(invoice.total)).toBe(100);
    expect(invoice.line_items.some((line) => line.category === 'deposit_credit')).toBe(false);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount)).toBe(0);
    await expect(assertInvoiceDepositSettlementReady(mockPg, invoice, { lock: false })).resolves.toBeUndefined();
  });
});
