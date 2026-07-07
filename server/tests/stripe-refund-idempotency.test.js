/**
 * StripeService.refund — idempotency + cumulative partials.
 *
 * The admin refund used to call stripe.refunds.create with NO idempotency
 * key and collapse every failure (including a post-refund DB write failure)
 * into a retryable-looking "Refund processing failed" — a re-click after a
 * Stripe-success/DB-failure issued a SECOND real refund for partials. It
 * also OVERWROTE refund_amount instead of accumulating, so two partials
 * summing to 100% left status='paid' with only the last partial recorded.
 *
 * Contract:
 *  - refunds.create carries an idempotency key derived from
 *    (payment, requested cents, prior refunded cents) — retries of the same
 *    attempt replay; a new partial after the prior was recorded re-keys.
 *  - refund_amount accumulates; cumulative total >= paid flips 'refunded'.
 *  - requests beyond the remaining balance are rejected before Stripe.
 *  - a DB failure AFTER the refund reports "re-running is safe", never the
 *    generic retry-inviting failure message.
 */

describe('StripeService.refund', () => {
  let stripeClient;
  let dbMock;
  let paymentRow;
  let updatePayments;

  function loadService() {
    // eslint-disable-next-line global-require
    return require('../services/stripe');
  }

  beforeEach(() => {
    jest.resetModules();

    paymentRow = {
      id: 'pay-1',
      customer_id: 'cust-1',
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_abc',
      amount: '100.00',
      refund_amount: null,
      status: 'paid',
    };
    updatePayments = jest.fn().mockResolvedValue(1);

    stripeClient = {
      refunds: {
        create: jest.fn(async (params) => ({
          id: 're_1',
          status: 'succeeded',
          amount: params.amount != null ? params.amount : Math.round(parseFloat(paymentRow.amount) * 100) - Math.round(parseFloat(paymentRow.refund_amount || 0) * 100),
          created: 1780000000,
        })),
      },
    };

    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      first: jest.fn(async () => paymentRow),
      update: updatePayments,
    };
    const invoicesQuery = {
      where: jest.fn(() => invoicesQuery),
      first: jest.fn(async () => null),
    };
    dbMock = jest.fn((table) => {
      if (table === 'payments') return paymentsQuery;
      if (table === 'invoices') return invoicesQuery;
      throw new Error(`Unexpected db table: ${table}`);
    });
    dbMock.transaction = jest.fn(async (cb) => cb(dbMock));

    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_mock',
      publishableKey: 'pk_test_mock',
    }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/payment-lifecycle-email', () => ({
      sendRefundIssued: jest.fn(async () => undefined),
    }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      syncTermForRefundedPayment: jest.fn(async () => undefined),
    }));
    jest.doMock('../services/customer-credit', () => ({
      returnAppliedCreditOnRefund: jest.fn(async () => undefined),
    }));
  });

  test('partial refund sends an idempotency key and accumulates refund_amount', async () => {
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ payment_intent: 'pi_abc', amount: 4000 }));
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');

    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'paid',
      refund_amount: 40,
      stripe_refund_id: 're_1',
    }));
  });

  test('second partial reaching 100% flips status to refunded with cumulative total', async () => {
    paymentRow.refund_amount = '40.00';
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 60 });

    const [, opts] = stripeClient.refunds.create.mock.calls[0];
    // Prior refunded cents shifts the key — a NEW partial never collides
    // with a retry of the first one.
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_6000_4000');
    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'refunded',
      refund_amount: 100,
    }));
  });

  test('full refund (no amount) keys on the remaining balance and records Stripe ground truth', async () => {
    paymentRow.refund_amount = '25.00';
    const StripeService = loadService();
    await StripeService.refund('pay-1', {});

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBeUndefined();
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_rest_2500');
    // Stripe refunded the remaining 75.00 (from the mocked response).
    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'refunded',
      refund_amount: 100,
    }));
  });

  test('rejects a refund beyond the remaining balance before calling Stripe', async () => {
    paymentRow.refund_amount = '80.00';
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 30 }))
      .rejects.toThrow(/remaining \$20\.00/);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  test('rejects when the payment is already fully refunded', async () => {
    paymentRow.refund_amount = '100.00';
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 10 }))
      .rejects.toThrow(/already fully refunded/);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  test('DB failure AFTER the refund does not report the retry-inviting generic failure', async () => {
    updatePayments.mockRejectedValueOnce(new Error('connection reset'));
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow(/WAS issued at Stripe.*safe/);
  });

  test('Stripe failure still reports the plain refund failure', async () => {
    stripeClient.refunds.create.mockRejectedValueOnce(new Error('card_declined'));
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow('Refund processing failed');
    expect(updatePayments).not.toHaveBeenCalled();
  });
});
