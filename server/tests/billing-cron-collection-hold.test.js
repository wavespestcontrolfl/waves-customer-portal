/**
 * B10 — monthly dues under a collections DISPUTE hold (billing-cron.js).
 *
 * The customer disputed a bill on a collections call and was told all billing
 * follow-up is on hold, so the once-a-month cron must NOT charge them — and
 * must not treat it as a failure either: no payment-failed text or email, no
 * autopay charge_failed event, no retry-count burn. It writes ONE armed
 * never-attempted retry row (the shape the lock-contention deferral already
 * uses) so the 10 AM retry sweep collects the month after the office releases
 * the hold, and the sweep leaves that row armed while the hold is active.
 *
 * Mirrors billing-cron-monthly-lock-contention.test.js's harness.
 */
let mockCustomers = [];
let mockPaymentsInserts = [];
let mockHealthAlertInserts = [];
let mockExistingHoldRow = null;
let mockPaymentsInsertFailures = 0;
let mockPaymentsReadFails = false;
let mockBillingDayMatches = true;

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
    if (String(table).startsWith('annual_prepay_terms')) return thenableFor(() => []);
    if (table === 'payments') {
      const b = thenableFor(() => []);
      // findCollectedMonthlyPayment (paid this month?) -> no. Only the
      // hold-defer dedupe read (it filters on metadata deferred_reason) can
      // see an existing armed row.
      let isHoldDedupe = false;
      const passThrough = b.whereRaw;
      b.whereRaw = (sql, ...rest) => { if (/deferred_reason/.test(String(sql))) isHoldDedupe = true; return passThrough(sql, ...rest); };
      b.first = () => {
        if (isHoldDedupe && mockPaymentsReadFails) return Promise.reject(new Error('db unavailable'));
        return Promise.resolve(isHoldDedupe ? mockExistingHoldRow : null);
      };
      b.insert = jest.fn((row) => {
        if (mockPaymentsInsertFailures > 0) { mockPaymentsInsertFailures -= 1; return Promise.reject(new Error('db unavailable')); }
        mockPaymentsInserts.push(row);
        return Promise.resolve([1]);
      });
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

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/prepaid-pi-guard', () => ({ neutralizeOpenPaymentIntent: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSms: jest.fn(), sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(() => 'msg') }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendChargeSuccess: jest.fn(), sendChargeFailed: jest.fn(), sendPaymentRetryNotice: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/billing-helpers', () => ({ isBillingDayMatch: jest.fn(() => mockBillingDayMatches) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));
jest.mock('../utils/customer-billing-lock', () => ({
  withCustomerBillingLock: jest.fn(async (_id, fn) => fn()),
}));

const { logAutopay } = require('../services/autopay-log');
const logger = require('../services/logger');
const { notifyAdmin } = require('../services/notification-service');
const { neutralizeOpenPaymentIntent } = require('../services/prepaid-pi-guard');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const TwilioService = require('../services/twilio');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const StripeService = require('../services/stripe');
const BillingCron = require('../services/billing-cron');

const baseCustomer = {
  id: 'cust-held', first_name: 'Held', last_name: 'Dispute',
  phone: '+15550004444', monthly_rate: 89, waveguard_tier: 'Silver',
  autopay_enabled: true, autopay_paused_until: null,
  autopay_payment_method_id: 'pm_1', billing_day: 1, billing_mode: 'monthly_membership',
};

beforeEach(() => {
  mockCustomers = [{ ...baseCustomer }];
  mockPaymentsInserts = [];
  mockHealthAlertInserts = [];
  mockExistingHoldRow = null;
  mockPaymentsInsertFailures = 0;
  mockPaymentsReadFails = false;
  mockBillingDayMatches = true;
  jest.clearAllMocks();
});

test.each(['COLLECTION_HOLD_ACTIVE', 'COLLECTION_HOLD_CHECK_FAILED'])(
  'monthly dues under a dispute hold (%s): skipped and deferred — NOT charged, NOT failed, NO customer message', async (code) => {
    StripeService.chargeMonthly.mockRejectedValueOnce(Object.assign(new Error('Collection is on hold'), { code }));

    const result = await BillingCron.processMonthlyBilling();

    expect(result.skipped).toBe(1);
    expect(result.charged).toBe(0);
    expect(result.failed || 0).toBe(0);

    // one armed, never-attempted retry row so the sweep collects after release
    expect(mockPaymentsInserts).toHaveLength(1);
    const row = mockPaymentsInserts[0];
    expect(row).toMatchObject({ customer_id: 'cust-held', status: 'failed', retry_count: 0 });
    expect(row.next_retry_at).toBeInstanceOf(Date);
    expect(row.description).toEqual(expect.stringContaining('WaveGuard Monthly'));
    // ordinary description: the retry sweep reuses it as the charge label the customer sees
    expect(row.description).not.toMatch(/DEFERRED|hold/i);
    expect(JSON.parse(row.metadata)).toMatchObject({ type: 'monthly_autopay', deferred_reason: 'collection_hold' });

    // a distinct skip event — never a failed charge
    expect(logAutopay).toHaveBeenCalledWith('cust-held', 'skipped_collection_hold', expect.anything());
    expect(logAutopay).not.toHaveBeenCalledWith('cust-held', 'charge_failed', expect.anything());

    // no customer-facing message of any kind, no failure bookkeeping
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(TwilioService.sendSms).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendChargeFailed).not.toHaveBeenCalled();
    expect(mockHealthAlertInserts.filter((a) => /fail|declin/i.test(`${a.alert_type} ${a.title}`))).toHaveLength(0);
  }, 15000);

test('a re-run does not stack a second deferred row for the same month', async () => {
  mockExistingHoldRow = { id: 'pay-already-deferred' };
  StripeService.chargeMonthly.mockRejectedValueOnce(Object.assign(new Error('hold'), { code: 'COLLECTION_HOLD_ACTIVE' }));

  await BillingCron.processMonthlyBilling();

  expect(mockPaymentsInserts).toHaveLength(0);
  expect(logAutopay).toHaveBeenCalledWith('cust-held', 'skipped_collection_hold', expect.anything());
}, 15000);

test('with no hold the month is charged exactly as before (regression: the skip path is hold-only)', async () => {
  StripeService.chargeMonthly.mockResolvedValueOnce({ id: 'pay-1', status: 'paid', amount: 89 });

  const result = await BillingCron.processMonthlyBilling();

  expect(result.charged).toBe(1);
  expect(mockPaymentsInserts).toHaveLength(0);
  expect(logAutopay).not.toHaveBeenCalledWith('cust-held', 'skipped_collection_hold', expect.anything());
}, 15000);

describe('a hold deferral that cannot persist is never reported complete (billing_day only recurs monthly)', () => {
  const holdErr = () => Object.assign(new Error('hold'), { code: 'COLLECTION_HOLD_CHECK_FAILED' });

  test('a transient write failure is retried in-tick and the row still lands', async () => {
    mockPaymentsInsertFailures = 1;
    StripeService.chargeMonthly.mockRejectedValueOnce(holdErr());
    const result = await BillingCron.processMonthlyBilling();
    expect(mockPaymentsInserts).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.failed || 0).toBe(0);
    expect(mockHealthAlertInserts).toHaveLength(0);
    expect(logAutopay).toHaveBeenCalledWith('cust-held', 'skipped_collection_hold', expect.objectContaining({ details: expect.objectContaining({ persisted: true }) }));
  }, 15000);

  test('when the durable row cannot be written: counted failed (not skipped), office bell filed, and the NEXT daily run (not the billing day) picks the customer up again', async () => {
    mockPaymentsInsertFailures = 99;
    StripeService.chargeMonthly.mockRejectedValueOnce(holdErr());
    const first = await BillingCron.processMonthlyBilling();

    expect(mockPaymentsInserts).toHaveLength(0);
    expect(first.failed).toBe(1);
    expect(first.skipped).toBe(0);
    expect(mockHealthAlertInserts).toEqual([expect.objectContaining({
      customer_id: 'cust-held', alert_type: 'billing_collection_deferred', severity: 'high',
      title: expect.stringMatching(/NOT durably deferred/),
    })]);
    expect(logAutopay).toHaveBeenCalledWith('cust-held', 'skipped_collection_hold', expect.objectContaining({ details: expect.objectContaining({ persisted: false }) }));

    // Next daily run: today is NOT the customer's billing day, the DB is back.
    mockBillingDayMatches = false;
    mockPaymentsInsertFailures = 0;
    StripeService.chargeMonthly.mockRejectedValueOnce(holdErr());
    const second = await BillingCron.processMonthlyBilling();
    expect(StripeService.chargeMonthly).toHaveBeenCalledTimes(2); // marker made the customer due again
    expect(mockPaymentsInserts).toHaveLength(1);
    expect(JSON.parse(mockPaymentsInserts[0].metadata)).toMatchObject({ deferred_reason: 'collection_hold' });
    expect(second.skipped).toBe(1);

    // Persisted: the marker is cleared, so a third off-day run charges nobody.
    StripeService.chargeMonthly.mockClear();
    await BillingCron.processMonthlyBilling();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
  }, 30000);

  test('a failed dedupe READ counts as not persisted (never assumes the row exists)', async () => {
    mockPaymentsReadFails = true;
    StripeService.chargeMonthly.mockRejectedValueOnce(holdErr());
    const result = await BillingCron.processMonthlyBilling();
    expect(result.failed).toBe(1);
    expect(mockPaymentsInserts).toHaveLength(0);
    expect(mockHealthAlertInserts).toHaveLength(1);
  }, 15000);

  test('a marked customer that got charged on the catch-up run has the marker cleared', async () => {
    mockPaymentsInsertFailures = 99;
    StripeService.chargeMonthly.mockRejectedValueOnce(holdErr());
    await BillingCron.processMonthlyBilling();
    mockBillingDayMatches = false;
    StripeService.chargeMonthly.mockResolvedValueOnce({ id: 'pay-2', status: 'paid', amount: 89 });
    const second = await BillingCron.processMonthlyBilling();
    expect(second.charged).toBe(1);
    StripeService.chargeMonthly.mockClear();
    await BillingCron.processMonthlyBilling();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
  }, 30000);
});


// B16: the monthly charge answered with a 3D Secure demand. The row stays failed with no retry
// armed; the stuck PaymentIntent is cancelled and ONE office alert is raised. The requires_action
// webhook sends the customer nothing for a card, and neither does this path.
describe('B16: monthly autopay parked on 3DS', () => {
  const scaError = (pi = 'pi_sca_1') => Object.assign(new Error('Customer authentication required'), {
    code: 'STRIPE_REQUIRES_ACTION',
    stripePaymentIntentId: pi,
    paymentRecord: { id: `pay-${pi}`, amount: '89.00', stripe_payment_intent_id: pi },
  });
  const second = { ...baseCustomer, id: 'cust-next', first_name: 'Next', last_name: 'Customer' };

  beforeEach(() => {
    logAutopay.mockResolvedValue(undefined);
    notifyAdmin.mockResolvedValue({ id: 'notif-1' });
    neutralizeOpenPaymentIntent.mockResolvedValue({ ok: true, piId: 'pi_sca_1' });
  });

  test('PI cancelled: one bell with the dedupe key and bell:true, collect-by-hand wording, no customer message, no retry armed', async () => {
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());

    const result = await BillingCron.processMonthlyBilling();

    expect(result.failed).toBe(1);
    expect(neutralizeOpenPaymentIntent).toHaveBeenCalledWith('pi_sca_1');
    expect(logAutopay).toHaveBeenCalledWith('cust-held', 'sca_required', expect.objectContaining({ paymentId: 'pay-pi_sca_1' }));

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(headline).toBe("Billing — collect Held Dispute's autopay by hand");
    expect(why).toBe('The bank must approve this $89.00 card charge; it was not collected and will not retry.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: 'autopay-sca-parked:cust-held:pi_sca_1',
      link: '/admin/customers?customerId=cust-held',
      metadata: expect.objectContaining({ area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'collected_and_marked_done', subject: { type: 'customer', id: 'cust-held' } }),
    });
    expect(opts.detail).toMatch(/will not retry on its own/);
    expect(opts.detail).toMatch(/No message was sent to the customer/);
    expect(opts.detail).toMatch(/collect it by hand/);
    expect(opts.detail).toMatch(/mark it done/);

    // no retry armed, no customer message of any kind, no fallback row
    expect(mockPaymentsInserts).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(TwilioService.sendSms).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(PaymentLifecycleEmail.sendChargeFailed).not.toHaveBeenCalled();
    expect(mockHealthAlertInserts).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/office alerted/));
  }, 15000);

  test('replay of the same PaymentIntent raises the same dedupe key', async () => {
    StripeService.chargeMonthly.mockRejectedValue(scaError());
    await BillingCron.processMonthlyBilling();
    await BillingCron.processMonthlyBilling();
    expect(notifyAdmin).toHaveBeenCalledTimes(2);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe(notifyAdmin.mock.calls[1][3].dedupeKey);
    StripeService.chargeMonthly.mockReset();
  }, 15000);

  test.each([
    ['in flight', () => neutralizeOpenPaymentIntent.mockResolvedValueOnce({ ok: false, reason: 'payment_in_flight', piId: 'pi_sca_1', piStatus: 'processing' }),
      "Billing — check Held Dispute's pending autopay charge",
      'The $89.00 card charge is still pending at Stripe; check it before doing anything.', /still pending at Stripe/],
    ['unverifiable', () => neutralizeOpenPaymentIntent.mockResolvedValueOnce({ ok: false, reason: 'payment_session_unverifiable', piId: 'pi_sca_1', detail: 'cancel failed: boom' }),
      "Billing — cancel Held Dispute's autopay charge in Stripe",
      'The $89.00 card charge could not be cancelled; cancel it in Stripe before collecting any other way.', /could NOT be cancelled/],
    ['a Stripe error thrown', () => neutralizeOpenPaymentIntent.mockRejectedValueOnce(new Error('stripe down')),
      "Billing — cancel Held Dispute's autopay charge in Stripe",
      'The $89.00 card charge could not be cancelled; cancel it in Stripe before collecting any other way.', /could NOT be cancelled/],
  ])('PI %s: variant wording, and the loop continues to the next customer', async (_label, arrange, headline, why, detailRe) => {
    mockCustomers = [{ ...baseCustomer }, { ...second }];
    arrange();
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());
    StripeService.chargeMonthly.mockResolvedValueOnce({ id: 'pay-next', status: 'paid', amount: 89 });

    const result = await BillingCron.processMonthlyBilling();

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [, gotHeadline, gotWhy, opts] = notifyAdmin.mock.calls[0];
    expect(gotHeadline).toBe(headline);
    expect(gotWhy).toBe(why);
    expect(opts.detail).toMatch(detailRe);
    expect(opts.detail).not.toMatch(/collect it by hand/);
    expect(opts.bell).toBe(true);
    expect(result.charged).toBe(1);
    expect(result.failed).toBe(1);
  }, 15000);

  test.each([
    ['null (insert failed)', null],
    ['the suppressed sentinel', { id: null, suppressed: true }],
    ['a thrown error', new Error('compose blew up')],
  ])('bell result %s: error logged, health-alert fallback written, never "office alerted"; loop continues', async (_label, bell) => {
    mockCustomers = [{ ...baseCustomer }, { ...second }];
    if (bell instanceof Error) notifyAdmin.mockRejectedValue(bell); else notifyAdmin.mockResolvedValue(bell);
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());
    StripeService.chargeMonthly.mockResolvedValueOnce({ id: 'pay-next', status: 'paid', amount: 89 });

    const result = await BillingCron.processMonthlyBilling();

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/office alert NOT filed/));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/office alerted/));
    expect(mockHealthAlertInserts).toHaveLength(1);
    expect(mockHealthAlertInserts[0]).toMatchObject({ customer_id: 'cust-held', alert_type: 'payment_failure', severity: 'high' });
    expect(JSON.parse(mockHealthAlertInserts[0].trigger_data)).toMatchObject({ stripe_payment_intent_id: 'pi_sca_1', source: 'autopay_sca_parked_autopay' });
    expect(result.charged).toBe(1);
  }, 15000);
});
