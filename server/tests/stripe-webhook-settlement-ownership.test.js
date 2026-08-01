/**
 * Settlement ownership vs a concurrent customer-merge UNDO.
 *
 * payment_intent.succeeded resolves its invoice with a PRE-lock read
 * (findInvoiceForPaymentIntent), then takes FOR UPDATE on that invoice row
 * inside the transaction. A merge undo (customer-dedupe.js revertMerge)
 * verifies and repoints invoices under the SAME row lock, and probes for
 * payments against them BEFORE repointing. So the two are already
 * serialized — but only if settlement reads the invoice's owner from the
 * row it LOCKED, not from the copy it read before waiting.
 *
 * Codex r13 P1: the insert used `invoice.customer_id` (pre-lock), so an
 * undo that committed while this handler waited produced a loser-owned
 * paid invoice whose payment row still belonged to the winner. Pinned here
 * with a stub whose FOR UPDATE re-read deliberately returns a DIFFERENT
 * owner than the pre-lock read — exactly the post-undo world.
 *
 * No new lock is introduced: settlement must never be blocked into failure.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
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
  isAchPaymentIntent: jest.fn(() => false),
  isTerminalInvoicePaymentIntent: jest.fn(() => false),
  nextInvoiceStatusAfterFailedPayment: jest.fn(() => 'sent'),
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({
  INVOICE_UNCOLLECTIBLE_STATUSES: ['void'],
  invoiceAmountDue: jest.fn(() => 100),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentFailed: jest.fn(async () => {}) }));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(async () => {}),
  scheduleReceiptDeliveryDrain: jest.fn(),
}));
jest.mock('../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  handleDepositChargeReversed: jest.fn(async () => ({ handled: false })),
  handleDepositIntentSucceeded: jest.fn(async () => {}),
}));
jest.mock('../services/stripe', () => ({
  friendlyStripeError: jest.fn(() => 'Payment could not be completed.'),
  resolveFailedInvoiceSavedCardChargeAttempt: jest.fn(async () => false),
  // No competing saved-card attempt — keeps this suite on the ownership
  // contract rather than the quarantine/fence branches.
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  parkInvoiceForSavedCardReconciliation: jest.fn(async () => {}),
}));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(async () => {}) }));
jest.mock('../services/invoice-followups', () => ({
  handleAutopayFailure: jest.fn(async () => {}),
  handleInvoicePaid: jest.fn(async () => {}),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
jest.mock('../services/billing-cron', () => ({ RETRY_DELAYS_DAYS: [2, 2] }));

const WINNER = 'cust-winner';
const LOSER = 'cust-loser';

const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    // What the PRE-lock read returns (the world before the undo).
    preLockInvoice: { id: 'inv-1', customer_id: WINNER, invoice_number: 'INV-1', status: 'sent', credit_applied: 0 },
    // What the FOR UPDATE re-read returns (the world after the undo
    // committed while this handler waited on the row lock).
    lockedInvoice: { id: 'inv-1', customer_id: LOSER, invoice_number: 'INV-1', status: 'sent', credit_applied: 0 },
    inserts: [],
  });
}

function mockMakeBuilder(table, { inTrx } = {}) {
  const b = { _table: table, _wheres: [], _forUpdate: false, _counted: false };
  for (const m of ['where', 'andWhere', 'orWhere', 'whereNot', 'whereIn', 'whereNotIn',
    'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select', 'limit']) {
    b[m] = (...args) => {
      if (args.length && typeof args[0] === 'object') b._wheres.push(args[0]);
      else if (args.length && typeof args[0] === 'function') args[0].call(b);
      return b;
    };
  }
  b.forUpdate = () => { b._forUpdate = true; return b; };
  b.count = () => { b._counted = true; return b; };
  b.columnInfo = async () => ({ stripe_event_id: {} });
  b.first = async () => {
    if (table === 'invoices') {
      // Inside the transaction WITH forUpdate = the post-wait re-read.
      return (inTrx && b._forUpdate) ? mockState.lockedInvoice : mockState.preLockInvoice;
    }
    if (table === 'payments') return null; // no existing payment row
    return null;
  };
  b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  // No pre-existing 'processing' payments row to flip → the handler takes
  // the fallback transaction that LOCKS the invoice and inserts the
  // payment, which is the path under test. The invoice link update must
  // report a row so the handler proceeds to that insert.
  b.update = async () => (table === 'payments' ? 0 : 1);
  b.del = async () => 1;
  b.insert = async (payload) => {
    mockState.inserts.push({ table, payload });
    return [{ id: 'new-row' }];
  };
  b.returning = async () => [{ id: 'new-row' }];
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockMakeBuilder(table, { inTrx: false }));
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.fn = { now: () => 'NOW()' };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => mockMakeBuilder(table, { inTrx: true }));
    trx.raw = jest.fn((sql) => ({ __raw: sql }));
    trx.fn = { now: () => 'NOW()' };
    return fn(trx);
  });
  return db;
});

const { _handlePaymentIntentSucceeded: handlePaymentIntentSucceeded } = require('../routes/stripe-webhook');

function succeededPI(overrides = {}) {
  return {
    id: 'pi_test_1',
    amount: 10000,
    amount_received: 10000,
    latest_charge: 'ch_1',
    payment_method_types: ['card'],
    metadata: { base_amount: '100', card_surcharge: '0' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

describe('payment settlement takes ownership from the LOCKED invoice row', () => {
  test('a merge undo that committed while we waited: the payment follows the invoice to the restored customer', async () => {
    await handlePaymentIntentSucceeded(succeededPI());

    const paymentInsert = mockState.inserts.find((i) => i.table === 'payments');
    expect(paymentInsert).toBeTruthy();
    // THE PIN: the pre-lock read said WINNER; the row we locked says LOSER.
    // Using the pre-lock value would leave a loser-owned paid invoice whose
    // payment belongs to the winner.
    expect(paymentInsert.payload.customer_id).toBe(LOSER);
    expect(paymentInsert.payload.customer_id).not.toBe(WINNER);
  });

  test('happy path (no undo): locked owner equals the pre-lock owner, behavior unchanged', async () => {
    mockState.lockedInvoice = { ...mockState.lockedInvoice, customer_id: WINNER };

    await handlePaymentIntentSucceeded(succeededPI());

    const paymentInsert = mockState.inserts.find((i) => i.table === 'payments');
    expect(paymentInsert).toBeTruthy();
    expect(paymentInsert.payload.customer_id).toBe(WINNER);
  });
});
