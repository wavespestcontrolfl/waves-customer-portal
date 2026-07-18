/**
 * payment_intent.payment_failed → async monthly-autopay bounce arming.
 *
 * ACH autopay charges record 'processing' at initiation, so the monthly
 * cron's synchronous catch (the only path that armed retry_count /
 * next_retry_at) never runs for them. The bank return arrives days later
 * as payment_intent.payment_failed; the handler must arm the SAME retry
 * ladder the cron arms so processPaymentRetries() re-collects the month.
 *
 * Contract pinned here:
 *  - invoice-less monthly_autopay bounce on a 'processing' row → armed
 *    with the cron's first-rung cadence (RETRY_DELAYS_DAYS[0] days) and
 *    retry_count = prior failed attempts for the obligation month;
 *  - invoice-linked PIs are NEVER armed (that lane reopens the invoice
 *    and dunning collects — arming would double-collect);
 *  - non-monthly PIs and rows that were already 'failed' (sync lane, the
 *    cron armed those) are untouched;
 *  - 3 prior attempts = ladder exhausted (mirrors the sweep's
 *    retry_count < 3 window) — no re-arm;
 *  - arming is idempotent (whereNull guards) under webhook redelivery;
 *  - the invoice-link lookup FAILS CLOSED (Codex #2822 P1): a transient
 *    DB error rejects the handler (webhook 500s, Stripe redelivers)
 *    instead of reading as "invoice-less" and arming a ladder that could
 *    double-collect alongside the invoice/dunning lane.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'msg'),
}));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => true),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentFailed: jest.fn(async () => {}) }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/stripe', () => ({
  friendlyStripeError: jest.fn(() => 'Payment could not be completed.'),
  resolveFailedInvoiceSavedCardChargeAttempt: jest.fn(async () => false),
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(async () => {}) }));
jest.mock('../services/invoice-followups', () => ({ handleAutopayFailure: jest.fn(async () => {}) }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
// The arming path lazy-requires only the cadence constant from the cron.
jest.mock('../services/billing-cron', () => ({ RETRY_DELAYS_DAYS: [2, 2] }));

// Mutable fixtures behind the shared db mock.
const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    processingRow: null,   // payments row matched by { pi, status: 'processing' }
    paymentRow: null,      // payments row matched by { pi } alone
    invoiceRow: null,      // invoices row matched by the PI
    failInvoiceLookup: false, // invoices .first() throws (fail-closed path)
    priorFailedCount: 0,   // payments count() result (prior attempts)
    customer: { id: 'cust-1', first_name: 'Pat', phone: '+15550001111' },
    recentFailures: 1,     // ach_failure_log count inside the trx
    updates: [],           // { table, wheres, patch } outside transactions
    trxUpdates: [],
  });
}

function mockMakeBuilder(table, sink) {
  const b = { _wheres: [], _counted: false };
  const chain = (name) => {
    b[name] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      else if (args.length && typeof args[0] === 'function') args[0].call(b);
      else if (args.length) b._wheres.push({ [name]: args });
      return b;
    };
  };
  ['where', 'andWhere', 'orWhere', 'whereNot', 'whereIn', 'whereNotIn',
    'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select'].forEach(chain);
  b.count = () => { b._counted = true; return b; };
  b.columnInfo = async () => ({ stripe_event_id: {} });
  b.first = async () => {
    if (table === 'payments') {
      if (b._counted) return { cnt: mockState.priorFailedCount };
      const wantsProcessing = b._wheres.some((w) => w && w.status === 'processing');
      if (wantsProcessing) return mockState.processingRow;
      return mockState.paymentRow;
    }
    if (table === 'invoices') {
      if (mockState.failInvoiceLookup) throw new Error('invoice lookup failed');
      return mockState.invoiceRow;
    }
    if (table === 'customers') return mockState.customer;
    if (table === 'ach_failure_log') {
      if (b._counted) return { cnt: mockState.recentFailures };
      return null;
    }
    return null;
  };
  // Awaiting the bare builder resolves an empty row list — the real
  // findConsentedChargeableCard (handleAchFailure's consent-scoped
  // fallback resolution) lists saved cards this way; no cards here keeps
  // these tests on the arming contract.
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  b.update = async (patch) => {
    sink.push({ table, wheres: b._wheres, patch });
    return 1;
  };
  b.insert = async () => [];
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeBuilder(table, mockState.updates));
  db.raw = jest.fn(async () => ({ rowCount: 0 }));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => mockMakeBuilder(table, mockState.trxUpdates));
    trx.raw = jest.fn(async () => {});
    return fn(trx);
  });
  return db;
});

const {
  _handlePaymentIntentFailed: handlePaymentIntentFailed,
  _armMonthlyAutopayRetryForAsyncFailure: armMonthlyAutopayRetryForAsyncFailure,
} = require('../routes/stripe-webhook');
const { logAutopay } = require('../services/autopay-log');

const processingRow = (over = {}) => ({
  id: 'pay-proc-1',
  customer_id: 'cust-1',
  status: 'processing',
  amount: '33.00',
  payment_date: '2026-07-01',
  retry_count: 0,
  next_retry_at: null,
  superseded_by_payment_id: null,
  metadata: JSON.stringify({ billed_month: '2026-07' }),
  ...over,
});

const achBouncePI = (over = {}) => ({
  id: 'pi_ach_1',
  metadata: { type: 'monthly_autopay', billed_month: '2026-07' },
  latest_charge: 'ch_1',
  last_payment_error: {
    message: 'The customer\'s bank account could not be debited.',
    code: 'insufficient_funds',
    payment_method: { type: 'us_bank_account' },
  },
  ...over,
});

const armUpdates = () => mockState.updates.filter(
  (u) => u.table === 'payments' && u.patch.next_retry_at !== undefined && u.patch.retry_count !== undefined,
);

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

describe('async monthly-autopay bounce arming', () => {
  test('invoice-less monthly ACH bounce arms the retry ladder with the cron cadence (+2 days, rung 0)', async () => {
    const row = processingRow();
    mockState.processingRow = row;
    mockState.paymentRow = row;

    const before = Date.now();
    await handlePaymentIntentFailed(achBouncePI(), 'evt_1');

    const arms = armUpdates();
    expect(arms).toHaveLength(1);
    expect(arms[0].patch.retry_count).toBe(0);
    // Mirror of billing-cron's first rung: RETRY_DELAYS_DAYS[0] = 2 days out.
    const nextRetryMs = new Date(arms[0].patch.next_retry_at).getTime();
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    expect(nextRetryMs - before).toBeGreaterThanOrEqual(twoDays - 60 * 1000);
    expect(nextRetryMs - before).toBeLessThanOrEqual(twoDays + 60 * 1000);
    // Idempotency guards must ride the arming update itself.
    expect(arms[0].wheres).toContainEqual({ whereNull: ['superseded_by_payment_id'] });
    expect(arms[0].wheres).toContainEqual({ whereNull: ['next_retry_at'] });
    // The status flip to failed still happens.
    const flip = mockState.updates.find((u) => u.table === 'payments' && u.patch.status === 'failed');
    expect(flip).toBeTruthy();
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_failed',
      expect.objectContaining({
        paymentId: 'pay-proc-1',
        details: expect.objectContaining({ source: 'autopay_async_bounce', billed_month: '2026-07' }),
      }));
  });

  test('invoice-linked PI is NEVER armed — the invoice lane re-collects (double-collect guard)', async () => {
    const row = processingRow();
    mockState.processingRow = row;
    mockState.paymentRow = row;
    mockState.invoiceRow = { id: 'inv-1', status: 'processing', customer_id: 'cust-1' };

    await handlePaymentIntentFailed(achBouncePI(), 'evt_2');

    expect(armUpdates()).toHaveLength(0);
    // The invoice reopen path still runs.
    const reopen = mockState.updates.find((u) => u.table === 'invoices' && u.patch.paid_at === null);
    expect(reopen).toBeTruthy();
  });

  test('non-monthly (pay-page style) PI metadata does not arm', async () => {
    const row = processingRow({ metadata: JSON.stringify({}) });
    mockState.processingRow = row;
    mockState.paymentRow = row;

    await handlePaymentIntentFailed(achBouncePI({ metadata: {} }), 'evt_3');

    expect(armUpdates()).toHaveLength(0);
  });

  test('synchronously-failed row (no processing row at bounce time) is left to the cron ladder', async () => {
    mockState.processingRow = null;
    mockState.paymentRow = processingRow({ status: 'failed', next_retry_at: '2026-07-19T14:00:00Z' });

    await handlePaymentIntentFailed(achBouncePI(), 'evt_4');

    expect(armUpdates()).toHaveLength(0);
  });

  test('row already armed or superseded is not re-armed (redelivery idempotency)', async () => {
    await armMonthlyAutopayRetryForAsyncFailure(
      achBouncePI(),
      processingRow({ next_retry_at: '2026-07-19T14:00:00Z' }),
    );
    await armMonthlyAutopayRetryForAsyncFailure(
      achBouncePI(),
      processingRow({ superseded_by_payment_id: 'pay-other' }),
    );
    expect(armUpdates()).toHaveLength(0);
  });

  test('ladder position carries prior failed attempts for the obligation month', async () => {
    mockState.priorFailedCount = 2;
    await armMonthlyAutopayRetryForAsyncFailure(achBouncePI(), processingRow());

    const arms = armUpdates();
    expect(arms).toHaveLength(1);
    expect(arms[0].patch.retry_count).toBe(2);
  });

  test('3 prior attempts = ladder exhausted (mirrors the sweep\'s retry_count < 3 bound) — no re-arm', async () => {
    mockState.priorFailedCount = 3;
    await armMonthlyAutopayRetryForAsyncFailure(achBouncePI(), processingRow());

    expect(armUpdates()).toHaveLength(0);
  });

  test('invoice-link lookup error fails closed: rejects for redelivery, never arms, no status flip', async () => {
    const row = processingRow();
    mockState.processingRow = row;
    mockState.paymentRow = row;
    mockState.failInvoiceLookup = true;

    await expect(handlePaymentIntentFailed(achBouncePI(), 'evt_err')).rejects.toThrow('invoice lookup failed');

    // Indeterminate lookup must never arm — the PI might be
    // invoice-linked, and that lane re-collects via reopen + dunning.
    expect(armUpdates()).toHaveLength(0);
    // The failed flip never ran either: the row is still 'processing' on
    // redelivery, so the retried event re-runs the arming from scratch.
    expect(mockState.updates.find((u) => u.table === 'payments' && u.patch.status === 'failed')).toBeUndefined();
  });

  test('legacy row without a billed_month stamp attributes by payment_date month and still arms', async () => {
    await armMonthlyAutopayRetryForAsyncFailure(
      achBouncePI(),
      processingRow({ metadata: null, payment_date: '2026-06-05' }),
    );

    const arms = armUpdates();
    expect(arms).toHaveLength(1);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_failed',
      expect.objectContaining({ details: expect.objectContaining({ billed_month: '2026-06' }) }));
  });
});
