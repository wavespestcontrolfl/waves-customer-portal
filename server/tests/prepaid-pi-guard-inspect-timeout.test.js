/**
 * Pre-push audit P1 (PR #5331): the read-only (inspectOnly) PaymentIntent inspect that the
 * public pay page runs bounds its Stripe read; the mutating path keeps the default call.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: jest.fn(), cancelPaymentIntent: jest.fn() }));
jest.mock('../services/pay-combined', () => ({ clearPaymentIntentStamps: jest.fn(async () => {}) }));
jest.mock('../models/db', () => jest.fn());

const Stripe = require('../services/stripe');
const { guardOpenPaymentIntentForPrepaid } = require('../services/prepaid-pi-guard');

beforeEach(() => jest.clearAllMocks());

test('inspectOnly bounds the Stripe read (timeout, no SDK retries)', async () => {
  Stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'requires_payment_method' });
  await expect(guardOpenPaymentIntentForPrepaid({ id: 'i', stripe_payment_intent_id: 'pi_1' }, { inspectOnly: true })).resolves.toMatchObject({ ok: true });
  // params (2nd arg) and REQUEST options (3rd arg) are separate — the timeout must never ride as retrieve params
  expect(Stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_1', {}, { timeout: 5000, maxNetworkRetries: 0 });
});

test('a Stripe timeout on the inspect fails closed (payment_session_unverifiable)', async () => {
  Stripe.retrievePaymentIntent.mockRejectedValue(Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }));
  await expect(guardOpenPaymentIntentForPrepaid({ id: 'i', stripe_payment_intent_id: 'pi_1' }, { inspectOnly: true })).resolves.toMatchObject({ ok: false, reason: 'payment_session_unverifiable' });
});

test('the mutating path keeps the unbounded default read', async () => {
  Stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
  await guardOpenPaymentIntentForPrepaid({ id: 'i', stripe_payment_intent_id: 'pi_1' });
  expect(Stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_1');
});

