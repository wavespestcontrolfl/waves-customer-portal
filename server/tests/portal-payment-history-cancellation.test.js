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
function emptyReader() {
  return () => {
    const query = {};
    for (const method of ['where', 'whereNull', 'whereRaw', 'whereIn', 'count']) query[method] = () => query;
    query.first = async () => ({ count: 1 });
    query.select = async () => [];
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
  expect(result.payments[0]).not.toHaveProperty('recoveryInvoice');
});

test('an ordinary scoped receipt lookup failure remains best effort', async () => {
  const result = await listPortalPayments('customer-1', { database: reader(new Error('lookup failed')) });
  expect(result.payments).toHaveLength(1);
  expect(result.payments[0].receiptUrl).toBeNull();
});

test('later history pages keep the fallback without starting recovery enrichment', async () => {
  stripe.getPaymentHistory.mockResolvedValueOnce([{
    id: 'payment-failed', amount: 50, status: 'failed',
    metadata: { invoice_id: '11111111-1111-4111-8111-111111111111' },
    stripe_payment_intent_id: 'pi_failed',
  }]);
  const database = jest.fn(emptyReader());

  const result = await listPortalPayments('customer-1', {
    database, cursor: 100, includeRecoveryInvoices: true,
  });

  expect(result.payments[0].recoveryInvoice).toBeNull();
  expect(result.payments[0].recoveryState).toBe('recovery_unchecked');
  expect(database.mock.calls.filter(([table]) => table === 'invoices')).toHaveLength(1);
});

test('failed rows beyond the first-page recovery cap suppress their unchecked fallback', async () => {
  stripe.getPaymentHistory.mockResolvedValue(Array.from({ length: 11 }, (_, index) => ({
    id: `payment-failed-${index + 1}`,
    amount: 50,
    status: 'failed',
  })));

  const result = await listPortalPayments('customer-1', {
    database: emptyReader(),
    includeRecoveryInvoices: true,
  });

  expect(result.payments.slice(0, 10).every((payment) => payment.recoveryState === null)).toBe(true);
  expect(result.payments[10]).toMatchObject({
    id: 'payment-failed-11',
    recoveryInvoice: null,
    recoveryState: 'recovery_unchecked',
  });
});

test('parked, superseded and never-attempted failures carry their own states on later pages', async () => {
  const failures = [
    { id: 'parked', superseded_by_payment_id: 'parked' },
    { id: 'sca', metadata: { requires_action: true } },
    { id: 'uncertain', metadata: { ambiguous_outcome: 'true' } },
    { id: 'replaced', superseded_by_payment_id: 'paid-retry', metadata: { requires_action: true } },
    { id: 'deferred', next_retry_at: '2026-11-21', metadata: { deferred_reason: 'lock_contention' } },
  ];
  stripe.getPaymentHistory.mockResolvedValue(failures.map((row) => ({ status: 'failed', amount: 50, ...row })));
  const result = await listPortalPayments('customer-1', { database: emptyReader(), cursor: 100, includeRecoveryInvoices: true });
  expect(result.payments.map((row) => row.recoveryState)).toEqual([
    'authentication_unknown', 'authentication_unknown', 'authentication_unknown', 'recovery_inactive', 'recovery_inactive',
  ]);
  expect(result.payments.every((row) => row.recoveryInvoice === null)).toBe(true);
});

test.each([
  { billed_month: '2026-11', deferred_resolution: 'absorbed_annual_prepay' },
  JSON.stringify({ billed_month: '2026-11', deferred_resolution: 'absorbed_annual_prepay' }),
  [
    JSON.stringify({ billed_month: '2026-11', deferred_reason: 'collection_hold' }),
    { email_obligation: 'sent' },
    { deferred_resolution: 'absorbed_annual_prepay' },
  ],
])('an annual-prepay-absorbed retry is resolved, not pending verification (%p)', async (metadata) => {
  stripe.getPaymentHistory.mockResolvedValueOnce([{
    id: 'absorbed-retry',
    status: 'failed',
    amount: 50,
    superseded_by_payment_id: 'absorbed-retry',
    next_retry_at: null,
    metadata,
  }]);

  const result = await listPortalPayments('customer-1', {
    database: emptyReader(), cursor: 100, includeRecoveryInvoices: true,
  });

  expect(result.payments[0]).toMatchObject({
    id: 'absorbed-retry',
    recoveryInvoice: null,
    recoveryState: 'recovery_inactive',
  });
});

test.each([
  [
    'the marker without the cron self-supersession',
    { metadata: { deferred_resolution: 'absorbed_annual_prepay' } },
    'recovery_unchecked',
  ],
  [
    'a self-superseded row with malformed metadata',
    { superseded_by_payment_id: 'uncertain-retry', metadata: '{' },
    'authentication_unknown',
  ],
])('%s is not treated as annual-prepay resolution', async (_label, fields, recoveryState) => {
  stripe.getPaymentHistory.mockResolvedValueOnce([{
    id: 'uncertain-retry', status: 'failed', amount: 50, ...fields,
  }]);

  const result = await listPortalPayments('customer-1', {
    database: emptyReader(), cursor: 100, includeRecoveryInvoices: true,
  });

  expect(result.payments[0]).toMatchObject({
    recoveryInvoice: null,
    recoveryState,
  });
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
