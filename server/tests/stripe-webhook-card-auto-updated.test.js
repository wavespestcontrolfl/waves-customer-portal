// payment_method.automatically_updated: refresh the card by id through
// card-details-sync refreshCardFromStripe (it re-reads Stripe; the event
// payload is never applied); gate off does nothing; an unconfigured Stripe or
// a conflict that persists throws so the dispatcher records the failure and
// Stripe retries.

jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.transaction = jest.fn();
  return dbMock;
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
jest.mock('../services/stripe-pricing', () => ({ computeChargeAmount: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: { cardDetailsSync: true } }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/card-details-sync', () => ({ refreshCardFromStripe: jest.fn(async () => ({ updated: 1, conflict: false })) }));

const { refreshCardFromStripe } = require('../services/card-details-sync');
const gatesModule = require('../config/feature-gates');
const { _handlePaymentMethodAutomaticallyUpdated: handle } = require('../routes/stripe-webhook');

const STALE_PAYLOAD = { id: 'pm_a', type: 'card', card: { exp_month: 5, exp_year: 2027, last4: '1111', brand: 'visa' } };

beforeEach(() => {
  jest.clearAllMocks();
  gatesModule.gates.cardDetailsSync = true;
});

test('refreshes the card by id from Stripe, never from the event payload', async () => {
  await handle(STALE_PAYLOAD);
  expect(refreshCardFromStripe).toHaveBeenCalledTimes(1);
  expect(refreshCardFromStripe).toHaveBeenCalledWith('pm_a', { source: 'webhook' });
});

test('gate off: no refresh', async () => {
  gatesModule.gates.cardDetailsSync = false;
  await handle(STALE_PAYLOAD);
  expect(refreshCardFromStripe).not.toHaveBeenCalled();
});

test('Stripe unconfigured throws so Stripe retries', async () => {
  refreshCardFromStripe.mockResolvedValueOnce({ stripeMissing: true, updated: 0 });
  await expect(handle(STALE_PAYLOAD)).rejects.toThrow(/Stripe not configured/);
});

test('a card that kept changing throws so Stripe delivers the event again', async () => {
  refreshCardFromStripe.mockResolvedValueOnce({ updated: 0, conflict: true });
  await expect(handle(STALE_PAYLOAD)).rejects.toThrow(/concurrent refresh/);
});

test('a card with no Stripe customer is skipped without an error', async () => {
  refreshCardFromStripe.mockResolvedValueOnce({ detached: true, updated: 0 });
  await expect(handle(STALE_PAYLOAD)).resolves.toBeUndefined();
});

test('a Stripe or database error propagates to the dispatcher', async () => {
  refreshCardFromStripe.mockRejectedValueOnce(new Error('db down'));
  await expect(handle(STALE_PAYLOAD)).rejects.toThrow('db down');
});
