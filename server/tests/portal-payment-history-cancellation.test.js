jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadPayerLinkage: jest.fn(async () => ({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false })),
}));
const db = require('../models/db');
const stripe = require('../services/stripe');
const { listPortalPayments } = require('../services/portal-payment-history');

function reader(failure) {
  return (table) => {
    const query = {};
    for (const method of ['where', 'whereNull', 'whereRaw', 'whereIn', 'count']) query[method] = () => query;
    query.first = async () => ({ count: 1 });
    query.select = async () => { if (table === 'invoices') throw failure; return []; };
    return query;
  };
}
beforeEach(() => {
  stripe.getPaymentHistory.mockClear();
  stripe.getPaymentHistory.mockResolvedValue([{
    id: 'payment-1', amount: 50, status: 'paid', stripe_payment_intent_id: 'pi_fixture',
  }]);
});

test.each([
  { code: 'PORTAL_CHAT_DEADLINE' }, { code: 'ABORT_ERR' }, { code: '57014' },
  { name: 'AbortError' }, { name: 'KnexTimeoutError' },
])('receipt cancellation from the scoped reader aborts the whole payment history: %j', async (identity) => {
  const failure = Object.assign(new Error('cancelled'), identity);
  await expect(listPortalPayments('customer-1', { database: reader(failure) })).rejects.toBe(failure);
});

test.each([{ code: '57014' }, { name: 'KnexTimeoutError' }, {}])('default receipt lookup remains best effort: %j', async (identity) => {
  db.mockImplementation(reader(Object.assign(new Error('lookup failed'), identity)));
  const result = await listPortalPayments('customer-1');
  expect(result.payments).toHaveLength(1);
  expect(result.payments[0].receiptUrl).toBeNull();
});

test('an ordinary scoped receipt lookup failure remains best effort', async () => {
  const result = await listPortalPayments('customer-1', { database: reader(new Error('lookup failed')) });
  expect(result.payments).toHaveLength(1);
  expect(result.payments[0].receiptUrl).toBeNull();
});

test('cancellation on the first payer read cannot start count or payment queries', async () => {
  const failure = Object.assign(new Error('cancelled'), { code: '57014' });
  const database = jest.fn(reader(failure));
  require('../services/payer-linkage').loadPayerLinkage.mockImplementationOnce(
    jest.requireActual('../services/payer-linkage').loadPayerLinkage,
  );
  await expect(listPortalPayments('customer-1', { database })).rejects.toBe(failure);
  expect(database.mock.calls).toEqual([['invoices']]);
  expect(stripe.getPaymentHistory).not.toHaveBeenCalled();
});
