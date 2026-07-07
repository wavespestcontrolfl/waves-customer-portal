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
 *  - the attempt's idempotency key is PERSISTED (payments.metadata
 *    pending_refund_*) before Stripe is called: a retry after any
 *    unresolved outcome replays the ORIGINAL key even when the
 *    charge.refunded webhook repaired refund_amount in between (a key
 *    derived from live local state would shift and mint a second refund).
 *  - refund_amount accumulates; cumulative total >= paid flips 'refunded';
 *    an omitted-amount refund is fully refunded by definition.
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

  test('partial refund persists the attempt key before Stripe and accumulates refund_amount', async () => {
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ payment_intent: 'pi_abc', amount: 4000 }));
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');

    // First update = the pending-attempt persist, BEFORE the Stripe call.
    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(pendingMeta.pending_refund_key).toBe('refund_pay_pay-1_4000_0');
    expect(pendingMeta.pending_refund_request).toBe('4000');

    // Final update records the refund and clears the pending marker.
    const finalArgs = updatePayments.mock.calls[1][0];
    expect(finalArgs).toEqual(expect.objectContaining({
      status: 'paid',
      refund_amount: 40,
      stripe_refund_id: 're_1',
    }));
    expect(JSON.parse(finalArgs.metadata).pending_refund_key).toBeUndefined();
  });

  test('retry after a webhook repair replays the ORIGINAL attempt key (no second refund)', async () => {
    // First attempt refunded $40 at Stripe, local update failed, then the
    // charge.refunded webhook repaired refund_amount to 40. The pending
    // marker still holds the original key — the retry must reuse it, not
    // derive a fresh one from the repaired prior.
    paymentRow.refund_amount = '40.00';
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    const [, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');
    // No pending re-persist — the only update is the final record+clear.
    expect(updatePayments).toHaveBeenCalledTimes(1);
  });

  test('replay bypasses the remaining-balance check (repaired $60-of-$100 retry is not wedged)', async () => {
    // $60 refund succeeded at Stripe, local update failed, webhook
    // repaired refund_amount=60 → remaining is $40. Retrying the same $60
    // must replay the persisted key (Stripe dedupes; no new money), not be
    // rejected by the new-attempt balance validation.
    paymentRow.refund_amount = '60.00';
    paymentRow.stripe_refund_id = 're_1';
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_6000_0',
      pending_refund_request: '6000',
      pending_refund_at: new Date().toISOString(),
    });
    stripeClient.refunds.create.mockResolvedValueOnce({
      id: 're_1', status: 'succeeded', amount: 6000, created: 1780000000,
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 60 });

    const [, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_6000_0');
    // Ledger stays at the repaired $60 — the replay is not re-added.
    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'paid',
      refund_amount: 60,
    }));
  });

  test('webhook-repaired replay does NOT double-count the same refund in the ledger', async () => {
    // Same scenario, focused on the amount: webhook wrote refund_amount=40
    // and stripe_refund_id=re_1 from THIS refund. The replay returns the
    // original re_1 — prior already includes it, so the ledger must stay
    // at $40, not 40 + 40 = 80.
    paymentRow.refund_amount = '40.00';
    paymentRow.stripe_refund_id = 're_1';
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'paid',
      refund_amount: 40,
    }));
  });

  test("Stripe's cumulative amount_refunded overrides local math when the charge is retrievable", async () => {
    // Ledger saw nothing, but the charge already carries a $30 dashboard
    // partial; this $40 refund brings Stripe's cumulative to 70.
    stripeClient.refunds.create.mockResolvedValueOnce({
      id: 're_2', status: 'succeeded', amount: 4000, created: 1780000000, charge: 'ch_1',
    });
    stripeClient.charges = { retrieve: jest.fn(async () => ({ id: 'ch_1', amount_refunded: 7000 })) };
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    expect(stripeClient.charges.retrieve).toHaveBeenCalledWith('ch_1');
    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'paid',
      refund_amount: 70,
    }));
  });

  test('a DIFFERENT amount while an attempt is unresolved is rejected', async () => {
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 25 }))
      .rejects.toThrow(/unresolved refund attempt/);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  test('second partial reaching 100% flips status to refunded with cumulative total', async () => {
    paymentRow.refund_amount = '40.00';
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 60 });

    const [, opts] = stripeClient.refunds.create.mock.calls[0];
    // A NEW partial (no pending marker) mints a fresh key off the recorded
    // prior — it never collides with a retry of the first attempt.
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_6000_4000');
    expect(updatePayments).toHaveBeenCalledWith(expect.objectContaining({
      status: 'refunded',
      refund_amount: 100,
    }));
  });

  test('omitted-amount refund is fully refunded by definition (out-of-band partials included)', async () => {
    // Local ledger saw only $25 refunded, but a dashboard-side partial
    // means Stripe's remaining balance is smaller than paid - 25. Whatever
    // Stripe returns for the remainder, an omitted-amount refund empties
    // the charge — record it as fully refunded, not local prior + amount.
    paymentRow.refund_amount = '25.00';
    stripeClient.refunds.create.mockResolvedValueOnce({
      id: 're_1', status: 'succeeded', amount: 6000, created: 1780000000,
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', {});

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBeUndefined();
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_rest_2500');
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

  test('DB failure AFTER the refund keeps the pending marker and reports "re-run safe"', async () => {
    updatePayments
      .mockResolvedValueOnce(1) // pending-attempt persist
      .mockRejectedValueOnce(new Error('connection reset')); // final record
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow(/WAS issued at Stripe.*safe/);
    // No clearing write after the failure — the marker survives so the
    // retry replays the same key.
    expect(updatePayments).toHaveBeenCalledTimes(2);
  });

  test('ambiguous Stripe failure keeps the pending marker; definitive rejection clears it', async () => {
    const StripeService = loadService();

    // Ambiguous (no err.type — connection-ish): marker kept, only the
    // persist write happened.
    stripeClient.refunds.create.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow('Refund processing failed');
    expect(updatePayments).toHaveBeenCalledTimes(1);

    // Definitive rejection: marker cleared (persist + clear writes).
    updatePayments.mockClear();
    const rejection = new Error('No such payment_intent');
    rejection.type = 'StripeInvalidRequestError';
    stripeClient.refunds.create.mockRejectedValueOnce(rejection);
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow('Refund processing failed');
    expect(updatePayments).toHaveBeenCalledTimes(2);
    const clearedMeta = JSON.parse(updatePayments.mock.calls[1][0].metadata);
    expect(clearedMeta.pending_refund_key).toBeUndefined();
  });

  test('STALE marker (>20h): adopts the original refund from Stripe instead of replaying the key', async () => {
    // Stripe prunes idempotency keys after ≥24h — a blind replay would
    // execute as a NEW request and refund twice. The original $40 refund
    // is found on the PI and adopted: recorded + marker cleared, no
    // refunds.create call.
    paymentRow.refund_amount = '40.00';
    paymentRow.stripe_refund_id = 're_old';
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => ({
      data: [{ id: 're_old', status: 'succeeded', amount: 4000, created: Math.floor(Date.now() / 1000) - 30 * 3600 }],
    }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    expect(stripeClient.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_abc', limit: 100 });
    // re_old already recorded by the webhook — ledger stays at $40.
    const finalArgs = updatePayments.mock.calls[0][0];
    expect(finalArgs).toEqual(expect.objectContaining({ status: 'paid', refund_amount: 40 }));
    expect(JSON.parse(finalArgs.metadata).pending_refund_key).toBeUndefined();
  });

  test('STALE marker with NO matching refund at Stripe: starts a validated fresh attempt', async () => {
    // The day-old attempt never landed. It must be re-validated against
    // the CURRENT balance and re-persisted with a fresh timestamp.
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => ({ data: [] }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    expect(stripeClient.refunds.create).toHaveBeenCalledTimes(1);
    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(pendingMeta.pending_refund_key).toBe('refund_pay_pay-1_4000_0');
    expect(Date.parse(pendingMeta.pending_refund_at)).toBeGreaterThan(Date.now() - 60000);
  });

  test('STALE marker and the Stripe refund list is unreachable: fails CLOSED', async () => {
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => { throw new Error('api down'); });
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow(/Could not verify the earlier refund attempt/);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });
});
