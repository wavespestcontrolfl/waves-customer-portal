/**
 * setup_intent.succeeded → portal_add_method branch (portal ACH lane).
 *
 * For the micro-deposit deferred save this webhook is the ONLY completion
 * path: the customer's session ended days before verification cleared.
 * Contract:
 *  - a pending bank row flips ach_status → 'verified';
 *  - enrollment happens ONLY behind hasEnrollmentScopedConsent (the
 *    consent row is the authority — never SI metadata alone, Codex #2507);
 *  - ownership mismatches skip everything;
 *  - re-delivery for an already-completed card save no-ops into
 *    already_enrolled (idempotent).
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  isInvoiceCollectibleStatus: jest.fn(() => true),
  invoiceStatusForSuccessfulPayment: jest.fn(),
  invoiceStatusForFailedPayment: jest.fn(),
  INVOICE_COLLECTIBLE_STATUSES: [],
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));

const mockSavePaymentMethod = jest.fn();
jest.mock('../services/stripe', () => ({
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
}));

const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockHasConsentFor = jest.fn(async () => true);
const mockHasEnrollmentScopedConsent = jest.fn(async () => true);
const mockLinkPaymentMethodId = jest.fn(async () => {});
jest.mock('../services/payment-method-consents', () => ({
  recordConsent: (...a) => mockRecordConsent(...a),
  hasConsentFor: (...a) => mockHasConsentFor(...a),
  hasEnrollmentScopedConsent: (...a) => mockHasEnrollmentScopedConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
}));

const mockEnroll = jest.fn(async () => ({ enrolled: true, methodId: 'pm-row-1', inChargeMethodId: 'pm-row-1' }));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: (...a) => mockEnroll(...a) }));

const state = { paymentMethodRow: null };
const mockPmUpdate = jest.fn(async () => 1);
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'payment_methods' ? state.paymentMethodRow : null));
    q.update = (...a) => mockPmUpdate(...a);
    return q;
  });
  db.transaction = jest.fn();
  return db;
});

const { _handleSetupIntentSucceeded: handleSetupIntentSucceeded } = require('../routes/stripe-webhook');

const setupIntent = (over = {}) => ({
  id: 'si_1',
  status: 'succeeded',
  payment_method: 'pm_bank_1',
  metadata: { purpose: 'portal_add_method', waves_customer_id: 'cust-1' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockHasConsentFor.mockResolvedValue(true);
  mockHasEnrollmentScopedConsent.mockResolvedValue(true);
  state.paymentMethodRow = {
    id: 'pm-row-1',
    customer_id: 'cust-1',
    method_type: 'ach',
    ach_status: 'pending_verification',
  };
});

test('pending bank verifies: ach_status → verified, consent-gated enrollment fires with the bank source', async () => {
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockPmUpdate).toHaveBeenCalledWith({ ach_status: 'verified' });
  expect(mockLinkPaymentMethodId).toHaveBeenCalledWith('pm_bank_1', 'pm-row-1');
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
    customerId: 'cust-1',
    paymentMethodId: 'pm-row-1',
    source: 'portal_add_bank',
  }));
  // Consent already recorded by the deferred save — no duplicate row.
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

test('no enrollment-scoped consent → verification recorded but NO enrollment (metadata is never authority)', async () => {
  mockHasConsentFor.mockResolvedValue(false);
  mockHasEnrollmentScopedConsent.mockResolvedValue(false);
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockPmUpdate).toHaveBeenCalledWith({ ach_status: 'verified' });
  // Backstop consent (the portal modal always showed the locked copy
  // before confirm), but enrollment still requires the SCOPED check.
  expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_bank', methodType: 'ach' }));
  expect(mockEnroll).not.toHaveBeenCalled();
});

test('ownership mismatch skips everything', async () => {
  state.paymentMethodRow = { ...state.paymentMethodRow, customer_id: 'cust-OTHER' };
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockPmUpdate).not.toHaveBeenCalled();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
});

test('re-delivery for a completed CARD save is a benign no-op re-run (already_enrolled path)', async () => {
  state.paymentMethodRow = { id: 'pm-row-2', customer_id: 'cust-1', method_type: 'card', ach_status: null };
  mockEnroll.mockResolvedValue({ enrolled: false, reason: 'already_enrolled', methodId: 'pm-row-2' });
  await handleSetupIntentSucceeded(setupIntent({ payment_method: 'pm_card_1' }));
  // No bank verification update for a card row.
  expect(mockPmUpdate).not.toHaveBeenCalled();
  expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ source: 'portal_add_card' }));
});

test('browser died before POST /cards: webhook saves the method itself (attached-only)', async () => {
  state.paymentMethodRow = null;
  mockSavePaymentMethod.mockImplementation(async () => {
    state.paymentMethodRow = { id: 'pm-row-3', customer_id: 'cust-1', method_type: 'ach', ach_status: 'verified' };
    return state.paymentMethodRow;
  });
  mockHasConsentFor.mockResolvedValue(false);
  await handleSetupIntentSucceeded(setupIntent());
  expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_bank_1', {
    enableAutopay: false,
    makeDefault: false,
    requireAttached: true,
  });
  expect(mockRecordConsent).toHaveBeenCalled();
});

test('a REMOVED pending method is never resurrected: detached PM skips the backstop quietly (Codex r1)', async () => {
  state.paymentMethodRow = null;
  const detachedErr = new Error('Payment method is not attached to this customer');
  detachedErr.code = 'PM_NOT_ATTACHED';
  mockSavePaymentMethod.mockRejectedValue(detachedErr);
  // Resolves (acks) — a retry can't change a customer's removal.
  await expect(handleSetupIntentSucceeded(setupIntent())).resolves.toBeUndefined();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(mockEnroll).not.toHaveBeenCalled();
  expect(mockPmUpdate).not.toHaveBeenCalled();
});
