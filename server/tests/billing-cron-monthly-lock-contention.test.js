/**
 * processMonthlyBilling — lock-contention deferral (ADMIN-BUG-R11, Codex
 * round-1 P1): unlike charge-now (user-retryable) and a normal retry-sweep
 * row (its own next_retry_at survives untouched, reclassified next tick),
 * the once-a-month cron loop has NO natural recovery if the per-customer
 * collection lock is held elsewhere for the whole bounded retry window —
 * isBillingDayMatch only matches once a month. A bare skip there would
 * silently miss a whole billing cycle for that customer.
 *
 * Contract asserted here: when withCustomerBillingLock exhausts every
 * bounded retry with BILLING_CLAIM_HELD_ELSEWHERE, the cron writes a
 * durable 'failed' payments row with next_retry_at set (the exact shape
 * the 10 AM retry sweep's armedRetryQuery already consumes) AND raises a
 * customer_health_alerts row — an operator is told AND the retry sweep
 * gets a durable work item, not just a log line.
 *
 * Mirrors the billing-cron-billing-mode.test.js harness. Real (not fake)
 * timers: the bounded-retry loop's own short delays run for real here, so
 * this test carries an explicit longer timeout.
 */
let mockCustomers = [];
let mockTermRows = [];
let mockPaymentsInserts = [];
let mockHealthAlertInserts = [];
// The post-contention already-collected recheck's read of `payments`.
let mockCollectedRow = null;

jest.mock('../models/db', () => {
  function thenableFor(resultFn) {
    const b = {};
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'whereRaw', 'distinct', 'select', 'orderBy', 'update',
      'insert', 'returning', 'count', 'pluck', 'join', 'leftJoin',
    ]) b[m] = () => b;
    b.first = () => Promise.resolve(null);
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'customers') return thenableFor(() => mockCustomers);
    if (String(table).startsWith('annual_prepay_terms')) return thenableFor(() => mockTermRows);
    if (table === 'payments') {
      const b = thenableFor(() => []);
      b.first = () => Promise.resolve(mockCollectedRow);
      b.insert = jest.fn((row) => { mockPaymentsInserts.push(row); return Promise.resolve([1]); });
      return b;
    }
    if (table === 'customer_health_alerts') {
      const b = thenableFor(() => []);
      b.insert = jest.fn((row) => { mockHealthAlertInserts.push(row); return Promise.resolve([1]); });
      return b;
    }
    return thenableFor(() => []);
  });
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date('2026-09-23T12:00:00Z') };
  return db;
});

jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSms: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(() => 'msg') }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendChargeSuccess: jest.fn(), sendChargeFailed: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/billing-helpers', () => ({ isBillingDayMatch: jest.fn(() => true) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));
// Every attempt (the bounded retry loop tries 3 times) reports the SAME
// other-process claim — simulating a deploy overlap that outlasts the
// whole in-tick retry window.
jest.mock('../utils/customer-billing-lock', () => ({
  withCustomerBillingLock: jest.fn(async () => {
    const err = new Error('held elsewhere');
    err.code = 'BILLING_CLAIM_HELD_ELSEWHERE';
    throw err;
  }),
}));

const { logAutopay } = require('../services/autopay-log');
const BillingCron = require('../services/billing-cron');

const baseCustomer = {
  id: 'cust-locked', first_name: 'Lock', last_name: 'Contended',
  phone: '+15550009999', monthly_rate: 89, waveguard_tier: 'Silver',
  autopay_enabled: true, autopay_paused_until: null,
  autopay_payment_method_id: 'pm_1', billing_day: 1, billing_mode: 'monthly_membership',
};

beforeEach(() => {
  mockCustomers = [{ ...baseCustomer }];
  mockTermRows = [];
  mockPaymentsInserts = [];
  mockHealthAlertInserts = [];
  mockCollectedRow = null;
  jest.clearAllMocks();
});

// Codex #4682 r3 P1: the collector holding the lock past the retry window
// is usually mid-charge for THIS month. If its paid row has landed by the
// time the retries are exhausted, this customer is collected — no deferred
// 'failed' row may be written (it would show a balance the winner already
// took), and no alert.
test('when the competing collector has already landed this month\'s payment, nothing is deferred', async () => {
  mockCollectedRow = { id: 'pay-winner', status: 'paid' };

  const result = await BillingCron.processMonthlyBilling();

  expect(result.skipped).toBe(1);
  expect(mockPaymentsInserts).toHaveLength(0);
  expect(mockHealthAlertInserts).toHaveLength(0);
  expect(logAutopay).toHaveBeenCalledWith('cust-locked', 'skipped_already_paid', { paymentId: 'pay-winner' });
  expect(logAutopay).not.toHaveBeenCalledWith('cust-locked', 'skipped_lock_contention', expect.anything());
}, 15000);

test('a customer whose collection lock stays held elsewhere ends up with a durable next_retry_at work item and an alert', async () => {
  const result = await BillingCron.processMonthlyBilling();

  expect(result.skipped).toBe(1);
  expect(result.charged).toBe(0);

  expect(mockPaymentsInserts).toHaveLength(1);
  const row = mockPaymentsInserts[0];
  expect(row.customer_id).toBe('cust-locked');
  expect(row.status).toBe('failed');
  expect(row.retry_count).toBe(0);
  expect(row.next_retry_at).toBeInstanceOf(Date);
  // isMonthlyObligationRow (retry-collectibility.js) requires this marker,
  // and the retry sweep's own monthly branch matches on it too.
  expect(row.description).toEqual(expect.stringContaining('WaveGuard Monthly'));
  const meta = JSON.parse(row.metadata);
  expect(meta.type).toBe('monthly_autopay');
  expect(meta.billed_month).toMatch(/^\d{4}-\d{2}$/);
  expect(meta.deferred_reason).toBe('lock_contention');
  // Never-attempted shape GET /api/billing/balance keys its exclusion on.
  expect(row.stripe_payment_intent_id).toBeUndefined();

  expect(mockHealthAlertInserts).toHaveLength(1);
  expect(mockHealthAlertInserts[0].customer_id).toBe('cust-locked');
  expect(mockHealthAlertInserts[0].alert_type).toBe('billing_collection_deferred');

  expect(logAutopay).toHaveBeenCalledWith('cust-locked', 'skipped_lock_contention', expect.any(Object));
}, 15000);
