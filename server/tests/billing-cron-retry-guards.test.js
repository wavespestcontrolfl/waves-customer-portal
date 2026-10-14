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
let mockOrphanRow = null;
let mockDuesInvoiceRow = null;
let mockPaymentUpdates = [];
let mockHoldSkipLogged = null;
let mockParkUpdate = () => Promise.resolve(1); // result of a payments update (rows affected)
let mockHealthInserts = [];

jest.mock('../models/db', () => {
  function builder(table) {
    const b = {};
    for (const m of [
      'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNull',
      'whereNotNull', 'whereRaw', 'distinct', 'select', 'orderBy', 'join',
      'leftJoin', 'pluck', 'count', 'returning',
    ]) b[m] = () => b;
    b.insert = (row) => {
      if (table === 'customer_health_alerts') mockHealthInserts.push(row);
      return Promise.resolve([]);
    };
    b.update = (payload) => {
      if (table === 'payments') mockPaymentUpdates.push(payload);
      return table === 'payments' ? mockParkUpdate(payload) : Promise.resolve(1);
    };
    b.first = () => {
      if (table === 'customers') return Promise.resolve(mockCustomer);
      if (table === 'payments') return Promise.resolve(mockCollectedRow);
      if (table === 'stripe_orphan_charges') return Promise.resolve(mockOrphanRow);
      if (table === 'invoices') return Promise.resolve(mockDuesInvoiceRow);
      if (table === 'autopay_log') return Promise.resolve(mockHoldSkipLogged);
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

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/prepaid-pi-guard', () => ({ neutralizeOpenPaymentIntent: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(() => 'msg') }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(() => Promise.resolve('Hi there')) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendChargeSuccess: jest.fn(), sendChargeFailed: jest.fn(), sendPaymentRetryNotice: jest.fn(() => Promise.resolve({ ok: true })) }));
jest.mock('../services/billing-retry-email-obligation', () => ({
  pendingDescriptor: jest.fn(({ customerId, paymentId, retryDate }) => ({
    key: `payment.retry_notice:${paymentId}:${new Date(retryDate).toISOString().slice(0, 10)}`,
    customer_id: customerId, payment_id: paymentId, state: 'pending_decision',
  })),
  mergePendingDescriptor: jest.fn((_db, descriptor) => ({ descriptor })),
  reconcilePendingNotices: jest.fn(() => Promise.resolve({ checked: 1, queued: 1 })),
  sendPaymentRetryNotice: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/billing-helpers', () => ({ isBillingDayMatch: jest.fn(() => true) }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));

const StripeService = require('../services/stripe');
const logger = require('../services/logger');
const { notifyAdmin } = require('../services/notification-service');
const { neutralizeOpenPaymentIntent } = require('../services/prepaid-pi-guard');
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
  mockOrphanRow = null;
  mockDuesInvoiceRow = null;
  mockPaymentUpdates = [];
  mockHoldSkipLogged = null;
  mockParkUpdate = () => Promise.resolve(1);
  mockHealthInserts = [];
  jest.clearAllMocks();
  StripeService.charge.mockReset();
  StripeService.chargeOneTime.mockReset();
  StripeService.chargeMonthly.mockReset();
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

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const disarm = mockPaymentUpdates[0];
    expect(disarm.next_retry_at).toBeNull();
    // No supersede — the row must remain a visible, collectible debt.
    expect(disarm).not.toHaveProperty('superseded_by_payment_id');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_disabled',
      expect.objectContaining({ paymentId: 'pay-failed-1' }));
  });

  test('B10: a hold-blocked retry leaves the row armed and logs skipped_collection_hold ONCE per payment, not every tick', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    const hold = () => Object.assign(new Error('hold'), { code: 'COLLECTION_HOLD_ACTIVE' });
    StripeService.charge.mockRejectedValue(hold());
    StripeService.chargeOneTime.mockRejectedValue(hold());
    StripeService.chargeMonthly.mockRejectedValue(hold());

    await BillingCron.processPaymentRetries();
    const first = logAutopay.mock.calls.filter((c) => c[1] === 'skipped_collection_hold');
    expect(first).toHaveLength(1);
    expect(mockPaymentUpdates).toHaveLength(0); // armed, no retry_count bump, no supersede

    mockHoldSkipLogged = { id: 'log-1' }; // the next tick sees the earlier event
    logAutopay.mockClear();
    await BillingCron.processPaymentRetries();
    expect(logAutopay.mock.calls.filter((c) => c[1] === 'skipped_collection_hold')).toHaveLength(0);
    expect(mockPaymentUpdates).toHaveLength(0);
  });

  test('autopay paused: skipped WITHOUT disarming — ladder resumes after the pause', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    mockCustomer.autopay_paused_until = future;
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_paused',
      expect.objectContaining({ paymentId: 'pay-failed-1' }));
  });

  test('pause remains active through the final ET evening after UTC rolls to tomorrow', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-09T03:30:00Z')); // May 8, 11:30 PM ET
    try {
      mockCustomer.autopay_paused_until = '2026-05-08';
      mockFailedPayments = [monthlyFailedPayment()];

      await BillingCron.processPaymentRetries();

      expect(StripeService.charge).not.toHaveBeenCalled();
      expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
      expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
      expect(mockPaymentUpdates).toHaveLength(0);
      expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_paused',
        expect.objectContaining({ paymentId: 'pay-failed-1' }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('annual prepay covering the OBLIGATION date: monthly row resolved non-collectible', async () => {
    coveredSpy.mockResolvedValue(new Set(['cust-1']));
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    // Coverage must be checked on the obligation's attempt date, not today.
    expect(coveredSpy).toHaveBeenCalledWith('2026-06-08');
    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
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
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

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
    const chargeOneTime = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(chargeOneTime).toHaveBeenCalled();
    // Machine provenance stamp (Codex #3598 r3 P1): the retry rung is a
    // scheduled collection — its ACH lifecycle notices must stay behind the
    // send window, so the re-minted 'one_time' PI carries initiated_by.
    expect(chargeOneTime.mock.calls[0][4]).toEqual({ initiated_by: 'machine' });
  });

  test('obligation month already collected: rung superseded by the collecting payment', async () => {
    mockCollectedRow = { id: 'pay-collector', status: 'paid' };
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
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

  // B08: a live completion-minted membership-dues invoice IS the month's bill.
  // OPEN: the rung only defers (stays armed, untouched, no charge) so a later
  // void or refund of that invoice leaves it collectible. PAID: it resolves.
  test('an OPEN stamped dues invoice defers the rung: no charge, no write, no ledger row, still armed', async () => {
    mockDuesInvoiceRow = { id: 'inv-dues', status: 'sent', scheduled_service_id: 'visit-1' };
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('a PAID stamped dues invoice resolves the rung against itself when no payment row exists', async () => {
    mockDuesInvoiceRow = { id: 'inv-dues', status: 'paid', scheduled_service_id: 'visit-1' };
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0].next_retry_at).toBeNull();
    expect(mockPaymentUpdates[0].superseded_by_payment_id).toBe('pay-failed-1');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid',
      expect.objectContaining({ paymentId: 'pay-failed-1', details: expect.objectContaining({ billed_month: '2026-06', ladder_stopped: true }) }));
  });

  test('without a live stamped dues invoice the same rung still charges (nothing else changed)', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });
    await BillingCron.processPaymentRetries();
    expect(charge).toHaveBeenCalled();
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

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0].superseded_by_payment_id).toBe('pay-collector');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid', expect.anything());
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_disabled', expect.anything());
  });

  test('clean retry carries the failed row\'s billed_month stamp forward', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalledWith(
      'cust-1',
      33,
      expect.stringContaining('WaveGuard Monthly'),
      expect.objectContaining({ type: 'monthly_autopay', billed_month: '2026-06' }),
      'autopay_retry_pay-failed-1_1',
    );
  });

  test('B10: a retry of a hold-deferred row (ordinary description, or a legacy "— DEFERRED (…)" marker) charges Stripe with the plain monthly description', async () => {
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });
    const deferredMeta = JSON.stringify({ type: 'monthly_autopay', billed_month: '2026-06', deferred_reason: 'collection_hold' });
    for (const description of [
      'Bronze WaveGuard Monthly — Test Retry', // what the cron writes now
      'Bronze WaveGuard Monthly — Test Retry — DEFERRED (collections hold)', // a row written with the old marker
      'Bronze WaveGuard Monthly — Test Retry — DEFERRED (collection lock held elsewhere)',
    ]) {
      charge.mockClear();
      mockFailedPayments = [monthlyFailedPayment({ description, retry_count: 0, metadata: deferredMeta })];
      await BillingCron.processPaymentRetries();
      expect(charge).toHaveBeenCalledTimes(1);
      expect(charge.mock.calls[0][2]).toBe('Bronze WaveGuard Monthly — Test Retry');
    }
  });

  test('webhook-armed async ACH bounce row (retry_count 0, first rung) is picked up and re-charges its month', async () => {
    // The stripe-webhook payment_failed handler arms exactly this shape for
    // an invoice-less monthly ACH bounce: status failed, retry_count 0,
    // next_retry_at set, billed_month stamped, no supersede. The sweep must
    // treat it like any cron-armed rung — guards apply, then the charge
    // keys on the rung (retry_count 0) and carries the obligation month.
    mockFailedPayments = [monthlyFailedPayment({
      retry_count: 0,
      failure_reason: 'The customer\'s bank account could not be debited. (R01)',
      stripe_payment_intent_id: 'pi_ach_bounce',
    })];
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'processing', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalledWith(
      'cust-1',
      33,
      expect.stringContaining('WaveGuard Monthly'),
      expect.objectContaining({ type: 'monthly_autopay', billed_month: '2026-06' }),
      'autopay_retry_pay-failed-1_0',
    );
  });

  test('legacy row without a stamp attributes the obligation by payment_date month', async () => {
    mockFailedPayments = [monthlyFailedPayment({
      payment_date: '2026-05-28',
      metadata: JSON.stringify({ base_amount: 33 }),
    })];
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

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

// billing_mode resolution guard (owner ruling 2026-07-09): a monthly
// obligation mis-created for a per-application customer (the pre-
// classification failed-charge cohort) resolves non-collectible — but ONLY
// for 'per_application', and never for a customer who has actually paid a
// monthly charge before (a real ex-member's pre-conversion debt stays
// collectible). 'annual_prepay' old debt is governed exclusively by the
// coverage-DATED absorb, not by current mode.
describe('processPaymentRetries — billing_mode resolution guard', () => {
  test('NULL-mode tier-less row resolves per_visit: ladder DISARMED — GUARD 3c parity, no side-door dues retry (Codex r10 P1)', async () => {
    mockCustomer.billing_mode = null;
    mockCustomer.waveguard_tier = null;
    mockFailedPayments = [monthlyFailedPayment()];
    mockCollectedRow = null;

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_billing_mode',
      expect.objectContaining({
        paymentId: 'pay-failed-1',
        details: expect.objectContaining({ resolved_mode: 'per_visit', ladder_stopped: true }),
      }));
  });

  test('NULL-mode row with a REAL tier still retries — the resolver says monthly', async () => {
    mockCustomer.billing_mode = null; // Bronze tier + rate from the fixture
    mockFailedPayments = [monthlyFailedPayment()];
    mockCollectedRow = null;
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-retried', status: 'paid', amount: 33 });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(
      'cust-1', 33, 'Bronze WaveGuard Monthly — Test Retry',
      { type: 'monthly_autopay', tier: 'Bronze', billed_month: '2026-06' },
      'autopay_retry_pay-failed-1_1',
    );
    expect(charge.mock.contexts).toEqual([StripeService]);
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toContainEqual(expect.objectContaining({
      superseded_by_payment_id: 'pay-retried', next_retry_at: null,
    }));
  });

  test('per_application customer (never paid monthly): ladder DISARMED but debt stays visible — no auto write-off (Codex round-6)', async () => {
    mockCustomer.billing_mode = 'per_application';
    mockFailedPayments = [monthlyFailedPayment()];
    mockCollectedRow = null; // no paid monthly row exists, ever

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const disarmed = mockPaymentUpdates[0];
    expect(disarmed.next_retry_at).toBeNull();
    // Deliberately NOT superseded: "never paid monthly" can't prove the row
    // was mis-created (a real member's first charge can fail pre-conversion)
    // — the owner-run backfill supersedes the known July cohort explicitly.
    expect(disarmed.superseded_by_payment_id).toBeUndefined();
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_billing_mode',
      expect.objectContaining({
        paymentId: 'pay-failed-1',
        details: expect.objectContaining({ billing_mode: 'per_application', ladder_stopped: true, superseded: false }),
      }));
  });

  test('annual_prepay mode does NOT mode-resolve old monthly debt — coverage-dated guards own it', async () => {
    mockCustomer.billing_mode = 'annual_prepay';
    mockFailedPayments = [monthlyFailedPayment()];
    // no coverage on the obligation date, no pending term → nothing suppresses
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_billing_mode', expect.anything());
    expect(charge).toHaveBeenCalledTimes(1);
  });
});

// Characterization of the remaining dispositions BEFORE the collectibility
// verdict is extracted into retry-collectibility.js: every branch below must
// keep producing the same payment writes and autopay-log events once the
// sweep consumes the shared verdict.
describe('processPaymentRetries — parked, held, and missing-customer dispositions', () => {
  test('ambiguous no-PI failure is PARKED: self-superseded, health alert raised, no charge', async () => {
    mockFailedPayments = [monthlyFailedPayment({
      stripe_payment_intent_id: null,
      failure_reason: 'ECONNRESET before intent',
      metadata: JSON.stringify({ base_amount: 33, billed_month: '2026-06', ambiguous_outcome: true }),
    })];
    const db = require('../models/db');

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(1);
    const parked = mockPaymentUpdates[0];
    expect(parked.next_retry_at).toBeNull();
    expect(parked.superseded_by_payment_id).toBe('pay-failed-1');
    expect(parked.failure_reason).toContain('parked: ambiguous Stripe outcome');
    expect(db).toHaveBeenCalledWith('customer_health_alerts');
    // The park is not one of the guard skips — no skipped_* event.
    for (const call of logAutopay.mock.calls) {
      expect(call[1]).not.toMatch(/^skipped_/);
    }
  });

  test('an unresolved orphan charge for the customer leaves the monthly row ARMED — no charge, no write, no park (Codex #4682 r3 P1)', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    mockOrphanRow = { id: 'orphan-1', stripe_payment_intent_id: 'pi_orphan' };
    const db = require('../models/db');

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    // Nothing written: no disarm, no self-supersede, no alert.
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(db).not.toHaveBeenCalledWith('customer_health_alerts');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_unresolved_outcome', expect.objectContaining({
      paymentId: 'pay-failed-1',
      details: expect.objectContaining({ source: 'autopay_retry', reason: 'unresolved_orphan_charge' }),
    }));
  });

  test('deterministic no-PI failure (not flagged ambiguous) still retries normally', async () => {
    mockFailedPayments = [monthlyFailedPayment({
      stripe_payment_intent_id: null,
      metadata: JSON.stringify({ base_amount: 33, billed_month: '2026-06', ambiguous_outcome: false }),
    })];
    const charge = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(charge).toHaveBeenCalled();
  });

  test('pending annual-prepay commitment HOLDS a monthly ladder: skipped, stays armed, no disarm write', async () => {
    pendingSpy.mockResolvedValue(new Set(['cust-1']));
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    // The hold is evaluated as of the sweep day (no explicit as-of argument).
    expect(pendingSpy).toHaveBeenCalledWith();
    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_annual_prepay_pending',
      expect.objectContaining({ paymentId: 'pay-failed-1', details: expect.objectContaining({ source: 'autopay_retry' }) }));
  });

  test('pending prepay commitment does NOT hold a one-time obligation — it still retries', async () => {
    pendingSpy.mockResolvedValue(new Set(['cust-1']));
    mockFailedPayments = [monthlyFailedPayment({
      description: 'Flea treatment add-on — FAILED',
      metadata: JSON.stringify({ base_amount: 33 }),
    })];
    const chargeOneTime = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    await BillingCron.processPaymentRetries();

    expect(chargeOneTime).toHaveBeenCalled();
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_annual_prepay_pending', expect.anything());
  });

  test('soft-deleted customer: row skipped untouched — no write, no event, no charge', async () => {
    mockCustomer.deleted_at = '2026-06-01T00:00:00Z';
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('missing customer row: skipped untouched', async () => {
    mockCustomer = null;
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(StripeService.charge).not.toHaveBeenCalled();
    expect(StripeService.chargeOneTime).not.toHaveBeenCalled();
    expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    expect(mockPaymentUpdates).toHaveLength(0);
    expect(logAutopay).not.toHaveBeenCalled();
  });

  test('guard ORDER: absorbed-by-prepay resolution beats the paused state guard — row superseded, not merely skipped', async () => {
    coveredSpy.mockResolvedValue(new Set(['cust-1']));
    mockCustomer.autopay_paused_until = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    mockFailedPayments = [monthlyFailedPayment()];

    await BillingCron.processPaymentRetries();

    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0].superseded_by_payment_id).toBe('pay-failed-1');
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_annual_prepay', expect.anything());
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_paused', expect.anything());
  });

  test('guard ORDER: lane disarm runs before the disabled guard — skipped_billing_mode, not skipped_disabled', async () => {
    mockCustomer.billing_mode = 'per_application';
    mockCustomer.autopay_enabled = false;
    mockFailedPayments = [monthlyFailedPayment()];
    mockCollectedRow = null;

    await BillingCron.processPaymentRetries();

    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0].superseded_by_payment_id).toBeUndefined();
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_billing_mode', expect.anything());
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'skipped_disabled', expect.anything());
  });

  test('the sweep never consults payment_methods while classifying rows (the processor picks the card)', async () => {
    mockCustomer.autopay_enabled = false;
    mockFailedPayments = [monthlyFailedPayment()];
    const db = require('../models/db');

    await BillingCron.processPaymentRetries();

    expect(db).not.toHaveBeenCalledWith('payment_methods');
  });
});


describe('retry settlement reporting', () => {
  test.each(['processing', 'paid'])('%s disarms the old attempt and receipts only settlement', async status => {
    mockFailedPayments = [monthlyFailedPayment()];
    StripeService.charge.mockResolvedValue({ id: 'pay-state', status, amount: '33.96' });
    const result = await BillingCron.processPaymentRetries();
    expect(result).toMatchObject({ succeeded: status === 'paid' ? 1 : 0, processing: status === 'processing' ? 1 : 0 });
    expect(mockPaymentUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ next_retry_at: null, superseded_by_payment_id: 'pay-state' })]));
    expect(logAutopay).toHaveBeenCalledWith('cust-1', status === 'paid' ? 'retry_success' : 'retry_processing', expect.objectContaining({ amountCents: 3396, paymentId: 'pay-state' }));
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(status === 'paid' ? 1 : 0);
  });
});


describe('B16: retry rung answered with a 3DS demand', () => {
  const scaError = () => Object.assign(new Error('Customer authentication required'), {
    code: 'STRIPE_REQUIRES_ACTION',
    stripePaymentIntentId: 'pi_retry_sca',
    paymentRecord: { id: 'pay-sca-row', amount: '33.00', stripe_payment_intent_id: 'pi_retry_sca' },
  });
  const rejectAll = () => {
    StripeService.charge.mockRejectedValue(scaError());
    StripeService.chargeOneTime.mockRejectedValue(scaError());
    StripeService.chargeMonthly.mockRejectedValue(scaError());
  };
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  const TwilioService = require('../services/twilio');

  beforeEach(() => {
    notifyAdmin.mockResolvedValue({ id: 'notif-1' });
    neutralizeOpenPaymentIntent.mockResolvedValue({ ok: true, piId: 'pi_retry_sca' });
  });

  test('parked, PI cancelled, ONE bell with the key and bell:true, collect-by-hand wording, no customer message, no retry armed', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    rejectAll();

    await BillingCron.processPaymentRetries();

    // the park write: ladder disarmed, prefix the webhook matches on kept exactly
    expect(mockPaymentUpdates).toHaveLength(1);
    expect(mockPaymentUpdates[0]).toMatchObject({ next_retry_at: null, retry_count: 2, superseded_by_payment_id: 'pay-sca-row' });
    expect(mockPaymentUpdates[0].failure_reason).toMatch(/^Customer authentication required \(3DS\)/);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'sca_required', expect.objectContaining({ paymentId: 'pay-failed-1' }));
    expect(neutralizeOpenPaymentIntent).toHaveBeenCalledWith('pi_retry_sca');

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(headline).toBe("Billing — collect Test Retry's autopay by hand");
    expect(why).toBe('The bank must approve this $33.00 card charge; it was not collected and will not retry.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: 'autopay-sca-parked:cust-1:pi_retry_sca',
      link: '/admin/customers?customerId=cust-1',
      metadata: expect.objectContaining({ area: 'Billing', severity: 'needs-you', who: 'person', subject: { type: 'customer', id: 'cust-1' } }),
    });
    // honest lifecycle: a person marks it done, nothing closes it
    expect(opts.metadata.doneWhen).toBe('collected_and_marked_done');
    expect(opts.detail).toMatch(/will not retry on its own/);
    expect(opts.detail).toMatch(/No message was sent to the customer/);
    expect(opts.detail).toMatch(/collect it by hand/);
    expect(opts.detail).toMatch(/mark it done/);

    expect(mockHealthInserts).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/webhook handles/));
  });

  test('replay of the same PaymentIntent raises the same dedupe key', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    rejectAll();
    await BillingCron.processPaymentRetries();
    await BillingCron.processPaymentRetries();
    expect(notifyAdmin).toHaveBeenCalledTimes(2);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe(notifyAdmin.mock.calls[1][3].dedupeKey);
  });

  test('PI still in flight: wording says pending at Stripe and does not tell the office to collect; the sweep goes on to the next row', async () => {
    mockFailedPayments = [monthlyFailedPayment(), monthlyFailedPayment({ id: 'pay-failed-2', description: 'Flea add-on — FAILED', metadata: '{}' })];
    neutralizeOpenPaymentIntent.mockResolvedValueOnce({ ok: false, reason: 'payment_in_flight', piId: 'pi_retry_sca', piStatus: 'processing' });
    StripeService.charge.mockRejectedValueOnce(scaError());
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());
    StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    const result = await BillingCron.processPaymentRetries();

    const [, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(headline).toBe("Billing — check Test Retry's pending autopay charge");
    expect(why).toBe('The $33.00 card charge is still pending at Stripe; check it before doing anything.');
    expect(opts.detail).toMatch(/still pending at Stripe/);
    expect(opts.detail).not.toMatch(/collect it by hand/);
    expect(result.retried).toBe(2);
  });

  test.each([
    ['unverifiable', () => neutralizeOpenPaymentIntent.mockResolvedValueOnce({ ok: false, reason: 'payment_session_unverifiable', piId: 'pi_retry_sca', detail: 'cancel failed: boom' })],
    ['a Stripe error thrown', () => neutralizeOpenPaymentIntent.mockRejectedValueOnce(new Error('stripe down'))],
  ])('PI cancel %s: wording says it could NOT be cancelled and to cancel it in Stripe first; never aborts the sweep', async (_label, arrange) => {
    mockFailedPayments = [monthlyFailedPayment(), monthlyFailedPayment({ id: 'pay-failed-2', description: 'Flea add-on — FAILED', metadata: '{}' })];
    arrange();
    StripeService.charge.mockRejectedValueOnce(scaError());
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());
    StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    const result = await BillingCron.processPaymentRetries();

    const [, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(headline).toBe("Billing — cancel Test Retry's autopay charge in Stripe");
    expect(why).toBe('The $33.00 card charge could not be cancelled; cancel it in Stripe before collecting any other way.');
    expect(opts.detail).toMatch(/could NOT be cancelled/);
    expect(opts.detail).toMatch(/Cancel it in Stripe before collecting any other way/);
    expect(opts.detail).not.toMatch(/collect it by hand/);
    expect(result.retried).toBe(2);
  });

  test.each([
    ['null (insert failed)', null],
    ['the suppressed sentinel', { id: null, suppressed: true }],
  ])('bell result %s: error logged, health-alert fallback written, never "office alerted"', async (_label, result) => {
    mockFailedPayments = [monthlyFailedPayment()];
    rejectAll();
    notifyAdmin.mockResolvedValue(result);

    await BillingCron.processPaymentRetries();

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/office alert NOT filed/));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/office alerted/));
    expect(mockHealthInserts).toHaveLength(1);
    expect(mockHealthInserts[0]).toMatchObject({ customer_id: 'cust-1', alert_type: 'payment_failure', severity: 'high' });
    expect(JSON.parse(mockHealthInserts[0].trigger_data)).toMatchObject({ stripe_payment_intent_id: 'pi_retry_sca', source: 'autopay_sca_parked_autopay_retry' });
  });

  test('a filed bell logs "office alerted"', async () => {
    mockFailedPayments = [monthlyFailedPayment()];
    rejectAll();
    await BillingCron.processPaymentRetries();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/office alerted/));
  });

  test.each([
    ['rejects', () => Promise.reject(new Error('db unavailable'))],
    ['matches no row', () => Promise.resolve(0)],
  ])('park update %s: no sca_required event, PI not cancelled, no alert, row left armed, sweep continues', async (_label, update) => {
    mockFailedPayments = [monthlyFailedPayment(), monthlyFailedPayment({ id: 'pay-failed-2', description: 'Flea add-on — FAILED', metadata: '{}' })];
    // only the 3DS park write misbehaves; the next row's own bookkeeping still works
    mockParkUpdate = (payload) => (/3DS/.test(payload.failure_reason || '') ? update() : Promise.resolve(1));
    StripeService.charge.mockRejectedValueOnce(scaError());
    StripeService.chargeMonthly.mockRejectedValueOnce(scaError());
    StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'paid', amount: '33.00', metadata: '{}' });

    const result = await BillingCron.processPaymentRetries();

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/SCA park update for payment pay-failed-1 did not apply/));
    expect(logAutopay).not.toHaveBeenCalledWith('cust-1', 'sca_required', expect.anything());
    expect(neutralizeOpenPaymentIntent).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(mockHealthInserts).toHaveLength(0);
    expect(result.retried).toBe(2);
  });
});
