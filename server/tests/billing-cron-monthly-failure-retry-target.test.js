/**
 * Monthly dues failure arms THIS attempt's failed row (billing audit 2026-10-30, finding 8).
 *
 * processMonthlyBilling schedules the Day-3 retry after the customer billing lock is released. It used to pick
 * "the newest failed WaveGuard Monthly row since the month started", so an older month's retry rung that failed
 * in that gap got this month's retry_count/next_retry_at, and this month's failed row was left with no retry.
 * The failed row charge() recorded for the attempt rides the error as err.paymentRecord; that row is armed. The
 * query stays only as a fallback for a failure with no recorded row, held to this month's billed_month stamp.
 *
 * Harness mirrors billing-cron-billing-mode.test.js.
 */

let mockCustomers = [];
let mockPaymentUpdates = [];
// The payments.first() answer: a function of the billed_month the query asked for (null = no stamp filter).
let mockFailedRowFor = () => null;
let mockAskedMonths = [];

jest.mock('../models/db', () => {
  function thenableFor(resultFn, firstFn, table) {
    const b = { __raw: [] };
    for (const m of [
      'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'distinct', 'select', 'orderBy',
      'insert', 'returning', 'count', 'pluck', 'join', 'leftJoin',
    ]) b[m] = () => b;
    b.where = (...a) => {
      if (a[0] === 'id') b.__id = a[1];
      else if (a[0] && typeof a[0] === 'object' && a[0].id !== undefined) b.__id = a[0].id;
      if (a[0] && typeof a[0] === 'object' && a[0].status === 'failed') b.__failed = true;
      if (a[0] === 'description' && /WaveGuard Monthly/.test(String(a[2]))) b.__monthlyMarker = true;
      return b;
    };
    b.whereRaw = (sql, bindings) => { b.__raw.push({ sql, bindings }); return b; };
    b.update = async (patch) => {
      if (table === 'payments') mockPaymentUpdates.push({ id: b.__id, patch });
      return 1;
    };
    b.first = () => Promise.resolve(firstFn ? firstFn(b) : null);
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'sms_log') return { insert: async () => {} };
    if (table === 'customers') {
      return thenableFor(() => mockCustomers, (q) => mockCustomers.find((c) => String(c.id) === String(q.__id)) || null, table);
    }
    if (table === 'payments') {
      return thenableFor(() => [], (q) => {
        // Only the failure handler's lookup (failed + monthly marker) answers; every guard read sees no rows.
        if (!q.__failed || !q.__monthlyMarker) return null;
        const stamp = q.__raw.find((r) => /billed_month/.test(r.sql));
        if (stamp) mockAskedMonths.push(stamp.bindings[0]);
        return mockFailedRowFor(stamp ? stamp.bindings[0] : null);
      }, table);
    }
    return thenableFor(() => [], null, table);
  });
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date() };
  db.raw = (sql) => sql;
  return db;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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
// No payment-issue email leg: keeps the case on the retry arm, not the email queue.
jest.mock('../services/billing-delivery-channels', () => ({ billingChannelAllowed: jest.fn(() => false) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));

const StripeService = require('../services/stripe');
const BillingCron = require('../services/billing-cron');

const customer = {
  id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: '+15550001111',
  monthly_rate: 55.3, waveguard_tier: 'Bronze', autopay_enabled: true,
  autopay_paused_until: null, autopay_payment_method_id: 'pm_1', billing_day: 1,
  billing_mode: 'monthly_membership',
};

// An older month's retry rung that failed after this run's attempt: the newest failed monthly row by created_at.
const olderMonthRung = { id: 'rung-older-month', status: 'failed', metadata: { billed_month: '2000-01' } };

const thisEtMonth = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
}).format(new Date());

const armedIds = () => mockPaymentUpdates
  .filter((u) => u.patch && u.patch.retry_count === 0 && u.patch.next_retry_at)
  .map((u) => u.id);

beforeEach(() => {
  mockCustomers = [{ ...customer }];
  mockPaymentUpdates = [];
  mockAskedMonths = [];
  // Without a stamp filter the newest failed row is the older month's rung (the race).
  mockFailedRowFor = (month) => (month === null ? olderMonthRung : null);
  jest.clearAllMocks();
  StripeService.chargeMonthly.mockReset();
});

describe('processMonthlyBilling — monthly failure retry target', () => {
  test("arms the attempt's own failed row, never an older month's rung that failed in the gap", async () => {
    StripeService.chargeMonthly.mockRejectedValue(Object.assign(new Error('declined'), {
      paymentRecord: { id: 'attempt-this-month', status: 'failed', amount: 55.3 },
    }));
    await BillingCron.processMonthlyBilling();
    expect(armedIds()).toEqual(['attempt-this-month']);
    expect(mockAskedMonths).toEqual([]); // no lookup when the attempt row is known
  });

  test('no recorded attempt row: the fallback only takes a row stamped with this month, so the older rung stays untouched', async () => {
    StripeService.chargeMonthly.mockRejectedValue(new Error('declined'));
    await BillingCron.processMonthlyBilling();
    expect(mockAskedMonths).toEqual([thisEtMonth()]);
    expect(armedIds()).toEqual([]);
  });

  test("no recorded attempt row but this month's failed row exists: the fallback arms it", async () => {
    mockFailedRowFor = (month) => (month === thisEtMonth() ? { id: 'this-month-row', status: 'failed' } : olderMonthRung);
    StripeService.chargeMonthly.mockRejectedValue(new Error('declined'));
    await BillingCron.processMonthlyBilling();
    expect(armedIds()).toEqual(['this-month-row']);
  });
});
