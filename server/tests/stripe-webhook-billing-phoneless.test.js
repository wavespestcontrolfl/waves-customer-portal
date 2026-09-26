/**
 * PR #4843 Codex r6 activation-checklist item (send-customer-message.js:1205):
 * Stripe's one-shot billing producers (ACH failure ladder, requires_action,
 * setup-verification-failed) must reach a phone-less customer who explicitly
 * selected Email/App billing delivery — the central router (send-customer-
 * message.js) resolves those legs off customerId alone with `to: null`.
 *
 * Pins:
 *  - sendBillingSms requires only customer.id (not customer.phone); a
 *    customer with no id is still refused MISSING_CUSTOMER_CONTACT;
 *  - a phone-less send passes `to: null`, omits identityTrustLevel (the
 *    validator's own customerId fallback resolves phone_matches_customer,
 *    validators/identity.js resolveTrustLevel), and stamps
 *    billingDeliveryCategory so a held row can be recognized as replayable
 *    without a phone;
 *  - a phone-bearing send is byte-identical to before (to: customer.phone,
 *    identityTrustLevel asserted explicitly, no billingDeliveryCategory
 *    stamp added to the metadata the caller sees — the pre-existing shape);
 *  - a phone-less HOLD (REPLAY_HOLD_CODES) queues an sms_log row with
 *    requires_registered_dispatch: true and to_phone: null; a phone-bearing
 *    hold queues a row WITHOUT that stamp and with the real to_phone,
 *    exactly as before;
 *  - the three call sites (ACH failure, requires_action, setup_intent
 *    failed) no longer gate on customer.phone before calling sendBillingSms;
 *  - the registry entry (stripe_webhook_billing_deferred) declares
 *    replayWithoutPhone and its dispatch hook is a pure pass-through to
 *    defaultDispatch for every row, phone-bearing or not;
 *  - the scheduler's canReplayBillingWithoutPhone accepts a phone-less
 *    stripe hold and refuses a phone-bearing one (it never carries the
 *    stamp).
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
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
}));
const mockRenderTemplate = jest.fn(async () => 'msg');
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: (...a) => mockRenderTemplate(...a),
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
const mockHandleAutopayFailure = jest.fn(async () => {});
jest.mock('../services/invoice-followups', () => ({
  handleAutopayFailure: (...a) => mockHandleAutopayFailure(...a),
}));
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: jest.fn(async () => null),
}));

// Mutable fixtures behind the shared db mock.
const mockState = {};
function resetMockState() {
  Object.assign(mockState, {
    paymentRow: { id: 'pay-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_ach_1' },
    invoiceRow: null,
    customer: { id: 'cust-1', first_name: 'Pat', phone: null },
    achLogRow: null,
    recentFailures: 1,
    smsLogInserts: [],
  });
}

function mockMakeTrxBuilder(table) {
  const b = { _wheres: [], _counted: false };
  ['where', 'andWhere', 'whereIn', 'whereNot', 'whereNull', 'whereRaw'].forEach((name) => {
    b[name] = () => b;
  });
  b.count = () => { b._counted = true; return b; };
  b.columnInfo = async () => ({ stripe_event_id: {} });
  b.first = async () => {
    if (table === 'ach_failure_log') return b._counted ? { cnt: mockState.recentFailures } : mockState.achLogRow;
    if (table === 'customers') return mockState.customer;
    return null;
  };
  b.update = async () => 1;
  b.insert = async () => [];
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const b = { _wheres: [] };
    ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'select'].forEach((name) => {
      b[name] = () => b;
    });
    b.first = async () => {
      if (table === 'payments') return mockState.paymentRow;
      if (table === 'invoices') return mockState.invoiceRow;
      if (table === 'customers') return mockState.customer;
      return null;
    };
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    b.update = async () => 1;
    b.insert = async (row) => { mockState.smsLogInserts.push(row); return []; };
    return b;
  });
  db.raw = jest.fn(async () => ({ rowCount: 1 }));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => mockMakeTrxBuilder(table));
    trx.raw = jest.fn(async () => {});
    return fn(trx);
  });
  return db;
});

const {
  _handleAchFailure: handleAchFailure,
  _handlePaymentIntentRequiresAction: handlePaymentIntentRequiresAction,
  _handleSetupIntentFailed: handleSetupIntentFailed,
  _sendBillingSms: sendBillingSms,
} = require('../routes/stripe-webhook');

const PI = { id: 'pi_ach_1', metadata: { type: 'monthly_autopay' } };

beforeEach(() => {
  jest.clearAllMocks();
  resetMockState();
});

describe('sendBillingSms — phone-less customer contract', () => {
  test('requires only customer.id — a customer with no id is refused, never reaching the router', async () => {
    const result = await sendBillingSms({ id: null, phone: null }, 'body', { original_message_type: 'ach_retry_notice' });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'MISSING_CUSTOMER_CONTACT' });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a phone-less customer reaches the router with to: null, no identityTrustLevel, and a stamped billing category', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: true, channel: 'push' });
    const result = await sendBillingSms(
      { id: 'cust-1', phone: null, first_name: 'Pat' },
      'body text',
      { original_message_type: 'bank_verification_failed', stripe_setup_intent_id: 'seti_1' },
    );
    expect(result).toMatchObject({ sent: true });
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: null,
      customerId: 'cust-1',
      channel: 'sms',
      purpose: 'payment_failure',
      metadata: expect.objectContaining({ billingDeliveryCategory: 'payment_issue' }),
    }));
    expect(mockSendCustomerMessage.mock.calls[0][0]).not.toHaveProperty('identityTrustLevel');
  });

  test('a phone-bearing customer is byte-identical: to is the phone, identityTrustLevel asserted, no category stamp added', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: true });
    await sendBillingSms(
      { id: 'cust-1', phone: '+19415550101', first_name: 'Pat' },
      'body text',
      { original_message_type: 'ach_retry_notice' },
    );
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      identityTrustLevel: 'phone_matches_customer',
      customerId: 'cust-1',
    }));
    expect(mockSendCustomerMessage.mock.calls[0][0].metadata).not.toHaveProperty('billingDeliveryCategory');
  });
});

describe('sendBillingSms — held-notice queueing (REPLAY_HOLD_CODES)', () => {
  const heldResult = { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true,
    nextAllowedAt: '2026-09-27T13:00:00.000Z' };

  test('a phone-less hold queues requires_registered_dispatch: true with to_phone null', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ ...heldResult });
    const result = await sendBillingSms(
      { id: 'cust-1', phone: null, first_name: 'Pat' },
      'body text',
      { original_message_type: 'bank_verification_incomplete', invoice_id: null },
    );
    expect(result.scheduled).toBe(true);
    expect(mockState.smsLogInserts).toHaveLength(1);
    const row = mockState.smsLogInserts[0];
    expect(row.to_phone).toBeFalsy();
    expect(row.customer_id).toBe('cust-1');
    const meta = JSON.parse(row.metadata);
    expect(meta.requires_registered_dispatch).toBe(true);
    expect(meta.billingDeliveryCategory).toBe('payment_issue');
    expect(meta.entry_point).toBe('stripe_webhook_billing_deferred');
  });

  test('a phone-bearing hold does NOT get requires_registered_dispatch — same shape as before', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ ...heldResult });
    const result = await sendBillingSms(
      { id: 'cust-1', phone: '+19415550101', first_name: 'Pat' },
      'body text',
      { original_message_type: 'ach_retry_notice', invoice_id: null },
    );
    expect(result.scheduled).toBe(true);
    const row = mockState.smsLogInserts[0];
    expect(row.to_phone).toBe('+19415550101');
    const meta = JSON.parse(row.metadata);
    expect(meta.requires_registered_dispatch).toBeUndefined();
  });
});

describe('stripe-webhook call sites no longer gate on customer.phone', () => {
  test('ACH failure notice reaches sendBillingSms (router to: null) for a phone-less customer', async () => {
    mockState.customer = { id: 'cust-1', first_name: 'Pat', phone: null };
    mockState.recentFailures = 1;
    await handleAchFailure(PI, 'R01', 'evt_1');
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: null, customerId: 'cust-1' }));
  });

  test('requires_action (bank_verification_incomplete) reaches sendBillingSms for a phone-less customer', async () => {
    mockState.customer = { id: 'cust-1', first_name: 'Pat', phone: null };
    await handlePaymentIntentRequiresAction({ id: 'pi_ach_1', next_action: { type: 'verify_with_microdeposits' } }, 'evt_2');
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: null, customerId: 'cust-1' }));
  });

  test('setup_intent.setup_failed (bank_verification_failed) reaches sendBillingSms for a phone-less customer', async () => {
    mockState.customer = { id: 'cust-1', first_name: 'Pat', phone: null };
    const setupIntent = { id: 'seti_1', payment_method: 'pm_1', metadata: { waves_customer_id: 'cust-1' },
      last_setup_error: { message: 'failed' } };
    await handleSetupIntentFailed(setupIntent, 'evt_3');
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: null, customerId: 'cust-1' }));
  });
});
