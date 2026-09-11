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
let mockScheduledNotices = [];

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
    if (table === 'sms_log') return { insert: async (row) => { mockScheduledNotices.push(row); } };
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
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));

const StripeService = require('../services/stripe');
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
  mockScheduledNotices = [];
  jest.clearAllMocks();
  StripeService.charge.mockReset();
  StripeService.chargeOneTime.mockReset();
  StripeService.chargeMonthly.mockReset();
});

describe('processMonthlyBilling — billing_mode guard', () => {
  test.each(['PUSH_IN_FLIGHT', 'QUIET_HOURS_HOLD', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY'])('a %s failure notice keeps a durable retry and the attempt identity', async (code) => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-MM', billing_mode: 'monthly_membership' }];
    StripeService.chargeMonthly.mockRejectedValue(Object.assign(new Error('declined'), {
      paymentRecord: { id: 'attempt-1', amount: 55.3 },
    }));
    const sender = require('../services/messaging/send-customer-message').sendCustomerMessage;
    sender.mockResolvedValueOnce({ sent: false, deferred: true, code, nextAllowedAt: '2026-09-09T12:00:00Z' });
    await BillingCron.processMonthlyBilling();
    expect(mockScheduledNotices).toHaveLength(1);
    expect(mockScheduledNotices[0]).toMatchObject({ customer_id: 'cust-MM', status: 'scheduled' });
    const meta = JSON.parse(mockScheduledNotices[0].metadata);
    expect(meta).toMatchObject({ payment_id: 'attempt-1', retry_count: 0,
      entry_point: 'billing_failure_deferred', notificationEventKey: 'payment-problem:attempt:attempt-1:autopay_charge_failed',
    });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ notificationEventKey: meta.notificationEventKey }),
    }));
    expect(StripeService.chargeMonthly).toHaveBeenCalledTimes(1);
  });

  test('per_application customer is skipped and never reaches the charge path', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-PA', billing_mode: 'per_application' }];

    const result = await BillingCron.processMonthlyBilling();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-PA', 'skipped_billing_mode', {
      details: { billing_mode: 'per_application' },
    });
    expect(result.charged).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("annual_prepay mode skips even with NO live term — a naturally expired term must not fall into monthly dues (Codex round-5 P1); void/refund resets the mode at the term choke point instead", async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-AP', billing_mode: 'annual_prepay' }];
    mockTermRows = []; // expired/no coverage — renewal flow owns collection, never this cron
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_ap', amount: 55.3 });

    const result = await BillingCron.processMonthlyBilling();

    expect(logAutopay).toHaveBeenCalledWith('cust-AP', 'skipped_billing_mode', {
      details: { billing_mode: 'annual_prepay' },
    });
    expect(chargeMonthly).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  test('a void/refund-reset customer (mode back to NULL) charges normally again', async () => {
    // resetBillingModeAfterTermCancel returns manual-prepay customers to
    // NULL (legacy monthly) — the cron must then treat them as before.
    mockCustomers = [{ ...baseCustomer, id: 'cust-AP', billing_mode: null }];
    mockTermRows = [];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_ap', amount: 55.3 });

    await BillingCron.processMonthlyBilling();

    expect(logAutopay).not.toHaveBeenCalledWith('cust-AP', 'skipped_billing_mode', expect.anything());
    expect(chargeMonthly).toHaveBeenCalledWith('cust-AP');
  });

  test('annual_prepay mode WITH a live covering term is skipped by the mode guard before the term guard is even consulted', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-AP2', billing_mode: 'annual_prepay' }];
    mockTermRows = [{ customer_id: 'cust-AP2' }]; // live coverage

    const result = await BillingCron.processMonthlyBilling();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  test('NULL billing_mode (legacy/unclassified) keeps charging exactly as before', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-L', billing_mode: null }];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_1', amount: 55.3 });

    await BillingCron.processMonthlyBilling();

    expect(StripeService.chargeMonthly).toHaveBeenCalledTimes(1);
    expect(chargeMonthly).toHaveBeenCalledWith('cust-L');
  });

  test("explicit 'monthly_membership' charges like legacy", async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-MM', billing_mode: 'monthly_membership' }];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_2', amount: 55.3 });

    await BillingCron.processMonthlyBilling();

    expect(chargeMonthly).toHaveBeenCalledWith('cust-MM');
  });

  test('GUARD 3c: a tier-less NULL-mode row resolves per_visit and is never dues-charged (Codex r7 P1)', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-TL', billing_mode: null, waveguard_tier: null }];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_x', amount: 55.3 });

    const result = await BillingCron.processMonthlyBilling();

    expect(chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-TL', 'skipped_unclassified_lane', expect.objectContaining({
      details: expect.objectContaining({ resolved_mode: 'per_visit' }),
    }));
    expect(result.skipped).toBe(1);
  });

  test('GUARD 3c: a sentinel-tier NULL-mode row (Commercial) is never dues-charged', async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-CM', billing_mode: null, waveguard_tier: 'Commercial' }];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_y', amount: 55.3 });

    await BillingCron.processMonthlyBilling();

    expect(chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-CM', 'skipped_unclassified_lane', expect.anything());
  });

  test("GUARD 3c: an explicit 'monthly_membership' row charges even when tier fields are gone", async () => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-EM', billing_mode: 'monthly_membership', waveguard_tier: null }];
    const chargeMonthly = StripeService.chargeMonthly.mockResolvedValue({ id: 'pay_z', amount: 55.3 });

    await BillingCron.processMonthlyBilling();

    expect(chargeMonthly).toHaveBeenCalledWith('cust-EM');
  });
});


describe('monthly payment settlement reporting', () => {
  test.each(['processing', 'paid'])('%s preserves returned amount and sends receipts only after settlement', async status => {
    mockCustomers = [{ ...baseCustomer, id: 'cust-state', billing_mode: 'monthly_membership' }];
    StripeService.chargeMonthly.mockResolvedValue({ id: 'pay-state', status, amount: '102.90' });
    const result = await BillingCron.processMonthlyBilling();
    expect(result).toMatchObject({ charged: status === 'paid' ? 1 : 0, processing: status === 'processing' ? 1 : 0 });
    expect(logAutopay).toHaveBeenCalledWith('cust-state', status === 'paid' ? 'charge_success' : 'charge_processing', expect.objectContaining({ amountCents: 10290, paymentId: 'pay-state' }));
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(status === 'paid' ? 1 : 0);
  });
});
