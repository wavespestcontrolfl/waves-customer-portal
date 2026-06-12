/**
 * Pins the PRODUCT DECISION (owner, 2026-06-12) that estimate deposits are
 * surcharge-exempt: createEstimateDepositIntent charges the flat deposit at
 * face value and never routes the amount through computeChargeAmount. The
 * customer-facing deposit must equal the first-invoice credit exactly; the
 * 3.99% card surcharge applies only to the remaining invoice balance.
 *
 * If this test is failing because deposits started getting surcharged, that
 * is a deliberate policy reversal — it needs owner sign-off and customer-
 * facing disclosure in the deposit UI, not just a code change.
 */
describe('StripeService.createEstimateDepositIntent — surcharge exemption (pinned decision)', () => {
  let stripeClient;
  let computeChargeAmountSpy;

  beforeEach(() => {
    jest.resetModules();

    stripeClient = {
      paymentIntents: {
        create: jest.fn().mockResolvedValue({
          id: 'pi_deposit',
          status: 'requires_payment_method',
          client_secret: 'pi_deposit_secret',
        }),
      },
    };

    const actualPricing = jest.requireActual('../services/stripe-pricing');
    computeChargeAmountSpy = jest.fn(actualPricing.computeChargeAmount);
    jest.doMock('../services/stripe-pricing', () => ({
      ...actualPricing,
      computeChargeAmount: computeChargeAmountSpy,
    }));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../models/db', () => jest.fn());
  });

  test('$49 recurring deposit is charged at exact face value with deposit_exempt metadata', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.createEstimateDepositIntent({ estimateId: 'est-1', amountDollars: 49 });

    expect(stripeClient.paymentIntents.create).toHaveBeenCalledTimes(1);
    const [params, opts] = stripeClient.paymentIntents.create.mock.calls[0];
    expect(params.amount).toBe(4900);
    expect(params.metadata).toEqual(expect.objectContaining({
      purpose: 'estimate_deposit',
      estimate_id: 'est-1',
      surcharge_policy: 'deposit_exempt',
    }));
    expect(opts.idempotencyKey).toBe('estimate_deposit_est-1_4900');
  });

  test('$99 one-time deposit is charged at exact face value with deposit_exempt metadata', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.createEstimateDepositIntent({ estimateId: 'est-2', amountDollars: 99 });

    const [params] = stripeClient.paymentIntents.create.mock.calls[0];
    expect(params.amount).toBe(9900);
    expect(params.metadata.surcharge_policy).toBe('deposit_exempt');
  });

  test('never routes the deposit amount through computeChargeAmount', async () => {
    const StripeService = require('../services/stripe');
    await StripeService.createEstimateDepositIntent({ estimateId: 'est-3', amountDollars: 49 });
    await StripeService.createEstimateDepositIntent({ estimateId: 'est-4', amountDollars: 99 });

    expect(computeChargeAmountSpy).not.toHaveBeenCalled();
  });

  test('the exemption is meaningful: surcharged math would have charged more', () => {
    // Guards against the exemption becoming vacuously true (e.g. a future
    // computeChargeAmount that no-ops on small amounts).
    const { computeChargeAmount } = jest.requireActual('../services/stripe-pricing');
    const surcharged = computeChargeAmount(49, 'card', { funding: 'credit' });
    expect(surcharged.totalCents).toBeGreaterThan(4900);
  });
});
