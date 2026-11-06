// payment_method.automatically_updated: apply the card as Stripe holds it NOW
// (re-read), never the event payload; gate off does nothing; an unconfigured
// Stripe throws so the dispatcher records the failure and Stripe retries.

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
jest.mock('../services/card-details-sync', () => ({ applyStripeCardDetails: jest.fn(async () => ({ updated: 1 })) }));
jest.mock('../services/stripe', () => ({
  ...jest.requireActual('../services/stripe'),
  retrievePaymentMethod: jest.fn(),
}));

const stripe = require('../services/stripe');
const { applyStripeCardDetails } = require('../services/card-details-sync');
const gatesModule = require('../config/feature-gates');
const { _handlePaymentMethodAutomaticallyUpdated: handle } = require('../routes/stripe-webhook');

const FRESH = { id: 'pm_a', type: 'card', customer: 'cus_1', card: { exp_month: 11, exp_year: 2029, last4: '4242', brand: 'visa' } };
const STALE_PAYLOAD = { id: 'pm_a', type: 'card', card: { exp_month: 5, exp_year: 2027, last4: '1111', brand: 'visa' } };

beforeEach(() => {
  jest.clearAllMocks();
  gatesModule.gates.cardDetailsSync = true;
});

test('applies the freshly retrieved PaymentMethod, not the event payload', async () => {
  stripe.retrievePaymentMethod.mockResolvedValue(FRESH);
  await handle(STALE_PAYLOAD);
  expect(stripe.retrievePaymentMethod).toHaveBeenCalledWith('pm_a');
  expect(applyStripeCardDetails).toHaveBeenCalledTimes(1);
  expect(applyStripeCardDetails).toHaveBeenCalledWith(FRESH, { source: 'webhook' });
});

test('gate off: no Stripe read and no write', async () => {
  gatesModule.gates.cardDetailsSync = false;
  await handle(STALE_PAYLOAD);
  expect(stripe.retrievePaymentMethod).not.toHaveBeenCalled();
  expect(applyStripeCardDetails).not.toHaveBeenCalled();
});

test('Stripe unconfigured (null) throws so Stripe retries', async () => {
  stripe.retrievePaymentMethod.mockResolvedValue(null);
  await expect(handle(STALE_PAYLOAD)).rejects.toThrow(/Stripe not configured/);
  expect(applyStripeCardDetails).not.toHaveBeenCalled();
});

test('a Stripe or database error propagates to the dispatcher', async () => {
  stripe.retrievePaymentMethod.mockResolvedValue(FRESH);
  applyStripeCardDetails.mockRejectedValueOnce(new Error('db down'));
  await expect(handle(STALE_PAYLOAD)).rejects.toThrow('db down');
});
