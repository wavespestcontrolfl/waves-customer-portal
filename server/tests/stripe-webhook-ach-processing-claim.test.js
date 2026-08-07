/**
 * payment_intent.processing → detached ACH acknowledgment worker
 * (dispatchAchProcessingAcknowledgment).
 *
 * Contract pinned here (codex r13 P1, PR #3259): the worker runs inside a
 * detached setImmediate — the webhook is ALREADY acked, so a rethrown
 * BILLING_NOTICE_ENQUEUE_FAILED cannot fail the handler; it lands in the
 * caller's log-only catch with the one-shot claim consumed and the email
 * leg skipped, permanently losing the acknowledgment.
 *
 *  - a failed durable ENQUEUE of a window-held SMS releases the claim
 *    (ach_processing_notified_at → NULL, guarded by PI + status so a
 *    meanwhile-succeeded payment is untouched) so a Stripe redelivery /
 *    per-attempt clear can re-run the acknowledgment;
 *  - the email leg still runs in the same pass (channels independent);
 *  - a failed RELEASE is logged loudly but never rejects (the caller can
 *    only log — nothing upstream retries a detached worker);
 *  - plain delivery failures (sent:false, no enqueue throw) keep the claim
 *    (the documented no-retry trade-off for delivery-after-claim).
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../services/autopay-eligibility', () => ({ isBankMethodType: jest.fn(() => true) }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  lateSavedCardPaymentNeedsOrphan: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'processing msg'),
}));
jest.mock('../services/stripe-invoice-state', () => ({
  assertInvoicePaymentIntentTenderMatches: jest.fn(),
  isAchPaymentIntent: jest.fn(() => true),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendAchProcessing: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+15550009999') }));

const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    invoiceRow: {
      id: 'inv-1',
      invoice_number: 'WPC-2026-0091',
      status: 'processing',
      ach_processing_notified_at: null,
      payer_id: null,
      customer_id: 'cust-1',
      stripe_payment_intent_id: 'pi_1',
    },
    customer: { id: 'cust-1', first_name: 'Pat', phone: '+15550001111' },
    failSmsLogInsert: false,
    failRelease: false,
    updates: [], // { table, wheres, patch }
  });
}

function mockMakeBuilder(table) {
  const b = { _wheres: [] };
  ['where', 'andWhere', 'whereNot', 'whereIn', 'whereNotIn', 'orderBy', 'select'].forEach((name) => {
    b[name] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      else if (args.length) b._wheres.push({ [name]: args });
      return b;
    };
  });
  b.whereNull = (col) => { b._wheres.push({ whereNull: col }); return b; };
  b.whereNotNull = (col) => { b._wheres.push({ whereNotNull: col }); return b; };
  b.first = async () => {
    if (table === 'invoices') return mockState.invoiceRow;
    if (table === 'customers') return mockState.customer;
    return null;
  };
  b.update = async (patch) => {
    mockState.updates.push({ table, wheres: b._wheres, patch });
    if (table === 'invoices' && patch.ach_processing_notified_at === null && mockState.failRelease) {
      throw new Error('release boom');
    }
    return 1;
  };
  b.insert = async () => {
    if (table === 'sms_log' && mockState.failSmsLogInsert) throw new Error('insert boom');
    return [];
  };
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeBuilder(table));
  db.raw = jest.fn(async () => ({ rowCount: 0 }));
  db.transaction = jest.fn(async (fn) => fn(db));
  return db;
});

const { _dispatchAchProcessingAcknowledgment: dispatchAck } = require('../routes/stripe-webhook');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const logger = require('../services/logger');

const WORKER_INPUT = {
  invoiceId: 'inv-1',
  piId: 'pi_1',
  amount: 117,
  eventCreated: 1754560000,
  eventId: 'evt_1',
};

const claimUpdates = () => mockState.updates.filter(
  (u) => u.table === 'invoices' && u.patch.ach_processing_notified_at instanceof Date,
);
const releaseUpdates = () => mockState.updates.filter(
  (u) => u.table === 'invoices' && u.patch.ach_processing_notified_at === null,
);

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

test('happy path: claim stamped, SMS + email sent, no release', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: true });
  await dispatchAck(WORKER_INPUT);

  expect(claimUpdates()).toHaveLength(1);
  expect(releaseUpdates()).toHaveLength(0);
  expect(PaymentLifecycleEmail.sendAchProcessing).toHaveBeenCalledTimes(1);
});

test('window-held SMS whose rail enqueue fails releases the claim AND still emails', async () => {
  sendCustomerMessage.mockResolvedValue({
    sent: false,
    blocked: true,
    code: 'QUIET_HOURS_HOLD',
    retryable: true,
    deferred: true,
    nextAllowedAt: '2026-08-08T12:00:00.000Z',
  });
  mockState.failSmsLogInsert = true;

  await expect(dispatchAck(WORKER_INPUT)).resolves.toBeUndefined();

  const releases = releaseUpdates();
  expect(releases).toHaveLength(1);
  // Guarded release: only the still-processing row bound to THIS PI.
  expect(releases[0].wheres).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'inv-1', stripe_payment_intent_id: 'pi_1', status: 'processing' }),
    { whereNotNull: 'ach_processing_notified_at' },
  ]));
  // Channels are independent — the email leg still runs in this pass.
  expect(PaymentLifecycleEmail.sendAchProcessing).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('claim released for re-attempt'));
});

test('failed release never rejects — logged for manual follow-up, email still runs', async () => {
  sendCustomerMessage.mockResolvedValue({
    sent: false,
    blocked: true,
    code: 'QUIET_HOURS_HOLD',
    retryable: true,
    deferred: true,
    nextAllowedAt: '2026-08-08T12:00:00.000Z',
  });
  mockState.failSmsLogInsert = true;
  mockState.failRelease = true;

  await expect(dispatchAck(WORKER_INPUT)).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('needs manual follow-up'));
  expect(PaymentLifecycleEmail.sendAchProcessing).toHaveBeenCalledTimes(1);
});

test('plain delivery failure (no enqueue throw) keeps the claim', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
  await dispatchAck(WORKER_INPUT);

  expect(claimUpdates()).toHaveLength(1);
  expect(releaseUpdates()).toHaveLength(0);
  expect(PaymentLifecycleEmail.sendAchProcessing).toHaveBeenCalledTimes(1);
});
