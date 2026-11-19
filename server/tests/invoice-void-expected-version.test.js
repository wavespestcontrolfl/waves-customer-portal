/**
 * InvoiceService.voidInvoice({ expected }) — the version the Intelligence Bar's void_invoice card showed.
 * Absent (the Invoices page and every other caller): no card-version predicates are added. Every void locks
 * and checks the saved-card fence before Stripe; with `expected`, a changed invoice is also refused on the
 * first read and the void's own UPDATE carries the version predicates. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({ stopSequence: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
  acquireTermiteGateAtEntry: jest.fn(async () => []),
}));
jest.mock('../services/estimate-deposits', () => ({ restoreDepositCreditForVoidedInvoice: jest.fn(async () => 0) }));
const mockCombinedOwnerLock = jest.fn(async (_trx, _invoiceId, customerId) => customerId || null);
jest.mock('../services/pay-combined', () => ({
  clearPaymentIntentStamps: jest.fn(async () => undefined),
  lockCombinedCustomerStable: (...args) => mockCombinedOwnerLock(...args),
}));
const mockRetrievePi = jest.fn();
const mockCancelPi = jest.fn();
const mockFence = jest.fn(async () => undefined);
const suppressesAlternateCollection = (err) => [
  'STRIPE_CHARGED_DB_FAILED', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGE_IN_PROGRESS', 'DEPOSIT_RECONCILIATION_REQUIRED',
].includes(err?.code);
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...a) => mockRetrievePi(...a),
  cancelPaymentIntent: (...a) => mockCancelPi(...a),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockFence(...a),
  savedCardChargeSuppressesAlternateCollection: (err) => suppressesAlternateCollection(err),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const EXPECTED = { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null };

function chain({ first, returning, rows } = {}) {
  const q = { calls: [] };
  for (const name of ['where', 'whereNot', 'whereIn', 'whereRaw', 'whereNull', 'update', 'orderBy', 'forUpdate', 'forNoKeyUpdate']) {
    q[name] = jest.fn((...args) => { q.calls.push([name, ...args]); return q; });
  }
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(rows || (first ? [first] : [])).then(resolve, reject);
  return q;
}
const row = (overrides = {}) => ({ id: 'inv-1', customer_id: 'cust-1', status: 'sent', invoice_number: 'WPC-2099-0001', total: '129.00', credit_applied: '0.00', updated_at: UPDATED, stripe_payment_intent_id: null, payment_recorded_at: null, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  db.transaction = jest.fn(async (fn) => fn(db));
});

function queueVoid({ current = row(), returning = [row({ status: 'void' })], plan, bar = true, locked, allocationRows } = {}) {
  const update = chain({ returning });
  const lockedRow = locked || current;
  const lockedInvoice = chain({ first: lockedRow, rows: allocationRows || [lockedRow] });
  db
    .mockReturnValueOnce(chain({ first: current }))
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard
    // Every void takes the invoice row FOR NO KEY UPDATE inside the transaction.
    .mockReturnValueOnce(lockedInvoice);
  // Bar only: the payment-plan fence read right after the lock (the charge fence is mocked at the Stripe module).
  if (bar) db.mockReturnValueOnce(chain({ first: plan }));
  db.mockReturnValueOnce(update); // the void UPDATE
  db
    .mockReturnValueOnce(chain({ first: undefined })) // rodent setup-obligation probe
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard under the lock
    .mockReturnValueOnce(chain()); // payment_plans cancel
  update.lockedInvoice = lockedInvoice;
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

test('with `expected` the PI allocation is locked in canonical order before the Stripe cancel', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1', paymentIntentStatus: 'requires_payment_method' };
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
  mockCancelPi.mockResolvedValue({});
  const update = queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
  await InvoiceService.voidInvoice('inv-1', { expected });
  expect(mockCombinedOwnerLock).toHaveBeenCalledWith(db, 'inv-1', 'cust-1');
  expect(update.lockedInvoice.orderBy).toHaveBeenCalledWith('id', 'asc');
  expect(update.lockedInvoice.forUpdate).toHaveBeenCalledTimes(1);
  expect(update.lockedInvoice.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFence.mock.invocationCallOrder[0]);
  expect(mockFence.mock.invocationCallOrder[0]).toBeLessThan(mockRetrievePi.mock.invocationCallOrder[0]);
  expect(mockRetrievePi.mock.invocationCallOrder[0]).toBeLessThan(mockCancelPi.mock.invocationCallOrder[0]);
});

test('a shared PI locks target and collectible siblings in ascending id order before provider cancellation', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_shared' });
  const sibling = row({
    id: 'inv-0',
    invoice_number: 'WPC-2099-0000',
    stripe_payment_intent_id: 'pi_shared',
  });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_shared', paymentIntentStatus: 'requires_payment_method' };
  mockRetrievePi.mockResolvedValue({ id: 'pi_shared', status: 'requires_payment_method' });
  mockCancelPi.mockResolvedValue({});
  const update = queueVoid({
    current: withPi,
    allocationRows: [sibling, withPi],
    returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_shared' })],
  });

  await InvoiceService.voidInvoice('inv-1', { expected });

  expect(mockCombinedOwnerLock).toHaveBeenCalledWith(db, 'inv-1', 'cust-1');
  expect(update.lockedInvoice.whereRaw).toHaveBeenCalledWith(
    'id = ? OR (stripe_payment_intent_id = ? AND status NOT IN (?, ?, ?))',
    ['inv-1', 'pi_shared', 'paid', 'processing', 'prepaid'],
  );
  expect(update.lockedInvoice.orderBy).toHaveBeenCalledWith('id', 'asc');
  expect(update.lockedInvoice.forUpdate.mock.invocationCallOrder[0])
    .toBeLessThan(mockCancelPi.mock.invocationCallOrder[0]);
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

test('without `expected` the page also locks and fences before touching Stripe', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
  mockCancelPi.mockResolvedValue({});
  const update = queueVoid({ current: withPi, bar: false, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
  await InvoiceService.voidInvoice('inv-1');
  expect(update.lockedInvoice.forUpdate).toHaveBeenCalledTimes(1);
  expect(update.lockedInvoice.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFence.mock.invocationCallOrder[0]);
  expect(mockFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
  expect(mockFence.mock.invocationCallOrder[0]).toBeLessThan(mockRetrievePi.mock.invocationCallOrder[0]);
  expect(mockRetrievePi.mock.invocationCallOrder[0]).toBeLessThan(mockCancelPi.mock.invocationCallOrder[0]);
  expect(update.update).toHaveBeenCalledTimes(1);
});

describe('the saved-card charge fence inside every void transaction', () => {
  test('with `expected` the checkout fence runs after the invoice row lock', async () => {
    const update = queueVoid();
    await InvoiceService.voidInvoice('inv-1', { expected: EXPECTED });
    expect(mockFence).toHaveBeenCalledTimes(1);
    expect(mockFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(update.lockedInvoice.forNoKeyUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFence.mock.invocationCallOrder[0]);
  });

  test.each([
    ['an ambiguous attempt', Object.assign(new Error('ambiguous'), { code: 'STRIPE_AMBIGUOUS_OUTCOME', reconciliationRequired: true })],
    ['a charge in progress', Object.assign(new Error('busy'), { code: 'STRIPE_CHARGE_IN_PROGRESS' })],
    ['an orphan charge', Object.assign(new Error('orphan'), { code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true })],
  ])('%s that started after the card refuses the void with the page’s 409 wording, and no credit is restored', async (_name, err) => {
    const update = queueVoid();
    mockFence.mockRejectedValueOnce(err);
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toMatchObject({
      code: err.code,
      statusCode: 409,
      isOperational: true,
      message: expect.stringMatching(/^Cannot void this invoice while a saved-card payment/),
    });
    expect(update.update).not.toHaveBeenCalled();
    expect(mockRetrievePi).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
    expect(require('../services/invoice-followups').stopSequence).not.toHaveBeenCalled();
  });

  test('an unexpected read failure propagates (fail closed)', async () => {
    queueVoid();
    mockFence.mockRejectedValueOnce(new Error('database down'));
    await expect(InvoiceService.voidInvoice('inv-1', { expected: EXPECTED })).rejects.toThrow('database down');
  });

  test('the page path (no `expected`) reads the same checkout fence after locking', async () => {
    const update = queueVoid({ bar: false });
    await InvoiceService.voidInvoice('inv-1');
    expect(mockFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(update.lockedInvoice.forNoKeyUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFence.mock.invocationCallOrder[0]);
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

  test('the page path (no `expected`) does not run the bar-only payment-plan refusal', async () => {
    queueVoid({ bar: false });
    await InvoiceService.voidInvoice('inv-1');
    const planCalls = db.mock.calls.filter(([table]) => table === 'payment_plans');
    expect(planCalls).toEqual([['payment_plans']]); // only the ordinary post-void active-plan cancellation
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
    const update = queueVoid({ current: withPi });
    const conflict = Object.assign(new Error('busy'), { code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: 'attempt-1' });
    mockFence.mockRejectedValueOnce(conflict);
    await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toMatchObject({
      code: conflict.code,
      chargeAttemptId: conflict.chargeAttemptId,
      statusCode: 409,
      isOperational: true,
    });
    expect(update.lockedInvoice.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockFence.mock.invocationCallOrder[0]);
    expect(mockRetrievePi).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
    expect(require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('a payment plan created after the card refuses the void with no Stripe retrieve or cancel', async () => {
    const update = queueVoid({ current: withPi, plan: { id: 'plan-1' } });
    await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/payment plan exists.*while voiding/);
    expect(mockRetrievePi).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
    expect(require('../services/estimate-deposits').restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('with both clear the session is cancelled', async () => {
    queueVoid({ current: withPi, returning: [row({ status: 'void', stripe_payment_intent_id: 'pi_test_1' })] });
    await InvoiceService.voidInvoice('inv-1', { expected });
    expect(mockCancelPi).toHaveBeenCalledTimes(1);
  });
});
