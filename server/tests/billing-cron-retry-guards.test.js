/**
 * processPaymentRetries() must honor the same suppression guards as
 * processMonthlyBilling() — the retry sweep re-charges the very obligations
 * the monthly path originates, so skipping the guards meant charging paused
 * customers, dunning deliberately-disabled ones, and double-billing months
 * an annual prepay (or an admin charge-now / customer self-pay) had since
 * covered.
 *
 * Covers:
 *   - autopay disabled → ladder disarmed (no supersede: debt stays visible)
 *   - autopay paused   → skipped without disarming (resumes after pause)
 *   - active annual-prepay coverage → monthly row resolved non-collectible
 *   - coverage guards scope to MONTHLY obligations only (one-time rows retry)
 *   - obligation month already collected → rung superseded by the collector
 *   - a clean retry carries the failed row's billed_month stamp forward
 *   - legacy rows without the stamp attribute by payment_date month
 */

// Mutable fixtures driving the shared knex mock. `mock`-prefixed so the
// jest.mock factory may reference them (jest hoists the factory above them).
let mockFailedPayments = [];
let mockCustomer = null;
let mockCollectedRow = null;
let mockPaymentUpdates = [];

jest.mock('../models/db', () => {
  function builder(table) {
    const b = {};
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'whereRaw', 'distinct', 'select', 'orderBy', 'join',
      'leftJoin', 'pluck', 'count', 'returning',
    ]) b[m] = () => b;
    b.insert = () => Promise.resolve([]);
    b.update = (payload) => {
      if (table === 'payments') mockPaymentUpdates.push(payload);
      return Promise.resolve(1);
    };
    b.first = () => {
      if (table === 'customers') return Promise.resolve(mockCustomer);
      if (table === 'payments') return Promise.resolve(mockCollectedRow);
      return Promise.resolve(null);
    };
    b.then = (resolve, reject) => {
      const rows = table === 'payments' ? mockFailedPayments : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return b;
  }
  const db = jest.fn((table) => builder(table));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.schema = { hasTable: jest.fn(() => Promise.resolve(true)) };
  db.fn = { now: () => new Date() };
  return db;
});

jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(() => Promise.resolve()) }));
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

const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Test',
  last_name: 'Retry',
  phone: '+15550001111',
  monthly_rate: 33.0,
  waveguard_tier: 'Bronze',
  autopay_enabled: true,
  autopay_paused_until: null,
  deleted_at: null,
};

function monthlyFailedPayment(overrides = {}) {
  return {
    id: 'pay-failed-1',
    customer_id: 'cust-1',
    status: 'failed',
    retry_count: 1,
    next_retry_at: '2026-06-10T14:00:00Z',
    superseded_by_payment_id: null,
    stripe_payment_intent_id: 'pi_original',
    payment_date: '2026-06-08',
    amount: '33.00',
    base_amount_cents: 3300,
    description: 'Bronze WaveGuard Monthly — Test Retry — FAILED',
    failure_reason: 'card_declined',
    metadata: JSON.stringify({ base_amount: 33, billed_month: '2026-06' }),
    ...overrides,
  };
}

let coveredSpy;
let pendingSpy;

beforeEach(() => {
  mockFailedPayments = [];
  mockCustomer = { ...CUSTOMER };
  mockCollectedRow = null;
  mockPaymentUpdates = [];
  jest.clearAllMocks();
  coveredSpy = jest
    .spyOn(AnnualPrepayRenewals, 'getActivelyCoveredCustomerIds')
    .mockResolvedValue(new Set());
  pendingSpy = jest
    .spyOn(AnnualPrepayRenewals, 'getPaymentPendingCustomerIds')
    .mockResolvedValue(new Set());
});

afterEach(() => {
  coveredSpy.mockRestore();
  pendingSpy.mockRestore();
});

describe('processPaymentRetries — suppression guards', () => {
  test('autopay disabled: ladder disarmed, debt stays visible (no supersede)', async () => {
    mockCustomer.autopay_enabled = false;
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const disarm = mockPaymentUpdates[0];
    expect(disarm.next_retry_at).toBeNull();
    // No supersede — the row must remain a visible, collectible debt.
    expect(disarm).not.toHaveProperty('superseded_by_payment_id');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_disabled',
      expect.objectContaining({ paymentId: 'pay-failed-1' }));
  });

  test('autopay paused: skipped WITHOUT disarming — ladder resumes after the pause', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    mockCustomer.autopay_paused_until = future;
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_paused',
      expect.objectContaining({ paymentId: 'pay-failed-1' }));
  });

  test('annual prepay covering the OBLIGATION date: monthly row resolved non-collectible', async () => {
    coveredSpy.mockResolvedValue(new Set(['cust-1']));
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    // Coverage must be checked on the obligation's attempt date, not today.
    expect(coveredSpy).toHaveBeenCalledWith('2026-06-08');
    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const absorb = mockPaymentUpdates[0];
    expect(absorb.next_retry_at).toBeNull();
    expect(absorb.superseded_by_payment_id).toBe('pay-failed-1');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_annual_prepay',
      expect.objectContaining({ paymentId: 'pay-failed-1' }));
  });

  test('coverage starting AFTER the obligation does not write off the debt — retry proceeds', async () => {
    // Term active from July on; the failed obligation is June. The June
    // debt is real, uncovered AR — absorbing it would erase collectible
    // balance (codex pre-push P0 on the first cut of this guard).
    coveredSpy.mockImplementation(async (dateKey) => (
      dateKey >= '2026-07-01' ? new Set(['cust-1']) : new Set()
    ));
    mockFailedPayments = [monthlyFailedPayment()];
    const charge = jest.fn(() => Promise.resolve({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ charge });

    await BillingCron.processPaymentRetries();

    expect(coveredSpy).toHaveBeenCalledWith('2026-06-08');
    expect(charge).toHaveBeenCalled();
    // Not superseded, not disarmed — mid-charge-path updates may occur,
    // but none may write off the row.
    for (const upd of mockPaymentUpdates) {
      expect(upd.superseded_by_payment_id === 'pay-failed-1').toBe(false);
    }
  });

  test('prepay coverage does NOT absorb one-time obligations — they still retry', async () => {
    coveredSpy.mockResolvedValue(new Set(['cust-1']));
    mockFailedPayments = [monthlyFailedPayment({
      description: 'Flea treatment add-on — FAILED',
      metadata: JSON.stringify({ base_amount: 33 }),
    })];
    const chargeOneTime = jest.fn(() => Promise.resolve({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ chargeOneTime });

    await BillingCron.processPaymentRetries();

    expect(chargeOneTime).toHaveBeenCalled();
  });

  test('obligation month already collected: rung superseded by the collecting payment', async () => {
    mockCollectedRow = { id: 'pay-collector', status: 'paid' };
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const resolved = mockPaymentUpdates[0];
    expect(resolved.next_retry_at).toBeNull();
    expect(resolved.superseded_by_payment_id).toBe('pay-collector');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid',
      expect.objectContaining({
        paymentId: 'pay-failed-1',
        details: expect.objectContaining({ collected_by_payment_id: 'pay-collector', billed_month: '2026-06' }),
      }));
  });

  test('already-collected resolution runs BEFORE the disabled state guard — row superseded, not stranded', async () => {
    // Obligation collected elsewhere, THEN customer disables autopay. The
    // disabled guard exits without superseding; if it ran first the row
    // would stay unsuperseded and billing-v2 /balance would keep summing
    // already-collected money as owed (codex P1 on PR #2437 round 1).
    mockCustomer.autopay_enabled = false;
    mockCollectedRow = { id: 'pay-collector', status: 'paid' };
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(PaymentRouter.getServiceForCustomer).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0].superseded_by_payment_id).toBe('pay-collector');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid', expect.anything());
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_disabled', expect.anything());
  });

  test('clean retry carries the failed row\'s billed_month stamp forward', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    const charge = jest.fn(() => Promise.resolve({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ charge });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalledWith(
      'cust-1',
      33,
      expect.stringContaining('WaveGuard Monthly'),
      expect.objectContaining({ type: 'monthly_autopay', billed_month: '2026-06' }),
      'autopay_retry_pay-failed-1_1',
    );
  });

  test('legacy row without a stamp attributes the obligation by payment_date month', async () => {
    mockFailedPayments = [monthlyFailedPayment({
      payment_date: '2026-05-28',
      metadata: JSON.stringify({ base_amount: 33 }),
    })];
    const charge = jest.fn(() => Promise.resolve({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({ charge });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalledWith(
      'cust-1',
      33,
      expect.anything(),
      expect.objectContaining({ billed_month: '2026-05' }),
      expect.anything(),
    );
  });
});
