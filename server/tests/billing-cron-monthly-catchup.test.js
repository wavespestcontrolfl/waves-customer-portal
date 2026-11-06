/**
 * processMonthlyBilling({ billingDate }) — the run the monthly catch-up makes for a missed
 * billing date (services/billing-monthly-catchup.js, GATE_BILLING_MONTHLY_CATCHUP, owner
 * 2026-11-06 O1). It bills that date's billing_day cohort through the same guards and charge
 * path as the 8:00 run, and must never charge a customer twice or send a second notice:
 *
 * - after a completed 8:00 run it charges nobody;
 * - after a killed (partial) run it charges only customers with no attempt this month;
 * - a card the killed run DECLINED is not tried again, and no second decline text or email
 *   goes out (the decline already armed the retry ladder and sent the one notice);
 * - a decline from BEFORE the date being made up (a Charge now days earlier) does not fence:
 *   the 8:00 run would have tried the card that day, so the catch-up does too;
 * - a date outside this ET month is refused before anything is read.
 *
 * The payments table is an in-memory ledger. findCollectedMonthlyPayment and
 * monthlyAttemptHasRecovery are answered from it with the predicate's real shape (billed_month
 * stamp, status list, onOrAfter date floor) and the real monthlyAttemptRecovery rule; the SQL
 * itself is pinned in retry-collectibility.test.js. Harness after
 * billing-cron-collection-hold.test.js. Fixed clock: Thursday 2026-11-12, 10:29 AM ET.
 */
let mockCustomers = [];
let mockLedger = [];
let mockDeclines = new Set();
let mockNextId = 1;

jest.mock('../models/db', () => {
  function thenableFor(resultFn, firstFn, table) {
    const b = {};
    for (const m of [
      'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw',
      'distinct', 'select', 'orderBy', 'insert', 'returning', 'count', 'pluck', 'join', 'leftJoin',
    ]) b[m] = () => b;
    b.where = (...a) => {
      if (a[0] === 'id') b.__id = a[1];
      else if (a[0] && typeof a[0] === 'object' && a[0].id !== undefined) b.__id = a[0].id;
      return b;
    };
    b.update = async (patch) => {
      if (table === 'payments') {
        const row = mockLedger.find((r) => r.id === b.__id);
        if (row) Object.assign(row, patch);
      }
      return 1;
    };
    b.first = () => Promise.resolve(firstFn ? firstFn(b) : null);
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'customers') {
      return thenableFor(() => mockCustomers, (q) => mockCustomers.find((c) => String(c.id) === String(q.__id)) || null, table);
    }
    return thenableFor(() => [], null, table);
  });
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date() };
  db.raw = (sql) => sql;
  return db;
});

jest.mock('../services/retry-collectibility', () => {
  const actual = jest.requireActual('../services/retry-collectibility');
  const monthRows = (customerId, monthKey, statuses, onOrAfter) => mockLedger.filter((r) => r.customer_id === customerId
    && statuses.includes(r.status) && r.billed_month === monthKey && (!onOrAfter || r.payment_date >= onOrAfter));
  return {
    ...actual,
    findCollectedMonthlyPayment: jest.fn(async (customerId, { monthKey }, { statuses = ['paid', 'processing'], onOrAfter = null } = {}) => (
      monthRows(customerId, monthKey, statuses, onOrAfter)[0]
    )),
    monthlyAttemptHasRecovery: jest.fn(async (customerId, { monthKey }, { onOrAfter = null } = {}) => (
      monthRows(customerId, monthKey, ['failed', 'refunded'], onOrAfter)
        .some((r) => actual.monthlyAttemptRecovery(r) !== actual.ATTEMPT_RECOVERY.NONE)
    )),
    hasUnresolvedSiblingStripeOutcome: jest.fn(async () => ({ blocked: false })),
    deriveMonthlyChargeIdempotencyKey: jest.fn(async (customerId) => `autopay_monthly_${customerId}_test`),
  };
});
jest.mock('../services/stripe', () => ({ charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn() }));
jest.mock('../utils/customer-billing-lock', () => ({ withCustomerBillingLock: jest.fn(async (_id, fn) => fn()) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  activatePaidPendingTerms: jest.fn(async () => {}),
  getActivelyCoveredCustomerIds: jest.fn(async () => new Set()),
  getPaymentPendingCustomerIds: jest.fn(async () => new Set()),
}));
jest.mock('../services/health-alert-insert', () => ({ insertHealthAlert: jest.fn(async () => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
jest.mock('../services/twilio', () => ({ sendSms: jest.fn(), sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/account-membership-email', () => ({}));
// The payment-issue email leg is ON, so a decline queues its one retry-notice email.
jest.mock('../services/billing-delivery-channels', () => ({ billingChannelAllowed: jest.fn(() => true) }));
jest.mock('../services/billing-retry-email-obligation', () => ({
  pendingDescriptor: jest.fn(() => ({ notice: 'retry' })),
  mergePendingDescriptor: jest.fn(() => 'merged-metadata'),
  reconcilePendingNotices: jest.fn(async () => {}),
  sendPaymentRetryNotice: jest.fn(async () => {}),
}));

const StripeService = require('../services/stripe');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const BillingRetryEmail = require('../services/billing-retry-email-obligation');
const { logAutopay } = require('../services/autopay-log');
const { findCollectedMonthlyPayment, monthlyAttemptHasRecovery } = require('../services/retry-collectibility');
const BillingCron = require('../services/billing-cron');

const TODAY = '2026-11-12';
const MONTH = '2026-11';

const customer = (id, billingDay) => ({
  id, first_name: 'Test', last_name: `Customer ${id}`, phone: '+15550000000', monthly_rate: 55.3,
  waveguard_tier: 'Bronze', autopay_enabled: true, autopay_paused_until: null,
  autopay_payment_method_id: `pm_${id}`, billing_day: billingDay, billing_mode: 'monthly_membership',
  status: 'active', active: true,
});

const ledgerRow = (customerId, status, paymentDate, extra = {}) => {
  const row = { id: `pay-${mockNextId++}`, customer_id: customerId, status, payment_date: paymentDate, billed_month: MONTH, amount: 56.9, metadata: {}, ...extra };
  mockLedger.push(row);
  return row;
};

const chargedIds = () => StripeService.chargeMonthly.mock.calls.map(([id]) => id);
const events = (type) => logAutopay.mock.calls.filter(([, t]) => t === type).map(([id, , opts]) => ({ id, opts }));

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-11-12T15:29:00Z'));
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  mockNextId = 1;
  mockLedger = [];
  mockDeclines = new Set(['cust-c']);
  // A, B, C bill on the 12th (today); D bills on the 11th.
  mockCustomers = [customer('cust-a', 12), customer('cust-b', 12), customer('cust-c', 12), customer('cust-d', 11)];
  StripeService.chargeMonthly.mockImplementation(async (customerId) => {
    if (mockDeclines.has(customerId)) {
      const failed = ledgerRow(customerId, 'failed', TODAY, { next_retry_at: null });
      throw Object.assign(new Error('Payment processing failed'), { paymentRecord: failed });
    }
    return ledgerRow(customerId, 'paid', TODAY);
  });
});

const catchUpRun = (billingDate = TODAY) => BillingCron.processMonthlyBilling({ billingDate });

describe('catch-up after a completed 8:00 run', () => {
  test('charges nobody and sends nothing more', async () => {
    const first = await BillingCron.processMonthlyBilling();
    expect(first).toMatchObject({ charged: 2, failed: 1, billingDate: TODAY });
    expect(chargedIds()).toEqual(['cust-a', 'cust-b', 'cust-c']);
    const textsAfter8 = sendCustomerMessage.mock.calls.length;
    expect(textsAfter8).toBe(3); // two receipts + one decline notice
    expect(BillingRetryEmail.reconcilePendingNotices).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    const second = await catchUpRun();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BillingRetryEmail.reconcilePendingNotices).not.toHaveBeenCalled();
    expect(BillingRetryEmail.sendPaymentRetryNotice).not.toHaveBeenCalled();
    expect(second).toMatchObject({ charged: 0, processing: 0, failed: 0, skipped: 3, billingDate: TODAY });
    expect(events('skipped_already_paid').map((e) => e.id)).toEqual(['cust-a', 'cust-b']);
    expect(events('skipped_already_attempted').map((e) => e.id)).toEqual(['cust-c']);
  });
});

describe('catch-up after a killed (partial) 8:00 run', () => {
  test('charges only the customer the killed run never reached', async () => {
    ledgerRow('cust-a', 'paid', TODAY);
    ledgerRow('cust-c', 'failed', TODAY, { next_retry_at: '2026-11-14T15:00:00.000Z', retry_count: 0 });
    const out = await catchUpRun();
    expect(chargedIds()).toEqual(['cust-b']);
    expect(out).toMatchObject({ charged: 1, skipped: 2, failed: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // cust-b's receipt only
  });
});

describe('a card the killed run declined earlier the same day', () => {
  test.each([
    ['declined (failed row, retry armed)', 'failed'],
    ['refunded after collection', 'refunded'],
  ])('%s: not tried again, no second decline text or email', async (_label, status) => {
    const prior = ledgerRow('cust-c', status, TODAY, { next_retry_at: status === 'failed' ? '2026-11-14T15:00:00.000Z' : null });
    mockCustomers = [customer('cust-c', 12)];
    const out = await catchUpRun();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BillingRetryEmail.pendingDescriptor).not.toHaveBeenCalled();
    expect(BillingRetryEmail.reconcilePendingNotices).not.toHaveBeenCalled();
    expect(BillingRetryEmail.sendPaymentRetryNotice).not.toHaveBeenCalled();
    expect(events('charge_failed')).toEqual([]);
    expect(events('skipped_already_attempted')).toEqual([{
      id: 'cust-c',
      opts: { paymentId: prior.id, details: { source: 'autopay_catch_up', billed_month: MONTH, billing_date: TODAY, recovery_path: true } },
    }]);
    expect(out).toMatchObject({ charged: 0, failed: 0, skipped: 1, unresolvedCustomerIds: [] });
    // The prior attempt's row is left exactly as the killed run wrote it.
    expect(mockLedger).toEqual([prior]);
  });

  test('the fence asks for this month\'s failed/refunded attempts dated on or after the billing date', async () => {
    mockCustomers = [customer('cust-a', 12)];
    await catchUpRun();
    expect(findCollectedMonthlyPayment).toHaveBeenCalledWith('cust-a', expect.objectContaining({ monthKey: MONTH }), {
      statuses: ['failed', 'refunded'], withDuesInvoice: false, onOrAfter: TODAY,
    });
  });

  test('a decline from before the date being made up does not fence: the card is tried, as the 8:00 run would', async () => {
    ledgerRow('cust-a', 'failed', '2026-11-05', { next_retry_at: null });
    mockCustomers = [customer('cust-a', 12)];
    mockDeclines = new Set();
    const out = await catchUpRun();
    expect(chargedIds()).toEqual(['cust-a']);
    expect(out).toMatchObject({ charged: 1 });
  });
});

describe('which cohort a catch-up date bills', () => {
  test('a missed earlier date bills that day\'s billing_day cohort only', async () => {
    const out = await catchUpRun('2026-11-11');
    expect(chargedIds()).toEqual(['cust-d']);
    expect(out).toMatchObject({ charged: 1, billingDate: '2026-11-11' });
  });

  test.each([
    ['an earlier month', '2026-10-31'],
    ['a future date', '2026-11-13'],
    ['a malformed date', '11/12/2026'],
  ])('%s is refused before anything is read or charged', async (_label, billingDate) => {
    const db = require('../models/db');
    db.mockClear();
    await expect(catchUpRun(billingDate)).rejects.toThrow(/is not a day of this ET month up to today/);
    expect(db).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
  });
});

describe('the 8:00 run (no billingDate) is unchanged', () => {
  test('it bills today\'s cohort and never asks the catch-up fence', async () => {
    mockDeclines = new Set();
    await BillingCron.processMonthlyBilling();
    expect(chargedIds()).toEqual(['cust-a', 'cust-b', 'cust-c']);
    for (const call of findCollectedMonthlyPayment.mock.calls) expect(call[2]).toBeUndefined();
    expect(monthlyAttemptHasRecovery).not.toHaveBeenCalled();
  });
});

// Codex pre-push P1 on d118ee1388: a customer the run could not reach before the charge, with
// nothing armed, must not be lost when the catch-up marks the date finished. The run names
// those customers (unresolvedCustomerIds) so the catch-up keeps the date; a re-run of the
// same date bills only them.
describe('unresolved customers: a failure before the charge with nothing armed', () => {
  const collected = findCollectedMonthlyPayment.getMockImplementation();
  const failLookupOnceFor = (customerId) => {
    let failed = false;
    findCollectedMonthlyPayment.mockImplementation(async (id, ...rest) => {
      if (id === customerId && !failed) { failed = true; throw new Error('connection terminated'); }
      return collected(id, ...rest);
    });
  };
  afterEach(() => findCollectedMonthlyPayment.mockImplementation(collected));

  test('run the date twice: the first run fails one customer before the charge; the second bills only that customer', async () => {
    failLookupOnceFor('cust-b');
    const first = await catchUpRun();
    expect(chargedIds()).toEqual(['cust-a', 'cust-c']);
    expect(first).toMatchObject({ charged: 1, failed: 2, unresolvedCustomerIds: ['cust-b'] });
    const textsAfterFirst = sendCustomerMessage.mock.calls.length;
    const emailsAfterFirst = BillingRetryEmail.reconcilePendingNotices.mock.calls.length;

    StripeService.chargeMonthly.mockClear();
    const second = await catchUpRun();
    expect(chargedIds()).toEqual(['cust-b']);
    expect(second).toMatchObject({ charged: 1, failed: 0, skipped: 2, unresolvedCustomerIds: [] });
    // cust-b's receipt is the only new message; cust-c's decline is not repeated.
    expect(sendCustomerMessage.mock.calls.length).toBe(textsAfterFirst + 1);
    expect(BillingRetryEmail.reconcilePendingNotices.mock.calls.length).toBe(emailsAfterFirst);
    expect(mockLedger.filter((r) => r.status === 'paid').map((r) => r.customer_id).sort()).toEqual(['cust-a', 'cust-b']);
  });

  test('a recorded decline is not unresolved: its armed retry row is the recovery', async () => {
    const out = await catchUpRun();
    expect(out.failed).toBe(1);
    expect(out.unresolvedCustomerIds).toEqual([]);
    expect(mockLedger.find((r) => r.customer_id === 'cust-c').next_retry_at).toEqual(expect.any(String));
  });

  test('an error outside the charge (nothing recorded, nothing armed) is unresolved, on the 8:00 run too', async () => {
    StripeService.chargeMonthly.mockImplementation(async (customerId) => {
      if (customerId === 'cust-a') throw new Error('customer read failed');
      return ledgerRow(customerId, 'paid', TODAY);
    });
    const out = await BillingCron.processMonthlyBilling();
    expect(out.unresolvedCustomerIds).toEqual(['cust-a']);
    expect(sendCustomerMessage.mock.calls.every(([msg]) => msg.customerId !== 'cust-a')).toBe(true);
  });
});

// Codex pre-push P1 on f8d2b24abf: charge() records the failed row before billing-cron arms
// next_retry_at. A run killed between those two writes leaves a bare failed row that the retry
// sweep never selects. The catch-up fence still never charges it (no text, no email), but it
// reports the customer unresolved, so the bookmark holds and the office is told.
describe('a bare failed row: the run died after the failed-row insert, before the retry arm', () => {
  const bareRow = (customerId, extra = {}) => ledgerRow(customerId, 'failed', TODAY, { next_retry_at: null, retry_count: 0, superseded_by_payment_id: null, ...extra });
  const expectNothingSent = () => {
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BillingRetryEmail.pendingDescriptor).not.toHaveBeenCalled();
    expect(BillingRetryEmail.reconcilePendingNotices).not.toHaveBeenCalled();
    expect(BillingRetryEmail.sendPaymentRetryNotice).not.toHaveBeenCalled();
  };

  test('is reported unresolved and never charged, texted or emailed; the row is left as it is', async () => {
    const prior = bareRow('cust-c');
    mockCustomers = [customer('cust-c', 12)];
    const out = await catchUpRun();
    expectNothingSent();
    expect(out).toMatchObject({ charged: 0, failed: 0, skipped: 1, unresolvedCustomerIds: ['cust-c'] });
    expect(events('skipped_already_attempted')).toEqual([{
      id: 'cust-c',
      opts: { paymentId: prior.id, details: { source: 'autopay_catch_up', billed_month: MONTH, billing_date: TODAY, recovery_path: false } },
    }]);
    expect(mockLedger).toEqual([{ ...prior }]);
    expect(monthlyAttemptHasRecovery).toHaveBeenCalledWith('cust-c', expect.objectContaining({ monthKey: MONTH }), { onOrAfter: TODAY });
  });

  test.each([
    ['armed for the retry sweep', { next_retry_at: '2026-11-14T15:00:00.000Z' }],
    ['ambiguous outcome, parked', { metadata: { ambiguous_outcome: true }, superseded_by_payment_id: 'self' }],
    ['ambiguous outcome, park write lost', { metadata: { ambiguous_outcome: true } }],
    ['SCA-parked (requires_action, unarmed on purpose)', { metadata: { requires_action: true } }],
    ['ladder exhausted', { retry_count: 3 }],
  ])('%s: not reported, not charged', async (_label, extra) => {
    bareRow('cust-c', extra);
    mockCustomers = [customer('cust-c', 12)];
    const out = await catchUpRun();
    expectNothingSent();
    expect(out).toMatchObject({ charged: 0, skipped: 1, unresolvedCustomerIds: [] });
  });

  test('a refunded row is not reported', async () => {
    ledgerRow('cust-c', 'refunded', TODAY, { next_retry_at: null });
    mockCustomers = [customer('cust-c', 12)];
    const out = await catchUpRun();
    expectNothingSent();
    expect(out.unresolvedCustomerIds).toEqual([]);
  });

  test('run the date twice after the killed run: the first bills only the unreached customer; both report the bare row, neither charges it', async () => {
    ledgerRow('cust-a', 'paid', TODAY);
    bareRow('cust-c');
    const first = await catchUpRun();
    expect(chargedIds()).toEqual(['cust-b']);
    expect(first).toMatchObject({ charged: 1, skipped: 2, unresolvedCustomerIds: ['cust-c'] });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // cust-b's receipt only

    jest.clearAllMocks();
    const second = await catchUpRun();
    expectNothingSent();
    expect(second).toMatchObject({ charged: 0, skipped: 3, unresolvedCustomerIds: ['cust-c'] });
    expect(mockLedger.filter((r) => r.customer_id === 'cust-c')).toHaveLength(1);
  });

  test('a failed recovery read under the lock is unresolved and charges nothing', async () => {
    bareRow('cust-c', { next_retry_at: '2026-11-14T15:00:00.000Z' });
    mockCustomers = [customer('cust-c', 12)];
    monthlyAttemptHasRecovery.mockRejectedValueOnce(new Error('connection terminated'));
    const out = await catchUpRun();
    expectNothingSent();
    expect(out.unresolvedCustomerIds).toEqual(['cust-c']);
  });
});
