/**
 * InvoiceService.voidInvoice({ expected }) — the version the Intelligence Bar's void_invoice card showed.
 * Absent (the Invoices page and every other caller): nothing about the void changes. Present: a changed
 * invoice is refused on the row read first (before any Stripe call), and the void's own UPDATE carries the
 * version as extra predicates so a change after that read loses. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({ stopSequence: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
  acquireTermiteGateAtEntry: jest.fn(async () => []),
}));
jest.mock('../services/estimate-deposits', () => ({ restoreDepositCreditForVoidedInvoice: jest.fn(async () => 0) }));
jest.mock('../services/pay-combined', () => ({ clearPaymentIntentStamps: jest.fn(async () => undefined) }));
const mockRetrievePi = jest.fn();
const mockCancelPi = jest.fn();
const mockFence = jest.fn(async () => undefined);
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: (...a) => mockRetrievePi(...a), cancelPaymentIntent: (...a) => mockCancelPi(...a), assertNoInvoiceChargeReconciliationPending: (...a) => mockFence(...a) }));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const EXPECTED = { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null };

function chain({ first, returning } = {}) {
  const q = { calls: [] };
  for (const name of ['where', 'whereNot', 'whereIn', 'whereRaw', 'whereNull', 'update', 'forNoKeyUpdate']) {
    q[name] = jest.fn((...args) => { q.calls.push([name, ...args]); return q; });
  }
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}
const row = (overrides = {}) => ({ id: 'inv-1', status: 'sent', invoice_number: 'WPC-2099-0001', total: '129.00', credit_applied: '0.00', updated_at: UPDATED, stripe_payment_intent_id: null, payment_recorded_at: null, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  db.transaction = jest.fn(async (fn) => fn(db));
});

function queueVoid({ current = row(), returning = [row({ status: 'void' })], plan, bar = true, locked } = {}) {
  const update = chain({ returning });
  db
    .mockReturnValueOnce(chain({ first: current }))
    .mockReturnValueOnce(chain({ first: undefined })); // payments guard
  // Bar only: the invoice row taken FOR NO KEY UPDATE inside the transaction (version re-asserted on it).
  if (bar) db.mockReturnValueOnce(chain({ first: locked || current }));
  // Bar only: the payment-plan fence read right after the lock (the charge fence is mocked at the Stripe module).
  if (bar) db.mockReturnValueOnce(chain({ first: plan }));
  db.mockReturnValueOnce(update); // the void UPDATE
  db
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard under the lock
    .mockReturnValueOnce(chain()); // payment_plans cancel
  return update;
}

test('without `expected` the void UPDATE carries no version predicates (the page and other callers)', async () => {
  const update = queueVoid({ bar: false });
  await InvoiceService.voidInvoice('inv-1');
  expect(update.calls.filter(([name]) => name === 'whereRaw' || name === 'whereNull')).toEqual([]);
  expect(update.where).toHaveBeenCalledTimes(1);
});

test('with `expected` the UPDATE also requires the edit time, total, credit, no recorded payment and the same PaymentIntent', async () => {
  const update = queueVoid();
  await InvoiceService.voidInvoice('inv-1', { expected: EXPECTED });
  const sql = update.calls.filter(([name]) => name === 'whereRaw').map(([, text]) => text).join(' | ');
  expect(sql).toMatch(/date_trunc\('milliseconds', updated_at\) = \?::timestamptz/);
  expect(sql).toMatch(/total/);
  expect(sql).toMatch(/credit_applied/);
  expect(update.calls.find(([name, text]) => name === 'whereRaw' && /date_trunc/.test(text))[2]).toEqual([UPDATED.toISOString()]);
  expect(update.calls.filter(([name]) => name === 'whereNull').map(([, col]) => col)).toEqual(expect.arrayContaining(['payment_recorded_at', 'stripe_payment_intent_id']));
});

test('a lost version predicate (the UPDATE matches nothing) throws the page’s own drift message', async () => {
  queueVoid({ returning: [] });
  await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow(/changed while voiding/);
});

test.each([
  ['status', { status: 'viewed' }],
  ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }],
  ['total', { total: '130.00' }],
  ['credit', { credit_applied: '5.00' }],
  ['payment intent', { stripe_payment_intent_id: 'pi_new' }],
  ['recorded payment', { payment_recorded_at: new Date() }],
])('a changed %s refuses on the first read, before any Stripe call or write', async (_label, change) => {
  db.mockReturnValueOnce(chain({ first: row(change) }));
  await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow(/changed while voiding/);
  expect(mockRetrievePi).not.toHaveBeenCalled();
  expect(mockCancelPi).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(db).toHaveBeenCalledTimes(1);
});

test('the same invoice whose pay-page session was added since the card is refused before Stripe is called', async () => {
  db.mockReturnValueOnce(chain({ first: row({ stripe_payment_intent_id: 'pi_new' }) }));
  await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow(/changed while voiding/);
  expect(mockRetrievePi).not.toHaveBeenCalled();
});

test('an edit between the first read and the lock is caught on the LOCKED row, before Stripe is touched', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_payment_method' };
  queueVoid({ current: withPi, locked: row({ stripe_payment_intent_id: 'pi_test_1', updated_at: new Date('2099-01-03T00:00:00Z') }) });
  await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/changed while voiding/);
  expect(mockRetrievePi).not.toHaveBeenCalled();
  expect(mockCancelPi).not.toHaveBeenCalled();
});

test('with `expected` the row is taken FOR NO KEY UPDATE before the Stripe cancel and the cancel runs inside the transaction', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_payment_method' };
  const order = [];
  mockRetrievePi.mockImplementation(async () => { order.push('retrieve'); return { id: 'pi_test_1', status: 'requires_payment_method' }; });
  mockCancelPi.mockImplementation(async () => { order.push('cancel'); return {}; });
  db.transaction = jest.fn(async (fn) => { order.push('txn'); return fn(db); });
  queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
  await InvoiceService.voidInvoice('inv-1', { expected });
  expect(order).toEqual(['txn', 'retrieve', 'cancel']);
});

test('a session that moved to requires_action since the card is refused, never cancelled', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_confirmation' };
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_action' });
  queueVoid({ current: withPi });
  await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/changed while voiding/);
  expect(mockCancelPi).not.toHaveBeenCalled();
});

test('a session canceled since the card, or still in the carded state, passes the status check', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_payment_method' };
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'canceled' });
  queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
  await InvoiceService.voidInvoice('inv-1', { expected });
  expect(mockCancelPi).not.toHaveBeenCalled();
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
  mockCancelPi.mockResolvedValue({});
  queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
  await InvoiceService.voidInvoice('inv-1', { expected });
  expect(mockCancelPi).toHaveBeenCalledTimes(1);
});

test('without `expected` the page triages before its transaction, with no extra invoice read (the page path)', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const order = [];
  mockRetrievePi.mockImplementation(async () => { order.push('retrieve'); return { id: 'pi_test_1', status: 'requires_action' }; });
  mockCancelPi.mockImplementation(async () => { order.push('cancel'); return {}; });
  db.transaction = jest.fn(async (fn) => { order.push('txn'); return fn(db); });
    const update = queueVoid({ current: withPi, bar: false });
  await InvoiceService.voidInvoice('inv-1').catch(() => null);
  expect(order).toEqual(['retrieve', 'cancel', 'txn']);
  expect(update.update).toHaveBeenCalledTimes(1);
});

describe('the saved-card charge fence inside the void transaction (bar only)', () => {
  test('with `expected` the fence is read inside the transaction once the invoice row is locked, read-only', async () => {
    queueVoid();
    await InvoiceService.voidInvoice('inv-1', { expected: EXPECTED });
    expect(mockFence).toHaveBeenCalledTimes(1);
    expect(mockFence).toHaveBeenCalledWith('inv-1', db, { readOnly: true });
  });

  test.each([
    ['an ambiguous attempt', Object.assign(new Error('ambiguous'), { code: 'STRIPE_AMBIGUOUS_OUTCOME', reconciliationRequired: true })],
    ['a charge in progress', Object.assign(new Error('busy'), { code: 'STRIPE_CHARGE_IN_PROGRESS' })],
    ['an orphan charge', Object.assign(new Error('orphan'), { code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true })],
  ])('%s that started after the card refuses the void with the page’s 409 wording, and no credit is restored', async (_name, err) => {
    queueVoid();
    mockFence.mockRejectedValueOnce(err);
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow(/saved-card charge.*while voiding/);
    expect(require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
    expect(require('../services/invoice-followups').stopSequence).not.toHaveBeenCalled();
  });

  test('an unexpected read failure propagates (fail closed)', async () => {
    queueVoid();
    mockFence.mockRejectedValueOnce(new Error('database down'));
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow('database down');
  });

  test('the page path (no `expected`) never reads the fence', async () => {
    queueVoid({ bar: false });
    await InvoiceService.voidInvoice('inv-1');
    expect(mockFence).not.toHaveBeenCalled();
  });
});

describe('the payment-plan fence inside the void transaction (bar only)', () => {
  test('a plan created after the card refuses the void, restores nothing and stops nothing', async () => {
    queueVoid({ plan: { id: 'plan-1' } });
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow(/payment plan exists.*while voiding/);
    expect(require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
    expect(require('../services/invoice-followups').stopSequence).not.toHaveBeenCalled();
  });

  test('no plan: the bar void proceeds', async () => {
    queueVoid();
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).resolves.toMatchObject({ status: 'void' });
  });

  test('the page path (no `expected`) reads no plan before the cancel (its own cancel is the next read)', async () => {
    queueVoid({ bar: false });
    await InvoiceService.voidInvoice('inv-1');
    expect(db).toHaveBeenCalledTimes(5);
  });
});

describe('the fences run before the Stripe cancel (a cancel cannot roll back)', () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_payment_method' };
  beforeEach(() => {
    mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
    mockCancelPi.mockResolvedValue({});
  });

  test('a saved-card claim that started after the card refuses the void with no Stripe retrieve or cancel', async () => {
    queueVoid({ current: withPi });
    mockFence.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }));
    await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/saved-card charge.*while voiding/);
    expect(mockRetrievePi).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
  });

  test('a payment plan created after the card refuses the void with no Stripe retrieve or cancel', async () => {
    queueVoid({ current: withPi, plan: { id: 'plan-1' } });
    await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/payment plan exists.*while voiding/);
    expect(mockRetrievePi).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
  });

  test('with both clear the session is cancelled', async () => {
    queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
    await InvoiceService.voidInvoice('inv-1', { expected });
    expect(mockCancelPi).toHaveBeenCalledTimes(1);
  });
});
