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
const mockConstructEvent = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({ webhooks: { constructEvent: mockConstructEvent } })));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
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
    failCustomerLookup: false,
    notificationClaims: new Set(),
    webhookEvent: null,
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
    if (table === 'stripe_webhook_events') return mockState.webhookEvent;
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
    if (table === 'customers') {
      if (mockState.failCustomerLookup) throw new Error('customer lookup failed');
      return mockState.customer;
    }
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
    if (table === 'stripe_webhook_events') Object.assign(mockState.webhookEvent, patch);
    sink.push({ table, wheres: b._wheres, patch });
    return 1;
  };
  b.del = async () => {
    if (table !== 'stripe_payment_notification_log') throw new Error('Unexpected delete');
    const claim = b._wheres[0];
    return Number(mockState.notificationClaims.delete(JSON.stringify([
      claim.payment_intent_id, claim.outcome, claim.attempt_id,
    ])));
  };
  b.insert = (row) => {
    if (table !== 'stripe_webhook_events') return Promise.resolve([]);
    const inserted = !mockState.webhookEvent;
    if (inserted) mockState.webhookEvent = row;
    return { onConflict: () => ({ ignore: () => ({ returning: async () => inserted ? [{ id: row.id }] : [] }) }) };
  };
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

describe('payment_failed admin bell payload', () => {
  test('carries the resolved customerId so the internal-test-customer suppression can key on it (codex P2 on #4392)', async () => {
    const db = require('../models/db');
    const { triggerNotification } = require('../services/notification-triggers');
    // Let the (PI, failed, attempt) claim win so notifyPaymentFailed reaches the trigger.
    db.raw.mockImplementation(async (sql) => (String(sql).includes('stripe_payment_notification_log') ? { rowCount: 1 } : { rowCount: 0 }));
    const row = processingRow();
    mockState.processingRow = row;
    mockState.paymentRow = row;
    await handlePaymentIntentFailed(achBouncePI(), 'evt_pf_1');
    const call = triggerNotification.mock.calls.find((c) => c[0] === 'payment_failed');
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({ customerId: 'cust-1', amount: expect.any(Number), reason: expect.any(String), paymentIntentId: 'pi_ach_1', attemptId: 'ch_1' });
  });

  test('orphan intent (no invoice, no ledger row) falls back to the PI metadata waves_customer_id', async () => {
    const db = require('../models/db');
    const { triggerNotification } = require('../services/notification-triggers');
    db.raw.mockImplementation(async (sql) => (String(sql).includes('stripe_payment_notification_log') ? { rowCount: 1 } : { rowCount: 0 }));
    mockState.processingRow = null;
    mockState.paymentRow = null;
    mockState.invoiceRow = null;
    mockState.customer = null;
    await handlePaymentIntentFailed(achBouncePI({ metadata: { type: 'no_show_fee', waves_customer_id: 'cust-demo' }, last_payment_error: { message: 'declined', code: 'card_declined', payment_method: { type: 'card' } } }), 'evt_pf_2');
    const call = triggerNotification.mock.calls.find((c) => c[0] === 'payment_failed');
    expect(call).toBeTruthy();
    expect(call[1].customerId).toBe('cust-demo');
  });

  test('a late payment_failed after the ledger row settled rings nothing', async () => {
    const db = require('../models/db');
    const { triggerNotification } = require('../services/notification-triggers');
    db.raw.mockImplementation(async (sql) => (String(sql).includes('stripe_payment_notification_log') ? { rowCount: 1 } : { rowCount: 0 }));
    mockState.processingRow = null;
    mockState.paymentRow = processingRow({ status: 'paid' });
    await handlePaymentIntentFailed(achBouncePI(), 'evt_pf_3');
    expect(triggerNotification.mock.calls.find((c) => c[0] === 'payment_failed')).toBeUndefined();
  });
});

describe('payment_failed notification replay', () => {
  const db = require('../models/db');
  const { triggerNotification } = require('../services/notification-triggers');
  beforeEach(() => {
    mockState.paymentRow = processingRow();
    db.raw.mockImplementation(async (sql, bindings) => {
      if (!String(sql).includes('stripe_payment_notification_log')) return { rowCount: 0 };
      const key = JSON.stringify(bindings);
      if (mockState.notificationClaims.has(key)) return { rowCount: 0 };
      mockState.notificationClaims.add(key);
      return { rowCount: 1 };
    });
    triggerNotification.mockReset().mockResolvedValue({ bellWritten: true });
  });

  test.each([
    ['preferences unavailable', { bellWritten: false, prefsUnavailable: true }],
    ['admin lookup failed', { bellWritten: false, retryable: true }],
    ['no recipients', { bellWritten: false, push: null }],
    ['bell insert failed', { bellWritten: false, retryable: true, push: { sent: 0 } }],
    ['push-only delivery failed', { bellWritten: false, push: { sent: 0, failed: 1 } }],
  ])('%s fails the handler and lets the same Stripe event deliver once on replay', async (_label, outcome) => {
    triggerNotification.mockResolvedValueOnce(outcome);
    await expect(handlePaymentIntentFailed(achBouncePI(), 'evt_replay'))
      .rejects.toThrow('Payment failure notification was not delivered');
    expect(mockState.notificationClaims.size).toBe(0);
    await handlePaymentIntentFailed(achBouncePI(), 'evt_replay');
    await handlePaymentIntentFailed(achBouncePI(), 'evt_replay');
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    expect(mockState.notificationClaims.size).toBe(1);
    expect(triggerNotification).toHaveBeenLastCalledWith('payment_failed', expect.any(Object),
      { dedupeKey: 'payment-failed:pi_ach_1:ch_1' });
  });

  test('the webhook returns 500 without marking processed, then acknowledges the replay after delivery', async () => {
    const router = require('../routes/stripe-webhook');
    const route = router.stack.find((layer) => layer.route?.path === '/').route;
    const handler = route.stack[route.stack.length - 1].handle;
    const { classifyExistingWebhookEvent } = require('../routes/stripe-webhook-helpers');
    classifyExistingWebhookEvent.mockImplementation((row) => row.processed ? 'duplicate' : 'reclaim');
    mockConstructEvent.mockReturnValue({ id: 'evt_http_replay', type: 'payment_intent.payment_failed',
      data: { object: achBouncePI() } });
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, prefsUnavailable: true });
    const post = async () => {
      const res = { status: jest.fn(() => res), json: jest.fn(() => res), send: jest.fn(() => res) };
      await handler({ headers: { 'stripe-signature': 'synthetic-signature' }, body: Buffer.from('{}') }, res);
      return res;
    };
    const failed = await post();
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(mockState.webhookEvent.processed).toBe(false);
    expect(mockState.notificationClaims.size).toBe(0);
    const delivered = await post();
    expect(delivered.status).toHaveBeenCalledWith(200);
    expect(mockState.webhookEvent.processed).toBe(true);
    const duplicate = await post();
    expect(duplicate.json).toHaveBeenCalledWith({ received: true, duplicate: true });
    expect(triggerNotification).toHaveBeenCalledTimes(2);
  });

  test('a lookup exception after taking the claim releases it for replay', async () => {
    mockState.failCustomerLookup = true;
    await expect(handlePaymentIntentFailed(achBouncePI(), 'evt_lookup')).rejects.toThrow('customer lookup failed');
    expect(mockState.notificationClaims.size).toBe(0);
    mockState.failCustomerLookup = false;
    await handlePaymentIntentFailed(achBouncePI(), 'evt_lookup');
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['durable bell despite push failure', { bellWritten: true, retryable: true, error: 'push unavailable' }],
    ['push-only success', { bellWritten: false, push: { sent: 1 } }],
    ['intentional opt-out or test account', { bellWritten: false, suppressed: true }],
    ['policy suppression', { bellWritten: false, policySilenced: true }],
  ])('%s retains the claim and suppresses duplicate delivery', async (_label, outcome) => {
    triggerNotification.mockResolvedValue(outcome);
    await handlePaymentIntentFailed(achBouncePI(), 'evt_complete');
    await handlePaymentIntentFailed(achBouncePI(), 'evt_complete');
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(mockState.notificationClaims.size).toBe(1);
  });
});
