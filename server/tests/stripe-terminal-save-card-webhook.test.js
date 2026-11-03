// Tap to Pay card save: the setup_intent.succeeded webhook recovers a save the
// app never finished, and races /complete-setup safely. The REAL completion
// tail (appointment-card-request.js finishVerifiedSecureCapture) runs over an
// in-memory fake of the tables; only its outside collaborators (Stripe, consent
// ledger, enrollment, payer lookup) are fakes. Synthetic data only.
const mockState = { tables: {} };
const mockRetrieveSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn();
const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockEnroll = jest.fn(async () => ({ enrolled: true }));
const mockRaiseAdminAlert = jest.fn(async () => ({}));

jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../models/db', () => {
  const matches = (row, key, op, val) => {
    if (op === '=') return row[key] === val;
    const left = row[key] instanceof Date ? row[key].getTime() : row[key];
    const right = val instanceof Date ? val.getTime() : val;
    return op === '>' ? left > right : left < right;
  };
  function table(name) {
    const rows = () => (mockState.tables[name] = mockState.tables[name] || []);
    const filters = [];
    const find = () => rows().filter((row) => filters.every((f) => f(row)));
    const api = {
      where(a, b, c) {
        if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => matches(r, k, '=', v)));
        else if (c === undefined) filters.push((r) => matches(r, a, '=', b));
        else filters.push((r) => matches(r, a, b, c));
        return api;
      },
      whereNull(k) { filters.push((r) => r[k] == null); return api; },
      forUpdate() { return api; },
      async first() { const hit = find()[0]; return hit ? { ...hit } : undefined; },
      update(patch) {
        const hit = find();
        hit.forEach((r) => Object.assign(r, patch));
        return Promise.resolve(hit.length);
      },
    };
    return api;
  }
  const db = jest.fn((name) => table(name));
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.fn = { now: () => new Date() };
  db.transaction = async (cb) => cb(db);
  return db;
});
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
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
  retrievePaymentIntent: jest.fn(),
  retrievePaymentMethod: jest.fn(),
}));
jest.mock('../services/payment-method-consents', () => ({
  hasEnrollmentScopedConsent: jest.fn(async () => false),
  recordConsent: (...a) => mockRecordConsent(...a),
  linkPaymentMethodId: jest.fn(async () => ({})),
  deferredCaptureConsentVersionCurrent: jest.fn(async (intent) => (
    intent?.metadata?.consent_text_version === jest.requireActual('../services/payment-method-consent-text').CONSENT_VERSION
  )),
}));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: (...a) => mockEnroll(...a) }));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})), notifyCustomer: jest.fn(async () => ({})) }));
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: (...a) => mockRaiseAdminAlert(...a) }));
jest.mock('../services/scheduled-invoice-mint', () => ({ acquireScheduledInvoiceMintLock: jest.fn(async () => {}) }));
jest.mock('../services/secure-appointment-plans', () => ({ buildSecurePlanContext: jest.fn(async () => null) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/card-enrollment-email', () => ({ sendAutopaySetupInvitation: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19410000000' }));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberHeldForVisit: jest.fn(), disclaimedNumberHoldEvidenceForVisit: jest.fn(),
}));

const webhook = require('../routes/stripe-webhook');
const { completeTerminalSetup } = require('../services/terminal-save-card');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');

const handle = webhook._handleSetupIntentSucceeded;

const attempt = (generated = 'pm_generated1') => ({ payment_method_details: { card_present: { generated_card: generated } } });
const tapIntent = (overrides = {}) => ({
  id: 'seti_1', status: 'succeeded', customer: 'cus_test1',
  metadata: {
    appointment_card_request_id: 'req-1', scheduled_service_id: 'visit-1',
    source: 'admin_tap_to_pay', consent_text_version: CONSENT_VERSION,
  },
  latest_attempt: attempt(),
  ...overrides,
});
const handoffRow = () => mockState.tables.terminal_handoff_tokens[0];
const request = () => mockState.tables.appointment_card_requests[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockState.tables = {
    appointment_card_requests: [{
      id: 'req-1', status: 'pending', kind: 'visit', customer_id: 'cust-1', scheduled_service_id: 'visit-1',
      selected_plan: null, no_show_fee_amount: null, accepted_amount: '135.00',
    }],
    customers: [{ id: 'cust-1', stripe_customer_id: 'cus_test1' }],
    scheduled_services: [{ id: 'visit-1', status: 'confirmed', scheduled_date: '2099-07-20', estimated_price: '135.00', is_recurring: false }],
    payment_methods: [],
    terminal_handoff_tokens: [{
      jti: 'jti-1', kind: 'save_card', stripe_setup_intent_id: 'seti_1', appointment_card_request_id: 'req-1',
      tech_user_id: 'tech-1', used_at: new Date(),
    }],
  };
  mockRetrieveSetupIntent.mockImplementation(async () => tapIntent());
  mockSavePaymentMethod.mockImplementation(async (_cust, pmId) => {
    const row = { id: 'pm-row-1', customer_id: 'cust-1', stripe_payment_method_id: pmId, method_type: 'card', card_brand: 'VISA', last_four: '4242', card_funding: 'credit' };
    mockState.tables.payment_methods.push(row);
    return row;
  });
});

describe('setup_intent.succeeded for a Tap to Pay card save', () => {
  test('completes a pending request through the real completion tail', async () => {
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(request()).toEqual(expect.objectContaining({
      status: 'completed', stripe_setup_intent_id: 'seti_1', stripe_payment_method_id: 'pm_generated1', payment_method_id: 'pm-row-1',
    }));
    expect(mockRetrieveSetupIntent).toHaveBeenCalledWith('seti_1', { expand: ['latest_attempt'] });
    expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_generated1', expect.anything());
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', stripePaymentMethodId: 'pm_generated1', source: 'admin_tap_to_pay',
    }));
    expect(mockEnroll).toHaveBeenCalledTimes(1);
  });

  const feeMeta = (extra = {}) => ({
    appointment_card_request_id: 'req-1', scheduled_service_id: 'visit-1', source: 'admin_tap_to_pay',
    consent_text_version: CONSENT_VERSION, fee_terms_agreed: 'true', fee_terms_amount_cents: '4900',
    disclosure_version: 'sticky_v1', ...extra,
  });

  test('verified fee consent in the intent metadata stamps the fee terms (sticky too)', async () => {
    request().no_show_fee_amount = '49.00';
    mockRetrieveSetupIntent.mockImplementation(async () => tapIntent({ metadata: feeMeta() }));
    await handle(tapIntent({ metadata: feeMeta() }));
    expect(request().status).toBe('completed');
    expect(request().fee_agreed_at).toBeInstanceOf(Date);
    expect(request().sticky_window_disclosed).toBe(true);
  });

  test.each([
    ['no fee consent in the metadata', { fee_terms_agreed: 'false', fee_terms_amount_cents: undefined, disclosure_version: undefined }],
    ['a fee amount that is not the row\'s', { fee_terms_amount_cents: '2500' }],
  ])('%s: the card saves and Auto Pay enrolls but no fee agreement is stamped', async (_label, extra) => {
    request().no_show_fee_amount = '49.00';
    mockRetrieveSetupIntent.mockImplementation(async () => tapIntent({ metadata: feeMeta(extra) }));
    await handle(tapIntent({ metadata: feeMeta(extra) }));
    expect(request().status).toBe('completed');
    expect(request().stripe_payment_method_id).toBe('pm_generated1');
    expect(mockEnroll).toHaveBeenCalledTimes(1);
    expect(request().fee_agreed_at).toBeUndefined();
    expect(request().sticky_window_disclosed).toBeUndefined();
    expect(request().no_show_fee_amount).toBeNull();
  });

  test('recovery needs no handoff row: it reads the evidence from the intent after cleanup deleted the row', async () => {
    mockState.tables.terminal_handoff_tokens = [];
    request().no_show_fee_amount = '49.00';
    mockRetrieveSetupIntent.mockImplementation(async () => tapIntent({ metadata: feeMeta() }));
    await handle(tapIntent({ metadata: feeMeta() }));
    expect(request().status).toBe('completed');
    expect(request().fee_agreed_at).toBeInstanceOf(Date);
    expect(request().sticky_window_disclosed).toBe(true);
  });

  test('the webhook then /complete-setup is idempotent: one save, one consent, one enrollment', async () => {
    await handle(tapIntent());
    const late = await completeTerminalSetup({ handoff: handoffRow(), setupIntentId: 'seti_1' });
    expect(late).toEqual({ ok: true, card: { brand: 'visa', last4: '4242', funding: 'credit' }, alreadyCompleted: true });
    expect(mockSavePaymentMethod).toHaveBeenCalledTimes(1);
    expect(mockRecordConsent).toHaveBeenCalledTimes(1);
    expect(mockEnroll).toHaveBeenCalledTimes(1);
  });

  test('/complete-setup then the webhook is idempotent too', async () => {
    const first = await completeTerminalSetup({ handoff: handoffRow(), setupIntentId: 'seti_1' });
    expect(first.ok).toBe(true);
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(mockSavePaymentMethod).toHaveBeenCalledTimes(1);
    expect(mockRecordConsent).toHaveBeenCalledTimes(1);
    expect(mockEnroll).toHaveBeenCalledTimes(1);
  });

  test('a true race saves once; the loser retries instead of double-saving', async () => {
    const results = await Promise.all([
      handle(tapIntent()).then(() => 'webhook-ok', (err) => `webhook-retry:${err.code}`),
      completeTerminalSetup({ handoff: handoffRow(), setupIntentId: 'seti_1' }),
    ]);
    expect(mockSavePaymentMethod).toHaveBeenCalledTimes(1);
    expect(mockRecordConsent).toHaveBeenCalledTimes(1);
    expect(request().status).toBe('completed');
    const losers = results.filter((r) => r === 'webhook-retry:completion_in_progress'
      || (typeof r === 'object' && r.code === 'completion_in_progress'));
    expect(losers.length).toBeLessThanOrEqual(1);
    await expect(handle(tapIntent())).resolves.toBeUndefined();
  });

  test('an empty generated_card leaves the request pending and raises one deduped bell, no retry', async () => {
    mockRetrieveSetupIntent.mockImplementation(async () => tapIntent({ latest_attempt: attempt(null) }));
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(request().status).toBe('pending');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
      'billing',
      expect.objectContaining({ severity: 'needs-you', subject: { type: 'customer', id: 'cust-1' } }),
      expect.objectContaining({ dedupeKey: 'tap_card_not_saveable:seti_1' }),
    );
  });

  test('a tap whose price was never disclosed is not completed; the request stays pending and one bell is raised', async () => {
    request().accepted_amount = null;
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(request().status).toBe('pending');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
      'billing',
      expect.objectContaining({ subject: { type: 'customer', id: 'cust-1' } }),
      expect.objectContaining({ dedupeKey: 'tap_card_price_not_disclosed:seti_1' }),
    );
  });

  test('a transient Stripe read failure throws so Stripe redelivers', async () => {
    mockRetrieveSetupIntent.mockRejectedValue(new Error('stripe unavailable'));
    await expect(handle(tapIntent())).rejects.toMatchObject({
      handlerBranch: 'admin_tap_to_pay', retryClass: 'expected_retry', code: 'verification_failed',
    });
    expect(request().status).toBe('pending');
  });

  test('a failed enrollment reverts the claim and throws for redelivery, then a retry completes', async () => {
    mockEnroll.mockResolvedValueOnce({ enrolled: false, reason: 'ineligible' });
    await expect(handle(tapIntent())).rejects.toMatchObject({ retryClass: 'expected_retry', code: 'completion_failed' });
    expect(request().status).toBe('pending');
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(request().status).toBe('completed');
    expect(mockSavePaymentMethod).toHaveBeenCalledTimes(1);
  });

  test('a closed request acks without saving', async () => {
    request().status = 'satisfied';
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  test('an intent for a different request or customer is ignored', async () => {
    mockRetrieveSetupIntent.mockImplementation(async () => tapIntent({ customer: 'cus_someone_else' }));
    await expect(handle(tapIntent())).resolves.toBeUndefined();
    expect(request().status).toBe('pending');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });
});
