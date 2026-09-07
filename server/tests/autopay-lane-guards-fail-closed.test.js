/**
 * Lane guards FAIL CLOSED (2026-08-29 incident).
 *
 * The autopay pre-charge reminder and the monthly billing cron both keyed
 * their billing_mode lane guard on a `db.schema.hasColumn` probe wrapped in
 * try/catch that fell back to the LEGACY unfiltered shape. A Railway deploy
 * swap at 09:00:53 made the probe throw exactly as the 09:00 cron fired, the
 * lane filter silently dropped, and 12 prepay / per-application customers
 * were texted about a "monthly charge" that would never run. The cron had
 * the identical shape for CHARGING.
 *
 * These tests pin the fix: neither job consults db.schema at all (the mock
 * has no `schema` — a probe would throw), the reminder ALWAYS applies
 * MONTHLY_LANE_SQL, and the cron ALWAYS selects billing_mode.
 */

let mockCustomers = [];
// Row the pre-dispatch refetch (`.first()`) returns; undefined = the batch row.
let mockFreshCustomer;
const mockCalls = { whereRaw: [], select: [] };

jest.mock('../models/db', () => {
  function thenableFor(resultFn) {
    const b = {};
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'distinct', 'orderBy', 'update', 'insert', 'returning',
      'count', 'pluck', 'join', 'leftJoin',
    ]) b[m] = () => b;
    b.whereRaw = (sql) => { mockCalls.whereRaw.push(String(sql)); return b; };
    b.select = (...cols) => { mockCalls.select.push(cols.flat()); return b; };
    b.first = () => Promise.resolve(mockFreshCustomer !== undefined ? mockFreshCustomer : (resultFn()[0] || null));
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'customers') return thenableFor(() => mockCustomers);
    return thenableFor(() => []);
  });
  // Deliberately NO db.schema: any hasColumn/hasTable probe throws a
  // TypeError. The fixed code must never reach for it.
  db.fn = { now: () => new Date('2026-08-29T13:00:00Z') };
  return db;
});

jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn(() => Promise.resolve()),
  eventExistsRecently: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  // Mirrors the wrapper's preDispatchCheck contract: a caller closure that
  // does not return { ok: true } blocks the send with its code/reason.
  sendCustomerMessage: jest.fn(async (input) => {
    if (typeof input.preDispatchCheck === 'function') {
      const verdict = await input.preDispatchCheck();
      if (!verdict || verdict.ok !== true) return { sent: false, blocked: true, code: verdict?.code || 'PRE_DISPATCH_CHECK_FAILED', reason: verdict?.reason };
    }
    return { sent: true };
  }),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(() => Promise.resolve('Hello! Your auto-pay processes soon.')),
  renderRequiredSmsTemplate: jest.fn(() => Promise.resolve('msg')),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendChargeSuccess: jest.fn(), sendChargeFailed: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/billing-helpers', () => ({ isBillingDayMatch: jest.fn(() => true) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));
jest.mock('../services/twilio', () => ({ sendSms: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({
  activatePaidPendingTerms: jest.fn(() => Promise.resolve()),
  getActivelyCoveredCustomerIds: jest.fn(() => Promise.resolve(new Set())),
  getPaymentPendingCustomerIds: jest.fn(() => Promise.resolve(new Set())),
}));

const { MONTHLY_LANE_SQL } = require('../services/billing-lane');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { logAutopay } = require('../services/autopay-log');
const StripeService = require('../services/stripe');

beforeEach(() => {
  mockCustomers = [];
  mockFreshCustomer = undefined;
  mockCalls.whereRaw.length = 0;
  mockCalls.select.length = 0;
  jest.clearAllMocks();
  StripeService.charge.mockReset();
  StripeService.chargeOneTime.mockReset();
  StripeService.chargeMonthly.mockReset();
});

describe('sendPreChargeReminders — lane filter is unconditional', () => {
  test('applies MONTHLY_LANE_SQL without any schema probe (no db.schema in the mock)', async () => {
    const { sendPreChargeReminders } = require('../services/autopay-notifications');
    mockCustomers = [];

    await expect(sendPreChargeReminders()).resolves.toEqual(expect.objectContaining({ sent: 0 }));

    expect(mockCalls.whereRaw).toContain(MONTHLY_LANE_SQL);
  });

  test('a customer the DB returns is texted only because the SQL lane filter admitted it — no JS-side fallback path exists', async () => {
    const { sendPreChargeReminders } = require('../services/autopay-notifications');
    mockCustomers = [{
      id: 'cust-monthly', first_name: 'Member', phone: '+15550001111', monthly_rate: '33.33',
      autopay_paused_until: null, waveguard_tier: 'Bronze', billing_mode: 'monthly_membership',
    }];

    const r = await sendPreChargeReminders();

    expect(mockCalls.whereRaw).toContain(MONTHLY_LANE_SQL);
    expect(r.sent).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // The owner digest classifies against the RESOLVED lane AT SEND TIME (#3607).
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toEqual({ original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership' });
    expect(logAutopay).toHaveBeenCalledWith('cust-monthly', 'pre_charge_reminder_sent', expect.any(Object));
  });
});

describe('sendPreChargeReminders — stamp is the RESOLVED lane (codex #3607 r5)', () => {
  test('a legacy NULL-mode member with a real tier + rate stamps monthly_membership, not null', async () => {
    const { sendPreChargeReminders } = require('../services/autopay-notifications');
    mockCustomers = [{
      id: 'cust-legacy', first_name: 'Legacy', phone: '+15550003333', monthly_rate: '44.00',
      autopay_paused_until: null, waveguard_tier: 'Silver', billing_mode: null,
    }];

    await sendPreChargeReminders();

    expect(sendCustomerMessage.mock.calls[0][0].metadata.billing_mode_at_send).toBe('monthly_membership');
  });

  test('a customer moved out of the monthly lane after the batch query is blocked by preDispatchCheck at the wrapper boundary, never texted (codex r7 + r8)', async () => {
    const { sendPreChargeReminders } = require('../services/autopay-notifications');
    mockCustomers = [{
      id: 'cust-moved', first_name: 'Moved', phone: '+15550004444', monthly_rate: '55.00',
      autopay_paused_until: null, waveguard_tier: 'Bronze', billing_mode: 'monthly_membership',
    }];
    mockFreshCustomer = { billing_mode: 'per_application', waveguard_tier: 'Bronze', monthly_rate: '55.00', autopay_enabled: true, active: true, deleted_at: null };

    const r = await sendPreChargeReminders();

    // The wrapper was entered (that IS the boundary) but its preDispatchCheck
    // refused, so nothing reached the provider and no reminder was logged.
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(logAutopay).not.toHaveBeenCalledWith('cust-moved', 'pre_charge_reminder_sent', expect.any(Object));
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
  });

  test('a customer who disappeared (refetch null) is skipped — fail closed', async () => {
    const { sendPreChargeReminders } = require('../services/autopay-notifications');
    mockCustomers = [{
      id: 'cust-gone', first_name: 'Gone', phone: '+15550005555', monthly_rate: '55.00',
      autopay_paused_until: null, waveguard_tier: 'Bronze', billing_mode: 'monthly_membership',
    }];
    mockFreshCustomer = null;

    const r = await sendPreChargeReminders();

    expect(logAutopay).not.toHaveBeenCalledWith('cust-gone', 'pre_charge_reminder_sent', expect.any(Object));
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('processMonthlyBilling — billing_mode is always selected', () => {
  test('selects billing_mode unconditionally (no hasColumn probe) so GUARD 3b can never go inert', async () => {
    const BillingCron = require('../services/billing-cron');
    mockCustomers = [];

    await BillingCron.processMonthlyBilling();

    const customerSelect = mockCalls.select.find((cols) => cols.includes('monthly_rate') && cols.includes('billing_day'));
    expect(customerSelect).toBeDefined();
    expect(customerSelect).toContain('billing_mode');
  });

  test('explicit per_application customer is skipped by GUARD 3b, never charged', async () => {
    const BillingCron = require('../services/billing-cron');
    mockCustomers = [{
      id: 'cust-PA', first_name: 'Applicant', last_name: 'X', phone: '+15550002222', monthly_rate: 55.3,
      waveguard_tier: 'Bronze', autopay_enabled: true, autopay_paused_until: null,
      autopay_payment_method_id: 'pm_1', billing_day: 1, billing_mode: 'per_application',
    }];

    const result = await BillingCron.processMonthlyBilling();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-PA', 'skipped_billing_mode', { details: { billing_mode: 'per_application' } });
    expect(result.charged).toBe(0);
  });
});
