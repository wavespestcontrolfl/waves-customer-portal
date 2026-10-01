/**
 * setup_intent.succeeded -> estimate_recurring_card recovery backstop records the
 * consent variant the ACCEPT rendered and persisted (estimate_data.
 * acceptedRecurringCardConsentVariant, Codex round 2 P1 on #5485): an after-visit
 * accept whose browser never returned must not be enrolled under the BASE consent.
 */
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', webhookSecret: 'whsec_mock' }));
jest.mock('../routes/stripe-webhook-helpers', () => ({
  classifyExistingWebhookEvent: jest.fn(),
  invoicePaymentIntentBlocksFallback: jest.fn(() => false),
  savedCardAttemptMatchesPaymentIntent: jest.fn(() => false),
  savedCardCreditAdjustment: jest.fn(() => null),
  STALE_CLAIM_WINDOW_MS: 60000,
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+15550009999') }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/stripe-invoice-state', () => ({
  isInvoiceCollectibleStatus: jest.fn(() => true),
  invoiceStatusForSuccessfulPayment: jest.fn(),
  invoiceStatusForFailedPayment: jest.fn(),
  INVOICE_COLLECTIBLE_STATUSES: [],
}));
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
const mockGateEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockGateEnabled(...a), gates: {} }));
jest.mock('../services/invoice-helpers', () => ({ INVOICE_UNCOLLECTIBLE_STATUSES: ['void'], invoiceAmountDue: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.test') }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendRefundIssued: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ handleDepositChargeReversed: jest.fn(async () => ({ handled: false })) }));


jest.mock('../services/stripe', () => ({ savePaymentMethod: jest.fn(), retrievePaymentMethod: jest.fn() }));
jest.mock('../services/payment-method-consents', () => ({}));
jest.mock('../services/autopay-enrollment', () => ({}));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
const mockEnrollEstimateCard = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/recurring-card-on-file', () => ({
  isRecurringCardOnFileEnabled: jest.fn(() => true),
  completeRecurringCardEnrollment: (...a) => mockEnrollEstimateCard(...a),
  resolveRecurringCaptureTender: jest.fn(async () => 'card'),
}));
jest.mock('../routes/estimate-public', () => ({
  isCommercialAutoAcceptEstimate: jest.fn(() => false),
  findLinkedUpcomingAppointment: jest.fn(async () => ({ id: 'ss-1' })),
  isEstimateAcceptActive: jest.fn(() => false),
}));

let mockEstimateRow;
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotNull = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'estimates' ? mockEstimateRow : table === 'customers' ? { billing_mode: 'per_application' } : null));
    return q;
  });
  db.schema = { hasTable: jest.fn(async () => false) };
  db.transaction = jest.fn();
  return db;
});

const { _handleSetupIntentSucceeded: handleSetupIntentSucceeded } = require('../routes/stripe-webhook');

const intent = () => ({ id: 'seti_rec_1', status: 'succeeded', payment_method: 'pm_rec_1', metadata: { purpose: 'estimate_recurring_card', estimate_id: 'est-1' } });
const accepted = (estimateData) => ({ id: 'est-1', status: 'accepted', customer_id: 'cust-1', bill_by_invoice: false, accepted_service_mode: null, estimate_data: estimateData });

beforeEach(() => { jest.clearAllMocks(); });

test('an after-visit accept (variant persisted at accept): the recovery enrolls under the SAME after_visit_card consent', async () => {
  mockEstimateRow = accepted(JSON.stringify({ acceptedRecurringCardSetupIntentId: 'seti_rec_1', acceptedRecurringCardConsentVariant: 'after_visit_card' }));
  await handleSetupIntentSucceeded(intent());
  expect(mockEnrollEstimateCard).toHaveBeenCalledTimes(1);
  expect(mockEnrollEstimateCard.mock.calls[0][0]).toMatchObject({ customerId: 'cust-1', setupIntentId: 'seti_rec_1', consentVariant: 'after_visit_card' });
});

test('an accept with no persisted variant: the recovery passes none (base consent, unchanged)', async () => {
  mockEstimateRow = accepted({ acceptedRecurringCardSetupIntentId: 'seti_rec_1' });
  await handleSetupIntentSucceeded(intent());
  expect(mockEnrollEstimateCard).toHaveBeenCalledTimes(1);
  expect(mockEnrollEstimateCard.mock.calls[0][0]).not.toHaveProperty('consentVariant');
});

test('an unknown persisted variant is never forwarded', async () => {
  mockEstimateRow = accepted({ acceptedRecurringCardSetupIntentId: 'seti_rec_1', acceptedRecurringCardConsentVariant: 'made_up' });
  await handleSetupIntentSucceeded(intent());
  expect(mockEnrollEstimateCard.mock.calls[0][0]).not.toHaveProperty('consentVariant');
});
