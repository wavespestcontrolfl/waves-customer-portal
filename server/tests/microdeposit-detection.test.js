// Unit tests for StripeService.isInvoiceAwaitingMicrodepositVerification — the
// shared detection used by both dunning sweeps to divert micro-deposit-blocked
// invoices to a verification re-nudge. Must be precise (ACH micro-deposit only,
// never a card 3DS) and FAIL OPEN so a Stripe error never suppresses real dunning.
describe('StripeService.isInvoiceAwaitingMicrodepositVerification', () => {
  let stripeClient;

  beforeEach(() => {
    jest.resetModules();
    stripeClient = { paymentIntents: { retrieve: jest.fn() } };
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models/db', () => jest.fn());
  });

  test('true for an ACH micro-deposit PI in requires_action', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      status: 'requires_action',
      next_action: { type: 'verify_with_microdeposits' },
    });
    const StripeService = require('../services/stripe');
    await expect(StripeService.isInvoiceAwaitingMicrodepositVerification(
      { id: 'inv1', stripe_payment_intent_id: 'pi_1' },
    )).resolves.toBe(true);
  });

  test('false for a card 3DS PI in requires_action (different next_action)', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({
      status: 'requires_action',
      next_action: { type: 'use_stripe_sdk' },
    });
    const StripeService = require('../services/stripe');
    await expect(StripeService.isInvoiceAwaitingMicrodepositVerification(
      { id: 'inv1', stripe_payment_intent_id: 'pi_1' },
    )).resolves.toBe(false);
  });

  test('false for a processing PI (already verified, money in flight)', async () => {
    stripeClient.paymentIntents.retrieve.mockResolvedValueOnce({ status: 'processing', next_action: null });
    const StripeService = require('../services/stripe');
    await expect(StripeService.isInvoiceAwaitingMicrodepositVerification(
      { id: 'inv1', stripe_payment_intent_id: 'pi_1' },
    )).resolves.toBe(false);
  });

  test('false (no Stripe call) when the invoice has no PaymentIntent', async () => {
    const StripeService = require('../services/stripe');
    await expect(StripeService.isInvoiceAwaitingMicrodepositVerification({ id: 'inv1' })).resolves.toBe(false);
    expect(stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('FAILS OPEN (false) when the Stripe retrieve throws — never suppress real dunning', async () => {
    stripeClient.paymentIntents.retrieve.mockRejectedValueOnce(new Error('stripe unavailable'));
    const StripeService = require('../services/stripe');
    await expect(StripeService.isInvoiceAwaitingMicrodepositVerification(
      { id: 'inv1', stripe_payment_intent_id: 'pi_1' },
    )).resolves.toBe(false);
  });
});
