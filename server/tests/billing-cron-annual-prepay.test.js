/**
 * Annual-prepay customers must never be monthly-charged while their coverage
 * term is active — they paid for the whole period up front. The active term is
 * the billing-suppression source of truth; monthly_rate stays on the profile
 * for renewal/reporting math and is NOT zeroed.
 *
 * Covers:
 *   - getActivelyCoveredCustomerIds() resolves the covered set from active terms
 *   - billing-cron skips a covered customer even when active + monthly_rate > 0
 *     + autopay on (it never reaches the charge path)
 *   - an uncovered customer on their billing day reaches the charge path
 */

const { etDateString } = require('../utils/datetime-et');

// Mutable fixtures driving the shared knex mock. `mock`-prefixed so the
// jest.mock factory may reference them (jest hoists the factory above them).
let mockCustomers = [];
let mockTermRows = [];

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
    return thenableFor(() => []);
  });
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date('2026-06-13T12:00:00Z') };
  return db;
});

// Charge path + side-effect deps — no-op so import + the charged branch are safe.
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
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));

const PaymentRouter = require('../services/payment-router');
const { logAutopay } = require('../services/autopay-log');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const BillingCron = require('../services/billing-cron');

beforeEach(() => {
  mockCustomers = [];
  mockTermRows = [];
  jest.clearAllMocks();
});

describe('getActivelyCoveredCustomerIds', () => {
  test('returns the set of customer ids with an active covering term', async () => {
    mockTermRows = [{ customer_id: 'cust-A' }, { customer_id: 'cust-B' }];
    const ids = await AnnualPrepayRenewals.getActivelyCoveredCustomerIds(etDateString());
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has('cust-A')).toBe(true);
    expect(ids.has('cust-B')).toBe(true);
    expect(ids.size).toBe(2);
  });

  test('returns an empty set when no term covers the date', async () => {
    mockTermRows = [];
    const ids = await AnnualPrepayRenewals.getActivelyCoveredCustomerIds(etDateString());
    expect(ids.size).toBe(0);
  });
});

describe('processMonthlyBilling — annual-prepay suppression', () => {
  test('skips an annual-prepay customer even with monthly_rate > 0 + autopay on', async () => {
    mockCustomers = [{
      id: 'cust-A', first_name: 'Test', last_name: 'Prepay', phone: '+15550001111',
      monthly_rate: 33.0, waveguard_tier: 'Bronze', autopay_enabled: true,
      autopay_paused_until: null, autopay_payment_method_id: 'pm_1', billing_day: 1,
    }];
    mockTermRows = [{ customer_id: 'cust-A' }]; // active coverage

    const result = await BillingCron.processMonthlyBilling();

    // Never reached the charge path…
    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    // …and was logged + counted as a skip with the prepay reason.
    expect(logAutopay).toHaveBeenCalledWith('cust-A', 'skipped_annual_prepay');
    expect(result.charged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('an uncovered customer on their billing day reaches the charge path', async () => {
    mockCustomers = [{
      id: 'cust-Z', first_name: 'Test', last_name: 'Monthly', phone: '+15550002222',
      monthly_rate: 33.0, waveguard_tier: 'Bronze', autopay_enabled: true,
      autopay_paused_until: null, autopay_payment_method_id: 'pm_2', billing_day: 1,
    }];
    mockTermRows = []; // no coverage
    const chargeMonthly = jest.fn(() => Promise.resolve({ id: 'pay_1', amount: 33 }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ chargeMonthly });

    await BillingCron.processMonthlyBilling();

    expect(PaymentRouter.getServiceForCustomer).toHaveBeenCalledWith('cust-Z');
    expect(chargeMonthly).toHaveBeenCalledWith('cust-Z');
  });

  test('skips payment-pending annual-prepay customers until the invoice is resolved', async () => {
    mockCustomers = [{
      id: 'cust-P', first_name: 'Test', last_name: 'PendingPrepay', phone: '+15550003333',
      monthly_rate: 55.0, waveguard_tier: 'Bronze', autopay_enabled: true,
      autopay_paused_until: null, autopay_payment_method_id: 'pm_3', billing_day: 1,
    }];
    mockTermRows = []; // no active paid coverage yet
    const pendingSpy = jest
      .spyOn(AnnualPrepayRenewals, 'getPaymentPendingCustomerIds')
      .mockResolvedValue(new Set(['cust-P']));

    try {
      const result = await BillingCron.processMonthlyBilling();

      expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
      expect(logAutopay).toHaveBeenCalledWith('cust-P', 'skipped_annual_prepay_pending');
      expect(result.charged).toBe(0);
      expect(result.skipped).toBe(1);
    } finally {
      pendingSpy.mockRestore();
    }
  });
});
