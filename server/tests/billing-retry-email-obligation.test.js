const mockSendRetryNotice = jest.fn();
const mockWithCustomerCommsLock = jest.fn(async (database, _customerId, fn) => fn(database));
const mockIsEnabled = jest.fn(() => false);
const mockEnroll = jest.fn();

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentRetryNotice: (...args) => mockSendRetryNotice(...args),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: (...args) => mockWithCustomerCommsLock(...args),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));
jest.mock('../services/automation-enroll', () => ({
  enrollSequenceFromEvent: (...args) => mockEnroll(...args),
}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550000' }));
jest.mock('../services/retry-collectibility', () => ({
  loadRetryContext: jest.fn(() => ({ lookupWarnings: [] })),
  classifyFailedPaymentRetry: jest.fn(async () => ({ disposition: 'charge' })),
  DISPOSITIONS: { CHARGE: 'charge' },
}));

const db = require('../models/db');
const BillingRetryEmail = require('../services/billing-retry-email-obligation');
const RetryCollectibility = require('../services/retry-collectibility');

function query({ result = [], first = null, insertId = 'queue-1', insertError = null, update = 1 } = {}) {
  const q = {};
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  for (const method of ['whereRaw', 'whereIn', 'orderBy', 'limit', 'orWhereNotNull']) q[method] = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (first instanceof Error) throw first;
    return first;
  });
  q.update = jest.fn(async () => update);
  q.insert = jest.fn(() => q);
  q.returning = jest.fn(async () => {
    if (insertError) throw insertError;
    return [{ id: insertId }];
  });
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

function wire(queues) {
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue?.length) throw new Error(`Unexpected table ${table}`);
    return queue.shift();
  });
}

const descriptor = BillingRetryEmail.pendingDescriptor({
  customerId: 'cust-1', paymentId: 'pay-1', retryDate: '2026-09-29T12:00:00Z', preferenceState: true,
});
const payment = {
  id: 'pay-1', customer_id: 'cust-1', status: 'failed', next_retry_at: '2026-09-29T12:00:00Z',
  metadata: { billing_retry_email_notice: descriptor },
};
const replayMeta = {
  customer_id: 'cust-1', payment_id: 'pay-1', retry_date: '2026-09-29',
  billing_retry_email_key: descriptor.key, preference_state: 'explicit', scheduled_sms_log_id: 'queue-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(false);
});

test.each(['2026-09-30T01:00:00Z', new Date('2026-09-30T01:00:00Z'), '2026-09-29'])(
  'retry identity preserves the Eastern calendar date for %s', (retryDate) => {
    const notice = BillingRetryEmail.pendingDescriptor({ customerId: 'cust-1', paymentId: 'pay-1', retryDate, preferenceState: true });
    expect(notice.retry_date).toBe('2026-09-29');
    expect(notice.key).toBe('payment.retry_notice:pay-1:2026-09-29');
  },
);

test('a failed queue insert leaves the payment descriptor for the periodic reconciler', async () => {
  const failedInsert = query({ insertError: new Error('queue unavailable') });
  const paymentRead = query({ first: payment });
  wire({
    payments: [query({ result: [payment] }), paymentRead],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    customers: [query({ first: { id: 'cust-1', phone: '+19415550100' } })],
    sms_log: [query({ first: null }), failedInsert],
  });

  await expect(BillingRetryEmail.reconcilePendingNotices()).resolves.toEqual({ checked: 1, queued: 0 });
  expect(failedInsert.insert).toHaveBeenCalled();
  expect(paymentRead.update).not.toHaveBeenCalled();
});

test('queue insertion and descriptor clearing share the customer comms lock and exact key', async () => {
  const clear = query();
  wire({
    payments: [query({ result: [payment] }), query({ first: payment }), clear],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    customers: [query({ first: { id: 'cust-1', phone: null } })],
    sms_log: [query({ first: null }), query({ insertId: 'queue-1' })],
  });

  await expect(BillingRetryEmail.reconcilePendingNotices()).resolves.toEqual({ checked: 1, queued: 1 });
  expect(mockWithCustomerCommsLock).toHaveBeenCalledTimes(1);
  expect(clear.whereRaw).toHaveBeenCalledWith("metadata->?->>'key' = ?", [
    'billing_retry_email_notice', descriptor.key,
  ]);
});

test('fresh automation coverage settles the queue without enrollment or branded provider delivery', async () => {
  wire({
    payments: [query({ first: payment })],
    customers: [query({ first: { id: 'cust-1' } })],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    automation_enrollments: [query({ first: { id: 'enroll-1' } })],
  });

  await expect(BillingRetryEmail.replayPaymentRetryNotice(replayMeta)).resolves.toMatchObject({
    sent: true, code: 'AUTOMATION_COVERED', deliveryOutcome: 'accepted',
  });
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});

test('an automation coverage read failure holds the decision before enrollment or provider delivery', async () => {
  wire({
    payments: [query({ first: payment })],
    customers: [query({ first: { id: 'cust-1' } })],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    automation_enrollments: [query({ first: new Error('coverage unavailable') })],
  });

  await expect(BillingRetryEmail.replayPaymentRetryNotice(replayMeta)).resolves.toMatchObject({
    sent: false, retryable: true, code: 'AUTOMATION_COVERAGE_UNAVAILABLE', deliveryOutcome: 'not_sent',
  });
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});

test('an uncertain provider outcome remains marked and cannot be automatically replayed', async () => {
  const modeWrite = query();
  const markerWrite = query();
  wire({
    payments: [query({ first: payment })],
    customers: [query({ first: { id: 'cust-1' } })],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    automation_enrollments: [query({ first: null })],
    sms_log: [modeWrite, markerWrite],
  });
  mockSendRetryNotice.mockImplementationOnce(async ({ beforeProviderHandoff }) => {
    await beforeProviderHandoff();
    return { ok: false, deliveryOutcome: 'uncertain', retryable: false };
  });

  await expect(BillingRetryEmail.replayPaymentRetryNotice(replayMeta)).resolves.toMatchObject({
    sent: false, blocked: true, code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN', deliveryOutcome: 'uncertain',
  });
  expect(modeWrite.update).toHaveBeenCalled();
  expect(markerWrite.whereRaw).toHaveBeenCalledWith(
    "metadata->>'billing_retry_email_provider_started_at' IS NULL",
  );
  expect(modeWrite.update.mock.invocationCallOrder[0]).toBeLessThan(mockSendRetryNotice.mock.invocationCallOrder[0]);
});

test('a known not-sent result clears its marker and retries in branded mode without re-enrollment', async () => {
  const markerWrite = query();
  const markerClear = query();
  wire({
    payments: [query({ first: payment })],
    customers: [query({ first: { id: 'cust-1' } })],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
    sms_log: [markerWrite, markerClear],
  });
  mockSendRetryNotice.mockImplementationOnce(async ({ beforeProviderHandoff }) => {
    await beforeProviderHandoff();
    return { ok: false, deliveryOutcome: 'not_sent', retryable: true, reason: 'provider_unavailable' };
  });

  await expect(BillingRetryEmail.replayPaymentRetryNotice({
    ...replayMeta, billing_retry_email_mode: 'branded',
  })).resolves.toMatchObject({
    sent: false, retryable: true, code: 'BILLING_EMAIL_RETRY', deliveryOutcome: 'not_sent',
  });
  expect(markerClear.update).toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
});

test('an existing provider-start marker parks the row before any provider call', async () => {
  wire({
    payments: [query({ first: payment })],
    customers: [query({ first: { id: 'cust-1' } })],
    notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })],
  });

  await expect(BillingRetryEmail.replayPaymentRetryNotice({
    ...replayMeta, billing_retry_email_provider_started_at: '2026-09-24T12:00:00Z',
  })).resolves.toMatchObject({
    blocked: true, code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN', deliveryOutcome: 'uncertain',
  });
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});

test('legacy NULL preferences retain the direct branded behavior', async () => {
  wire({ notification_prefs: [query({ first: { payment_issue_channels: null } })] });
  mockSendRetryNotice.mockResolvedValueOnce({ ok: true, deliveryOutcome: 'accepted' });

  await expect(BillingRetryEmail.sendPaymentRetryNotice({
    customerId: 'cust-1', paymentId: 'pay-1', retryDate: payment.next_retry_at, legacy: true,
  })).resolves.toMatchObject({ ok: true });
  expect(mockSendRetryNotice).toHaveBeenCalledWith({
    customerId: 'cust-1', paymentId: 'pay-1', retryDate: payment.next_retry_at,
  });
});

test('an explicit Email choice cannot invoke the legacy direct provider owner', async () => {
  wire({ notification_prefs: [query({ first: { payment_issue_channels: ['email'] } })] });
  await expect(BillingRetryEmail.sendPaymentRetryNotice({
    customerId: 'cust-1', paymentId: 'pay-1', retryDate: payment.next_retry_at,
  })).resolves.toMatchObject({ reason: 'deferred_owner_required', retryable: true });
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});

test.each([
  ['already_collected', 'supersede_by_collector'],
  ['absorbed_annual_prepay', 'self_supersede'],
  ['autopay_disabled', 'disarm'],
  ['autopay_paused', 'skip_armed'],
  ['lane_not_monthly', 'disarm'],
  ['customer_deleted', 'skip_silent'],
])('a queued notice does not promise a retry after %s', async (reason, disposition) => {
  const currentCustomer = { id: 'cust-1', autopay_enabled: false };
  wire({ payments: [query({ first: payment })], customers: [query({ first: currentCustomer })] });
  RetryCollectibility.classifyFailedPaymentRetry.mockResolvedValueOnce({ reason, disposition });

  await expect(BillingRetryEmail.replayPaymentRetryNotice(replayMeta)).resolves.toMatchObject({
    sent: false, blocked: true, code: 'PAYMENT_RETRY_NO_LONGER_ELIGIBLE', reason, deliveryOutcome: 'not_sent',
  });
  // Eligibility is judged on the retry date the notice names, not today.
  expect(RetryCollectibility.loadRetryContext).toHaveBeenCalledWith({ asOf: '2026-09-29', conn: db });
  expect(RetryCollectibility.classifyFailedPaymentRetry).toHaveBeenCalledWith({
    payment, customer: currentCustomer, conn: db, ctx: { lookupWarnings: [] },
  });
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});

test.each(['throw', 'lookup warning'])('unreadable retry eligibility stays retryable (%s)', async (failure) => {
  wire({ payments: [query({ first: payment })], customers: [query({ first: { id: 'cust-1' } })] });
  if (failure === 'throw') RetryCollectibility.classifyFailedPaymentRetry.mockRejectedValueOnce(new Error('unavailable'));
  else RetryCollectibility.loadRetryContext.mockReturnValueOnce({ lookupWarnings: [{ lookup: 'prepay' }] });

  await expect(BillingRetryEmail.replayPaymentRetryNotice(replayMeta)).resolves.toMatchObject({
    sent: false, retryable: true, code: 'PAYMENT_RETRY_ELIGIBILITY_UNAVAILABLE', deliveryOutcome: 'not_sent',
  });
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockSendRetryNotice).not.toHaveBeenCalled();
});
