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

  describe('createEstimateDepositIntent', () => {
    test('mints at FACE value with base_amount + quote_at_confirm metadata', async () => {
      const StripeService = require('../services/stripe');
      await StripeService.createEstimateDepositIntent({ estimateId: 'est-1', amountDollars: 49 });

      expect(stripeClient.paymentIntents.create).toHaveBeenCalledTimes(1);
      const [params, opts] = stripeClient.paymentIntents.create.mock.calls[0];
      // Face value at mint — the surcharge only lands at finalize, when the
      // entered card's funding is known. Wallets confirm this amount as-is.
      expect(params.amount).toBe(4900);
      expect(params.metadata).toEqual(expect.objectContaining({
        purpose: 'estimate_deposit',
        estimate_id: 'est-1',
        base_amount: '49',
        surcharge_policy: 'quote_at_confirm',
      }));
      // Same idempotency shape as before the revert — deterministic from
      // (estimateId, amountCents).
      expect(opts.idempotencyKey).toBe('estimate_deposit_est-1_4900');
    });
  });

  describe('quoteEstimateDepositSurcharge', () => {
    test('credit funding quotes the 2.9% fee on the face value', async () => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi());
      stripeClient.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', type: 'card', card: { funding: 'credit' } });

      const quote = await StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
      });
      expect(quote.base).toBe(49);
      expect(quote.surcharge).toBeCloseTo(1.42, 2);
      expect(quote.total).toBeCloseTo(50.42, 2);
      expect(quote.funding).toBe('credit');
      expect(typeof quote.quoteToken).toBe('string');
    });

    test.each(['debit', 'prepaid', null])('%s funding quotes zero — face value only', async (funding) => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi());
      stripeClient.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', type: 'card', card: { funding } });

      const quote = await StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
      });
      expect(quote.surcharge).toBe(0);
      expect(quote.total).toBe(49);
    });

    test('rejects a PI pinned to a different estimate', async () => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi({ metadata: { purpose: 'estimate_deposit', estimate_id: 'est-OTHER', base_amount: '49' } }));

      await expect(StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
      })).rejects.toThrow(/does not match/);
    });

    test('rejects a non-deposit PI (crafted paymentIntentId)', async () => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi({ metadata: { purpose: 'invoice_payment', estimate_id: 'est-1' } }));

      await expect(StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_someone_elses',
        paymentMethodId: 'pm_1',
      })).rejects.toThrow(/does not match/);
    });

    test('409s an already-paid deposit', async () => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi({ status: 'succeeded' }));

      await expect(StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
      })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('finalizeEstimateDepositPayment', () => {
    const mintQuote = async () => {
      const StripeService = require('../services/stripe');
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi());
      stripeClient.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', type: 'card', card: { funding: 'credit' } });
      const quote = await StripeService.quoteEstimateDepositSurcharge({
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
      });
      return { StripeService, quote };
    };

    test('re-derives the surcharge, updates the PI to the total, and confirms server-side', async () => {
      const { StripeService, quote } = await mintQuote();
      const result = await StripeService.finalizeEstimateDepositPayment({
        estimateId: 'est-1',
        quoteToken: quote.quoteToken,
      });

      expect(stripeClient.paymentIntents.update).toHaveBeenCalledTimes(1);
      const [piId, updateParams] = stripeClient.paymentIntents.update.mock.calls[0];
      expect(piId).toBe('pi_deposit');
      expect(updateParams.amount).toBe(5042);
      expect(updateParams.payment_method).toBe('pm_1');
      // MERGED metadata — the credit authority (base_amount) stays pinned
      // from the create; finalize stamps the fee facts beside it.
      expect(updateParams.metadata).toEqual(expect.objectContaining({
        card_surcharge: '1.42',
        card_funding: 'credit',
      }));
      expect(updateParams.metadata.base_amount).toBeUndefined();
      expect(stripeClient.paymentIntents.confirm).toHaveBeenCalledWith('pi_deposit', {}, expect.anything());
      expect(result.status).toBe('succeeded');
      expect(result.total).toBeCloseTo(50.42, 2);
    });

    test('rejects a tampered quote token', async () => {
      const { StripeService, quote } = await mintQuote();
      const [payload] = quote.quoteToken.split('.');
      const forged = `${payload}.${crypto.createHmac('sha256', 'wrong-secret').update('x').digest('base64url')}`;

      await expect(StripeService.finalizeEstimateDepositPayment({
        estimateId: 'est-1',
        quoteToken: forged,
      })).rejects.toThrow(/Invalid or tampered/);
      expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
    });

    test('rejects an expired quote', async () => {
      const { StripeService } = await mintQuote();
      const stale = JSON.stringify({
        kind: 'estimate_deposit',
        estimateId: 'est-1',
        paymentIntentId: 'pi_deposit',
        paymentMethodId: 'pm_1',
        baseAmount: 49,
        quotedAt: Date.now() - 11 * 60 * 1000,
      });
      const sig = crypto.createHmac('sha256', 'test-secret').update(stale).digest('base64url');

      await expect(StripeService.finalizeEstimateDepositPayment({
        estimateId: 'est-1',
        quoteToken: `${Buffer.from(stale).toString('base64url')}.${sig}`,
      })).rejects.toThrow(/expired/i);
    });

    test('replays cleanly when the PI already succeeded (double-tap / webhook race)', async () => {
      const { StripeService, quote } = await mintQuote();
      stripeClient.paymentIntents.retrieve.mockResolvedValue(depositPi({ status: 'succeeded' }));

      const result = await StripeService.finalizeEstimateDepositPayment({
        estimateId: 'est-1',
        quoteToken: quote.quoteToken,
      });
      expect(result.status).toBe('succeeded');
      expect(stripeClient.paymentIntents.update).not.toHaveBeenCalled();
      expect(stripeClient.paymentIntents.confirm).not.toHaveBeenCalled();
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
  });
});
