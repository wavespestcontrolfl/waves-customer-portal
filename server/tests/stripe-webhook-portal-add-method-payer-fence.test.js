/**
 * setup_intent.succeeded (purpose portal_add_method) — payer-routing fence
 * before Auto Pay enrollment (Codex #3395 r9 P1).
 *
 * This webhook completes portal card/bank saves independently of the
 * browser POST (it can arrive before or after it), so it needs the same
 * payer fence as POST /billing-v2/cards: a customer whose invoices route
 * to a third-party payer — or whose payer picture is unknowable (FAIL
 * CLOSED) — keeps the method saved with consent recorded but is never
 * enrolled, and a billing office exception parks. Self-pay enrolls as
 * before. No rethrow: the skip is deliberate, not a retryable failure.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('./stripe-webhook-helpers', () => ({ classifyExistingWebhookEvent: jest.fn(), STALE_CLAIM_WINDOW_MS: 60000 }), { virtual: true });
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
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  retrievePaymentMethod: jest.fn(),
  savePaymentMethod: jest.fn(),
}));
jest.mock('../services/payment-method-consents', () => ({
  hasEnrollmentScopedConsent: jest.fn(async () => true),
  recordConsent: jest.fn(async () => ({})),
  linkPaymentMethodId: jest.fn(async () => ({})),
}));
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: jest.fn(async () => ({ enrolled: true })),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const PayerService = require('../services/payer');
const { enrollConsentedMethod } = require('../services/autopay-enrollment');
const NotificationService = require('../services/notification-service');
const { _handleSetupIntentSucceeded: handleSetupIntentSucceeded } = require('../routes/stripe-webhook');

const SETUP_INTENT = {
  id: 'si_1',
  created: 1765000000,
  payment_method: 'pm_stripe_1',
  metadata: { purpose: 'portal_add_method', waves_customer_id: 'cust-1' },
};

const SAVED_ROW = {
  id: 'pm-row-1', customer_id: 'cust-1', method_type: 'card',
  stripe_payment_method_id: 'pm_stripe_1',
};

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => {
    const q = {};
    q.where = () => q;
    q.first = async () => ({ ...SAVED_ROW });
    return q;
  });
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
});

describe('portal-add-method webhook payer fence', () => {
  test('self-pay accounts enroll as before', async () => {
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', throwOnError: true,
    }));
    expect(enrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', paymentMethodId: 'pm-row-1',
    }));
  });

  test('a payer-billed account is never enrolled by the webhook — office exception parked', async () => {
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(enrollConsentedMethod).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringMatching(/payer-billed/), expect.any(String), expect.any(Object),
    );
  });

  test('a transient payer-lookup failure RETHROWS so Stripe retries — never a permanent silent skip', async () => {
    // Returning success would mark the event processed; for micro-deposit
    // verification this webhook is the ONLY completion path, so a transient
    // DB failure would permanently strand a self-pay enrollment. All steps
    // are idempotent — the retry re-enters safely.
    PayerService.resolveForInvoice.mockRejectedValue(new Error('payer lookup down'));
    await expect(handleSetupIntentSucceeded(SETUP_INTENT)).rejects.toThrow('payer lookup down');
    expect(enrollConsentedMethod).not.toHaveBeenCalled();
  });
});
