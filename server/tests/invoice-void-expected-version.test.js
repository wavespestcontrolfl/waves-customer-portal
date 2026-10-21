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
const mockRetrievePi = jest.fn();
const mockCancelPi = jest.fn();
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: (...a) => mockRetrievePi(...a), cancelPaymentIntent: (...a) => mockCancelPi(...a) }));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const EXPECTED = { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null };

function chain({ first, returning } = {}) {
  const q = { calls: [] };
  for (const name of ['where', 'whereIn', 'whereRaw', 'whereNull', 'update']) {
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

function queueVoid({ current = row(), returning = [row({ status: 'void' })] } = {}) {
  const update = chain({ returning });
  db
    .mockReturnValueOnce(chain({ first: current }))
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard
    .mockReturnValueOnce(update) // the void UPDATE
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard under the lock
    .mockReturnValueOnce(chain()); // payment_plans cancel
  return update;
}

test('without `expected` the void UPDATE carries no version predicates (the page and other callers)', async () => {
  const update = queueVoid();
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

test('an edit between the first read and the PaymentIntent cancel is caught by a re-read before Stripe cancels anything', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  const expected = { ...EXPECTED, paymentIntentId: 'pi_test_1' };
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
  db
    .mockReturnValueOnce(chain({ first: withPi })) // first read: matches the card
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard
    .mockReturnValueOnce(chain({ first: row({ stripe_payment_intent_id: 'pi_test_1', updated_at: new Date('2099-01-03T00:00:00Z') }) })); // re-read: edited
  await expect(InvoiceService.voidInvoice('inv-1', { expected })).rejects.toThrow(/changed while voiding/);
  expect(mockRetrievePi).toHaveBeenCalledTimes(1);
  expect(mockCancelPi).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
});

test('without `expected` the PaymentIntent cancel makes no extra invoice read (the page path)', async () => {
  const withPi = row({ stripe_payment_intent_id: 'pi_test_1' });
  mockRetrievePi.mockResolvedValue({ id: 'pi_test_1', status: 'requires_payment_method' });
  mockCancelPi.mockResolvedValue({});
  const update = chain({ returning: [row({ status: 'void' })] });
  jest.doMock('../services/pay-combined', () => ({ clearPaymentIntentStamps: jest.fn(async () => undefined) }));
  db
    .mockReturnValueOnce(chain({ first: withPi }))
    .mockReturnValueOnce(chain({ first: undefined })) // payments guard
    .mockReturnValueOnce(update) // straight to the void UPDATE: no re-read between
    .mockReturnValueOnce(chain({ first: undefined }))
    .mockReturnValueOnce(chain());
  await InvoiceService.voidInvoice('inv-1').catch(() => null);
  expect(mockCancelPi).toHaveBeenCalledTimes(1);
  expect(update.update).toHaveBeenCalledTimes(1);
});
