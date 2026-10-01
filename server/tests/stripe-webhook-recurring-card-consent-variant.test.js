/**
 * setup_intent.succeeded (purpose estimate_recurring_card) — durable recovery
 * of the accept's card enrollment records the SAME consent variant the capture
 * UI rendered (PR-B, GATE_PAF_EXISTING_CUSTOMERS). The accept stamps
 * estimate_data.acceptedRecurringCardConsentVariant next to the accepted
 * SetupIntent id; a crash between the accept commit and the inline enrollment
 * must not downgrade the recorded consent to the base card text.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../models/db', () => jest.fn());
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
  retrieveSetupIntent: jest.fn(),
}));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
const mockCompleteEnrollment = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/recurring-card-on-file', () => ({
  isRecurringCardOnFileEnabled: jest.fn(() => true),
  ACCEPTED_NO_CAPTURE_MARKER: 'no_capture_at_accept',
  resolveRecurringCaptureTender: jest.fn(async () => 'card'),
  completeRecurringCardEnrollment: (...a) => mockCompleteEnrollment(...a),
}));
jest.mock('../routes/estimate-public', () => ({
  isCommercialAutoAcceptEstimate: jest.fn(() => false),
  findLinkedUpcomingAppointment: jest.fn(async () => ({ id: 'ss-1' })),
  isEstimateAcceptActive: jest.fn(() => false),
}));

const db = require('../models/db');
const { _handleSetupIntentSucceeded: handleSetupIntentSucceeded } = require('../routes/stripe-webhook');

function estimateRow(estimateData) {
  return {
    id: 'est-1', status: 'accepted', customer_id: 'cust-1', accepted_service_mode: 'recurring',
    bill_by_invoice: false, estimate_data: estimateData,
  };
}

function wireDb(estimate) {
  db.schema = { hasTable: jest.fn(async () => false) };
  db.mockImplementation((table) => {
    const q = {};
    for (const m of ['where', 'whereNotNull', 'whereNull', 'orderBy']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'estimates') return estimate;
      if (table === 'customers') return { billing_mode: 'per_application' };
      return null;
    });
    return q;
  });
}

const SETUP_INTENT = {
  id: 'seti_1',
  created: 1765000000,
  payment_method: 'pm_stripe_1',
  metadata: { purpose: 'estimate_recurring_card', estimate_id: 'est-1' },
};

describe('estimate_recurring_card recovery records the accepted consent variant', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('an accept stamped after_visit_card recovers with after_visit_card (not the base text)', async () => {
    wireDb(estimateRow({
      acceptedRecurringCardSetupIntentId: 'seti_1',
      acceptedRecurringCardConsentVariant: 'after_visit_card',
    }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCompleteEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', stripePaymentMethodId: 'pm_stripe_1', setupIntentId: 'seti_1', consentVariant: 'after_visit_card',
    }));
  });

  test('no stamp (every accept that is not a moved existing customer): no variant, base consent exactly as before', async () => {
    wireDb(estimateRow({ acceptedRecurringCardSetupIntentId: 'seti_1' }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCompleteEnrollment.mock.calls[0][0]).not.toHaveProperty('consentVariant');
  });

  test('only the accepted intent carries the variant, and only a known variant is honored', async () => {
    wireDb(estimateRow({
      acceptedRecurringCardSetupIntentId: 'seti_1',
      acceptedRecurringCardConsentVariant: 'something_else',
    }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment.mock.calls[0][0]).not.toHaveProperty('consentVariant');

    // A superseded intent is never enrolled at all.
    mockCompleteEnrollment.mockClear();
    wireDb(estimateRow({
      acceptedRecurringCardSetupIntentId: 'seti_other',
      acceptedRecurringCardConsentVariant: 'after_visit_card',
    }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).not.toHaveBeenCalled();
  });
});

describe('estimate_recurring_card recovery never enrolls an intent the accept did not bind (PAF-B r2 pre-push P0)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('an accept that committed with NO verified capture (marker) never recovers a later-succeeding / discarded intent', async () => {
    wireDb(estimateRow({ acceptedRecurringCardSetupIntentId: 'no_capture_at_accept' }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).not.toHaveBeenCalled();
    expect(require('../services/stripe').retrieveSetupIntent).not.toHaveBeenCalled();
  });
});

describe('estimate_recurring_card recovery honors an explicit Auto Pay opt-out (PR-B)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('an accept stamped acceptedRecurringCardSkipEnrollment recovers with skipEnrollment (card kept, never enrolled)', async () => {
    wireDb(estimateRow({
      acceptedRecurringCardSetupIntentId: 'seti_1',
      acceptedRecurringCardSkipEnrollment: true,
    }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCompleteEnrollment).toHaveBeenCalledWith(expect.objectContaining({ skipEnrollment: true }));
  });

  test('no stamp (or a non-true value): enrollment proceeds exactly as before', async () => {
    wireDb(estimateRow({ acceptedRecurringCardSetupIntentId: 'seti_1' }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment.mock.calls[0][0]).not.toHaveProperty('skipEnrollment');
    mockCompleteEnrollment.mockClear();
    wireDb(estimateRow({ acceptedRecurringCardSetupIntentId: 'seti_1', acceptedRecurringCardSkipEnrollment: 'yes' }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment.mock.calls[0][0]).not.toHaveProperty('skipEnrollment');
  });

  test('only the accepted intent carries the opt-out stamp', async () => {
    wireDb(estimateRow({
      acceptedRecurringCardSetupIntentId: 'seti_other',
      acceptedRecurringCardSkipEnrollment: true,
    }));
    await handleSetupIntentSucceeded(SETUP_INTENT);
    expect(mockCompleteEnrollment).not.toHaveBeenCalled();
  });
});
