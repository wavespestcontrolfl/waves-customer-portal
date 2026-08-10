/**
 * Pins the PRODUCT DECISION (owner ruling 2026-07-13, reversing the
 * 2026-06-12 exemption): estimate deposits ARE surcharged, with the same
 * machinery as invoice payments — credit-funding-only, priced at confirm
 * via quoteEstimateDepositSurcharge → finalizeEstimateDepositPayment, with
 * customer-facing disclosure before the charged tap. Wallets (Express
 * Checkout) stay at face value — Phase-1 parity with the invoice pay page.
 *
 * Two invariants survive the revert unchanged:
 *   1. The PI MINTS at face value (funding is unknown until card entry).
 *   2. The LEDGER credits face value (metadata.base_amount), never
 *      amount_received — a $49 deposit paid by credit card captures $50.42
 *      but credits exactly $49; the fee is recorded separately.
 * Commercial prepay keeps its own exemption (owner ruling 2026-07-05,
 * expressly NOT reversed).
 */
const crypto = require('crypto');

describe('estimate deposit surcharge (owner ruling 2026-07-13)', () => {
  let stripeClient;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = 'test-secret';

    stripeClient = {
      paymentIntents: {
        create: jest.fn().mockResolvedValue({
          id: 'pi_deposit',
          status: 'requires_payment_method',
          client_secret: 'pi_deposit_secret',
        }),
        retrieve: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        confirm: jest.fn().mockResolvedValue({
          id: 'pi_deposit',
          status: 'succeeded',
          client_secret: 'pi_deposit_secret',
        }),
      },
      paymentMethods: {
        retrieve: jest.fn(),
      },
    };

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

  const depositPi = (overrides = {}) => ({
    id: 'pi_deposit',
    status: 'requires_payment_method',
    client_secret: 'pi_deposit_secret',
    amount: 4900,
    metadata: {
      purpose: 'estimate_deposit',
      estimate_id: 'est-1',
      base_amount: '49',
      surcharge_policy: 'quote_at_confirm',
    },
    ...overrides,
  });


  // RETIREMENT (owner ruling 2026-08-10): the deposit money-moving trio
  // (createEstimateDepositIntent / quoteEstimateDepositSurcharge /
  // finalizeEstimateDepositPayment) and the wallet-preflight reset were
  // REMOVED with the acceptance-deposit retirement — their behavior pins
  // left with them. The LEDGER interpretation of the 2026-07-13 surcharge
  // ruling (face value from base_amount, never amount_received) survives
  // below: the 2026-06/07 historical rows are read through it forever.
  describe('deposit payment methods are gone from the Stripe service surface', () => {
    test('removed methods are undefined — nothing can mint or confirm a deposit PI', () => {
      const StripeService = require('../services/stripe');
      expect(StripeService.createEstimateDepositIntent).toBeUndefined();
      expect(StripeService.quoteEstimateDepositSurcharge).toBeUndefined();
      expect(StripeService.finalizeEstimateDepositPayment).toBeUndefined();
      expect(StripeService.resetEstimateDepositIntentToFace).toBeUndefined();
    });
  });

  describe('ledger face value (the credit never inflates)', () => {
    test('depositFaceValueDollars prefers pinned base_amount over amount_received', () => {
      const { depositFaceValueDollars, depositSurchargeDollars } = jest.requireActual('../services/stripe-pricing');
      const surchargedCapture = depositPi({
        status: 'succeeded',
        amount: 5042,
        amount_received: 5042,
        metadata: {
          purpose: 'estimate_deposit',
          estimate_id: 'est-1',
          base_amount: '49',
          card_surcharge: '1.42',
        },
      });
      expect(depositFaceValueDollars(surchargedCapture)).toBe(49);
      expect(depositSurchargeDollars(surchargedCapture)).toBe(1.42);
    });

    test('pre-revert PIs (no base_amount) fall back to amount_received', () => {
      const { depositFaceValueDollars, depositSurchargeDollars } = jest.requireActual('../services/stripe-pricing');
      const legacy = {
        amount_received: 4900,
        metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1', surcharge_policy: 'deposit_exempt' },
      };
      expect(depositFaceValueDollars(legacy)).toBe(49);
      expect(depositSurchargeDollars(legacy)).toBe(0);
    });

    test('a PENDING legacy PI (amount_received: 0, Stripe default) faces from amount, not zero (r5)', () => {
      const { depositFaceValueDollars } = jest.requireActual('../services/stripe-pricing');
      const pendingLegacy = {
        amount: 4900,
        amount_received: 0,
        metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1', surcharge_policy: 'deposit_exempt' },
      };
      expect(depositFaceValueDollars(pendingLegacy)).toBe(49);
    });
  });

});
