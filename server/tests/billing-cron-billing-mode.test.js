/**
 * billing_mode guard (owner ruling 2026-07-09): the monthly billing cron is
 * the MONTHLY MEMBERSHIP subscription biller only. Estimate-flow customers
 * bill per visit ('per_application' — completion collects the application
 * fee) and annual-prepay customers paid up front ('annual_prepay'), so the
 * cron must skip both even when active + monthly_rate > 0 + autopay on.
 * NULL / 'monthly_membership' preserves legacy behavior exactly.
 *
 * Mirrors the billing-cron-annual-prepay.test.js harness.
 */

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
  db.fn = { now: () => new Date('2026-07-09T12:00:00Z') };
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
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));

const PaymentRouter = require('../services/payment-router');
const { logAutopay } = require('../services/autopay-log');
const BillingCron = require('../services/billing-cron');

const baseCustomer = {
  first_name: 'Test', last_name: 'Customer', phone: '+15550001111',
  monthly_rate: 55.3, waveguard_tier: 'Bronze', autopay_enabled: true,
  autopay_paused_until: null, autopay_payment_method_id: 'pm_1', billing_day: 1,
};

beforeEach(() => {
  mockCustomers = [];
  mockTermRows = [];
  jest.clearAllMocks();
});

describe('processMonthlyBilling — billing_mode guard', () => {
  test('per_application customer is skipped and never reaches the charge path', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-PA', billing_mode: 'per_application' }];

    const result = await BillingCron.processMonthlyBilling();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-PA', 'skipped_billing_mode', {
      details: { billing_mode: 'per_application' },
    });
    expect(result.charged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('annual_prepay billing_mode is skipped even with no term row (belt-and-suspenders)', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-AP', billing_mode: 'annual_prepay' }];
    mockTermRows = []; // no active term — the mode alone must protect

    const result = await BillingCron.processMonthlyBilling();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-AP', 'skipped_billing_mode', {
      details: { billing_mode: 'annual_prepay' },
    });
    expect(result.skipped).toBe(1);
  });

  test('NULL billing_mode (legacy/unclassified) keeps charging exactly as before', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-L', billing_mode: null }];
    const chargeMonthly = jest.fn(() => Promise.resolve({ id: 'pay_1', amount: 55.3 }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ chargeMonthly });

    await BillingCron.processMonthlyBilling();

    expect(PaymentRouter.getServiceForCustomer).toHaveBeenCalledWith('cust-L');
    expect(chargeMonthly).toHaveBeenCalledWith('cust-L');
  });

  test("explicit 'monthly_membership' charges like legacy", async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-MM', billing_mode: 'monthly_membership' }];
    const chargeMonthly = jest.fn(() => Promise.resolve({ id: 'pay_2', amount: 55.3 }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ chargeMonthly });

    await BillingCron.processMonthlyBilling();

    expect(chargeMonthly).toHaveBeenCalledWith('cust-MM');
  });
});
