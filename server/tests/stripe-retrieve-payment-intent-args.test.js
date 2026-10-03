/**
 * Codex round-16 P1 (PR #5331): StripeService.retrievePaymentIntent forwards retrieve PARAMS and
 * request OPTIONS to the SDK in their own positions (retrieve(id, params, options)) — a timeout
 * passed as params would be sent to Stripe as an unknown parameter.
 */
const mockRetrieve = jest.fn(async (id) => ({ id }));
jest.mock('stripe', () => jest.fn(() => ({ paymentIntents: { retrieve: mockRetrieve } })));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_x', publishableKey: 'pk_test_x' }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const StripeService = require('../services/stripe');

beforeEach(() => mockRetrieve.mockClear());

test('request options ride in the SDK third argument; params stay second', async () => {
  await StripeService.retrievePaymentIntent('pi_1', {}, { timeout: 5000, maxNetworkRetries: 0 });
  expect(mockRetrieve).toHaveBeenCalledWith('pi_1', {}, { timeout: 5000, maxNetworkRetries: 0 });
  await StripeService.retrievePaymentIntent('pi_2', { expand: ['latest_charge'] }, { timeout: 1000 });
  expect(mockRetrieve).toHaveBeenLastCalledWith('pi_2', { expand: ['latest_charge'] }, { timeout: 1000 });
});

test('existing callers are unchanged: no request options => the exact two-argument call', async () => {
  await StripeService.retrievePaymentIntent('pi_3');
  expect(mockRetrieve.mock.calls[0]).toEqual(['pi_3', {}]);
  await StripeService.retrievePaymentIntent('pi_4', { expand: ['latest_charge'] });
  expect(mockRetrieve.mock.calls[1]).toEqual(['pi_4', { expand: ['latest_charge'] }]);
});
