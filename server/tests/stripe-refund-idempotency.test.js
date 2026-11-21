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
  let mockGateForCharge;
  let mockSessionGate;
  let mockSettledCardRefundsLive;
  let mockUsesSettledCardRefundLedger;
  let mockVerifySettledCardCharge;
  let mockListPaymentRefunds;
  let mockReadSinglePaymentRefunds;
  let mockProjectSinglePaymentRefund;

  function loadService() {
     
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
    updatePayments = jest.fn(async (patch) => {
      Object.assign(paymentRow, patch);
      return 1;
    });
    mockGateForCharge = jest.fn(async () => []);
    mockSessionGate = jest.fn(async (_keys, fn) => fn());

    stripeClient = {
      refunds: {
        create: jest.fn(async (params) => ({
          id: 're_1',
          status: 'succeeded',
          amount: params.amount != null ? params.amount : Math.round(parseFloat(paymentRow.amount) * 100) - Math.round(parseFloat(paymentRow.refund_amount || 0) * 100),
          created: 1780000000,
          charge: params.charge,
          payment_intent: 'pi_abc',
          metadata: params.metadata || {},
        })),
      },
    };

    const paymentsQuery = {
      where: jest.fn(() => paymentsQuery),
      forUpdate: jest.fn(() => paymentsQuery),
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
    mockSettledCardRefundsLive = jest.fn(() => false);
    mockUsesSettledCardRefundLedger = jest.fn(async () => false);
    mockVerifySettledCardCharge = jest.fn(async () => ({
      id: 'ch_abc', payment_intent: 'pi_abc', paid: true, captured: true, status: 'succeeded',
      amount: 10000, amount_captured: 10000, amount_refunded: 0, refunded: false,
      payment_method_details: { type: 'card' },
    }));
    mockListPaymentRefunds = jest.fn(async () => new Map());
    mockReadSinglePaymentRefunds = jest.fn(async () => {
      const created = await Promise.all(stripeClient.refunds.create.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value));
      const refunds = new Map(created.map((refund) => [refund.id, refund]));
      const totalCents = created.filter((refund) => ['succeeded', 'pending', 'requires_action'].includes(refund.status))
        .reduce((sum, refund) => sum + refund.amount, 0);
      return {
        chargeId: 'ch_abc', paymentIntentId: 'pi_abc', refunds,
        activeIds: [...refunds.keys()], totalCents, capturedCents: 10000,
        chargeRefunded: totalCents === 10000,
      };
    });
    mockProjectSinglePaymentRefund = jest.fn((row, snapshot, refundId) => {
      const rowMeta = row.metadata ? JSON.parse(row.metadata) : {};
      const subject = snapshot.refunds.get(refundId);
      return {
        bounced: false,
        totalCents: snapshot.totalCents,
        isFull: snapshot.totalCents === 10000,
        latestRefundId: snapshot.activeIds[0],
        refundCents: subject.amount,
        metadata: { ...rowMeta, settled_card_refund_ledger: 1, stamped_refund_ids: [...snapshot.activeIds] },
      };
    });
    jest.doMock('../services/settled-card-refunds', () => ({
      settledCardRefundsLive: mockSettledCardRefundsLive,
      usesSettledCardRefundLedger: mockUsesSettledCardRefundLedger,
      verifySettledCardCharge: mockVerifySettledCardCharge,
      listPaymentRefunds: mockListPaymentRefunds,
      readSinglePaymentRefunds: mockReadSinglePaymentRefunds,
      projectSinglePaymentRefund: mockProjectSinglePaymentRefund,
      refundMetadata: (row) => {
        const value = row?.metadata;
        return value ? (typeof value === 'string' ? JSON.parse(value) : value) : {};
      },
      refundIds: (meta, key) => meta[key] || [],
    }));
    jest.doMock('../services/payment-lifecycle-email', () => ({
      sendRefundIssued: jest.fn(async () => undefined),
    }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      syncTermForRefundedPayment: jest.fn(async () => undefined),
      acquireTermiteGateForCharge: mockGateForCharge,
      withTermiteGateForCharge: mockSessionGate,
    }));
    jest.doMock('../services/customer-credit', () => ({
      returnAppliedCreditOnRefund: jest.fn(async () => undefined),
    }));
  });

  test('an invoice that was also paid in part by hand is not refunded here: the refund math assumes one payment covered the bill', async () => {
    paymentRow.metadata = JSON.stringify({ invoice_id: 'inv-1' });
    const lookups = [];
    const paymentsQuery = dbMock('payments');
    paymentsQuery.whereRaw = jest.fn((sql) => { lookups.push(sql); return paymentsQuery; });
    paymentsQuery.first = jest.fn(async () => (lookups.length ? { id: 'pay-part' } : paymentRow));
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 })).rejects.toThrow(/paid in part by hand/);
    expect(lookups.some((sql) => /partial_payment/.test(sql))).toBe(true);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    expect(updatePayments).not.toHaveBeenCalled();
  });

  test('partial refund persists the attempt key before Stripe and accumulates refund_amount', async () => {
    const StripeService = loadService();
    const result = await StripeService.refund('pay-1', { amount: 40 });

    // Response-only field: the gross THIS attempt issued, for caller
    // confirmation UIs — cumulative refund_amount can absorb a concurrent
    // refund that landed mid-request.
    expect(result.refund_issued_amount).toBe(40);

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ payment_intent: 'pi_abc', amount: 4000 }));
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');

    // First update = the pending-attempt persist, BEFORE the Stripe call.
    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(pendingMeta.pending_refund_key).toBe('refund_pay_pay-1_4000_0');
    expect(pendingMeta.pending_refund_request).toBe('4000');
    expect(pendingMeta.pending_refund_reason).toBe('requested_by_customer');

    // Final update records the refund and clears the pending marker.
    const finalArgs = updatePayments.mock.calls[1][0];
    expect(finalArgs).toEqual(expect.objectContaining({
      status: 'paid',
      refund_amount: 40,
      stripe_refund_id: 're_1',
    }));
    const finalMeta = JSON.parse(finalArgs.metadata);
    expect(finalMeta.pending_refund_key).toBeUndefined();
    // The refund is recorded as STAMPED so a later bounce stays attributable
    // even after a newer partial overwrites stripe_refund_id.
    expect(finalMeta.stamped_refund_ids).toEqual(['re_1']);
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

  test('replay with a CHANGED reason resends the original persisted reason (reused key = same params)', async () => {
    // Stripe rejects a reused idempotency key whose parameters differ, so
    // a retry that only edits the reason must replay the ORIGINAL one —
    // otherwise the safe-retry path wedges on an idempotency error until
    // the operator guesses the first attempt's reason.
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_reason: 'duplicate',
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40, reason: 'fraudulent' });

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');
    expect(params.reason).toBe('duplicate');
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
    // Codex #4971 r4 P1: the refunded stamp runs inside a transaction whose
    // FIRST lock is the renewal parent-decision gate (keyed off this
    // payment), so it can never land mid-way through a renewal charge's
    // re-check-then-submit window.
    expect(mockGateForCharge).toHaveBeenCalledWith(dbMock, { paymentIds: ['pay-1'] });
    // Codex #4971 r6 P1: the session gate is taken BEFORE the provider call.
    expect(mockSessionGate).toHaveBeenCalledWith({ paymentIds: ['pay-1'] }, expect.any(Function));
    expect(mockSessionGate.mock.invocationCallOrder[0]).toBeLessThan(stripeClient.refunds.create.mock.invocationCallOrder[0]);
    const stampCall = updatePayments.mock.calls.findIndex(([patch]) => patch.status === 'refunded');
    expect(mockGateForCharge.mock.invocationCallOrder[0])
      .toBeLessThan(updatePayments.mock.invocationCallOrder[stampCall]);
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
    delete paymentRow.metadata;
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

  test('STALE LEGACY marker on a surcharged payment: the fresh attempt is re-grossed, not the legacy base', async () => {
    // The replay path forces the legacy UNGROSSED amount (verbatim-key
    // rule), but once Stripe's list proves that attempt never landed, the
    // retry is a NEW attempt — it must send base + prorated surcharge and
    // derive a fresh key, or the customer is shorted the surcharge share.
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => ({ data: [] }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    // base 10000¢, surcharge 290¢ → $40 base grosses to 4000+round(4000×290/10000)=4116¢.
    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBe(4116);
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4116_0');
    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(pendingMeta.pending_refund_base).toBe('4000');
    expect(pendingMeta.pending_refund_gross).toBe(4116);
  });

  test('a replay that hands back an already-BOUNCED refund aborts and clears the marker (nothing stamped)', async () => {
    // The original attempt reached Stripe but its ledger write failed, so
    // the pending marker survived — then the refund bounced and
    // handleRefundFailed fenced re_1. The retry's key replay returns the
    // ORIGINAL bounced refund object; stamping it would record money Stripe
    // kept, and the bounce webhook would never rewind it (already fenced).
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date(Date.now() - 60 * 1000).toISOString(),
      failed_refund_ids: ['re_1'],
    });
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 40 }))
      .rejects.toThrow(/already bounced at the bank/);

    // Exactly one write: the marker clear. No refund_amount stamp, no
    // stamped_refund_ids entry, and the bounce fence survives.
    expect(updatePayments).toHaveBeenCalledTimes(1);
    const written = updatePayments.mock.calls[0][0];
    expect(written.refund_amount).toBeUndefined();
    const meta = JSON.parse(written.metadata);
    expect(meta.pending_refund_key).toBeUndefined();
    expect(meta.failed_refund_ids).toEqual(['re_1']);
    expect(meta.stamped_refund_ids).toBeUndefined();
  });

  test('the attempt AFTER a bounce derives a bounce-suffixed key and stamps the new refund', async () => {
    // Amounts were never stamped for the bounced attempt, so tag and
    // priorCents are unchanged — without the _b suffix the new attempt
    // would reuse the dead key and Stripe would replay the bounced refund.
    paymentRow.metadata = JSON.stringify({ failed_refund_ids: ['re_1'] });
    stripeClient.refunds.create = jest.fn(async (params) => ({
      id: 're_2', status: 'succeeded', amount: params.amount, created: 1780000100,
    }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    const [, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0_b1');
    const finalMeta = JSON.parse(updatePayments.mock.calls[1][0].metadata);
    expect(finalMeta.stamped_refund_ids).toEqual(['re_2']);
    // The fence record survives the wholesale metadata write.
    expect(finalMeta.failed_refund_ids).toEqual(['re_1']);
  });

  test("STALE 'rest' marker: a later dashboard PARTIAL is NOT adopted as the full refund", async () => {
    // The original full-remaining attempt never reached Stripe; someone
    // later issued a $25 dashboard partial. Adopting it would clear the
    // marker and report success while the true remainder was never sent —
    // a 'rest' attempt must only adopt a refund matching paid minus the
    // key's prior-cents (here $100 - $0).
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_rest_0',
      pending_refund_request: 'rest',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => ({
      data: [{ id: 're_partial', status: 'succeeded', amount: 2500, created: Math.floor(Date.now() / 1000) - 3600 }],
    }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', {});

    // Not adopted — restarted as a fresh 'rest' attempt (safe: Stripe
    // computes the remainder from its own ledger).
    expect(stripeClient.refunds.create).toHaveBeenCalledTimes(1);
    const [params] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBeUndefined();
    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(Date.parse(pendingMeta.pending_refund_at)).toBeGreaterThan(Date.now() - 60000);
  });

  test("STALE 'rest' marker: adopts the refund matching the attempt-time remainder", async () => {
    // 'rest' attempt when $40 was already refunded (key suffix 4000) —
    // the landed $60 refund is adopted; the unrelated $10 one is not.
    paymentRow.refund_amount = '40.00';
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_rest_4000',
      pending_refund_request: 'rest',
      pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    stripeClient.refunds.list = jest.fn(async () => ({
      data: [
        { id: 're_other', status: 'succeeded', amount: 1000, created: Math.floor(Date.now() / 1000) - 3600 },
        { id: 're_rest', status: 'succeeded', amount: 6000, created: Math.floor(Date.now() / 1000) - 29 * 3600 },
      ],
    }));
    const StripeService = loadService();
    await StripeService.refund('pay-1', {});

    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    const finalArgs = updatePayments.mock.calls[0][0];
    expect(finalArgs).toEqual(expect.objectContaining({ status: 'refunded', refund_amount: 100, stripe_refund_id: 're_rest' }));
    expect(JSON.parse(finalArgs.metadata).pending_refund_key).toBeUndefined();
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

  // ── Prorated surcharge gross-up (card-brand rule) ─────────────────────
  // The operator enters BASE dollars; the Stripe refund adds the prorated
  // share of the recorded card_surcharge via computeRefundSurcharge (the one
  // surcharge authority), tracked cumulatively in metadata so successive
  // partials sum to the exact surcharge with no drift.

  test('partial refund on a surcharged payment grosses up by the prorated share', async () => {
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 50 });

    // base 10000¢, surcharge 290¢ → $50 base refunds round(5000×290/10000)=145¢ share.
    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBe(5145);
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_5145_0');

    const pendingMeta = JSON.parse(updatePayments.mock.calls[0][0].metadata);
    expect(pendingMeta.pending_refund_base).toBe('5000');
    expect(pendingMeta.pending_refund_gross).toBe(5145);

    const finalArgs = updatePayments.mock.calls[1][0];
    expect(finalArgs.refund_amount).toBe(51.45);
    expect(finalArgs.refunded_surcharge_cents).toBe(145);
  });

  test('second partial completes the surcharge exactly and flips to refunded', async () => {
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.refund_amount = '51.45';
    paymentRow.refunded_surcharge_cents = 145;
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 50 });

    // Remaining surcharge = 290−145 = 145¢ → 5000+145; series totals 10290¢ = paid.
    expect(stripeClient.refunds.create.mock.calls[0][0].amount).toBe(5145);
    const finalArgs = updatePayments.mock.calls[1][0];
    expect(finalArgs.status).toBe('refunded');
    expect(finalArgs.refund_amount).toBe(102.9);
    expect(finalArgs.refunded_surcharge_cents).toBe(290);
  });

  test('a NEW attempt beyond the remaining BASE is rejected (stale-client fence)', async () => {
    // A prior $60 refund recorded with no surcharge tracking (legacy):
    // remaining gross = 4290¢ but remaining BASE = 4290−290 = 4000¢. A $42
    // base entry (e.g. from a stale modal that missed the prior refund)
    // must be rejected — the old gross ceiling accepted it and silently
    // capped the grossed amount to 4290¢, refunding more than the operator
    // confirmed.
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.refund_amount = '60.00';
    const StripeService = loadService();
    await expect(StripeService.refund('pay-1', { amount: 42 }))
      .rejects.toThrow(/between \$0\.01 and the remaining \$40\.00/);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  test('degenerate ledger (base consumed, share outstanding) keeps the gross ceiling and the cap holds', async () => {
    // Base fully refunded but the surcharge share never returned: remaining
    // base is 0, so the fallback ceiling is the gross remainder (290¢) —
    // and the gross-up cap keeps the issued amount at exactly that.
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.refund_amount = '100.00';
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 2.90 });

    expect(stripeClient.refunds.create.mock.calls[0][0].amount).toBe(290);
  });

  test('LEGACY marker replay on a surcharged payment resends the ORIGINAL ungrossed amount', async () => {
    // A pending marker written before the gross-up shipped has no
    // pending_refund_gross — its original Stripe request was the entered
    // amount exactly. Recomputing a grossed amount against the stored key
    // would hit Stripe's changed-params idempotency rejection, clear the
    // marker, and open a double-refund window.
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_4000_0',
      pending_refund_request: '4000',
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    await StripeService.refund('pay-1', { amount: 40 });

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBe(4000);
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_4000_0');
  });

  test('replay of a grossed attempt matches on the ENTERED base and resends the stored gross', async () => {
    paymentRow.amount = '102.90';
    paymentRow.surcharge_amount_cents = 290;
    paymentRow.metadata = JSON.stringify({
      pending_refund_key: 'refund_pay_pay-1_5145_0',
      pending_refund_request: '5145',
      pending_refund_base: '5000',
      pending_refund_gross: 5145,
      pending_refund_at: new Date().toISOString(),
    });
    const StripeService = loadService();
    // Operator retries by re-entering the same $50 they typed the first time.
    await StripeService.refund('pay-1', { amount: 50 });

    const [params, opts] = stripeClient.refunds.create.mock.calls[0];
    expect(params.amount).toBe(5145);
    expect(opts.idempotencyKey).toBe('refund_pay_pay-1_5145_0');
    // No pending re-persist — the only update is the final record+clear.
    expect(updatePayments).toHaveBeenCalledTimes(1);
  });

  describe('settled-card exact refund ledger', () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';

    function eligibleCard() {
      paymentRow.stripe_charge_id = 'ch_abc';
      paymentRow.payment_method_type = 'card';
      mockSettledCardRefundsLive.mockReturnValue(true);
      mockUsesSettledCardRefundLedger.mockResolvedValue(true);
    }

    function pendingAttempt(overrides = {}) {
      return {
        settled_card_refund_ledger: 1,
        pending_refund_key: 'refund_pay_pay-1_4000_0',
        pending_refund_version: 1,
        pending_refund_id: attemptId,
        pending_refund_charge_id: 'ch_abc',
        pending_refund_request: '4000',
        pending_refund_base: '4000',
        pending_refund_gross: 4000,
        pending_refund_reason: 'requested_by_customer',
        pending_refund_at: new Date().toISOString(),
        ...overrides,
      };
    }

    test('new eligible refund verifies and freezes the original charge before creating money', async () => {
      eligibleCard();

      await loadService().refund('pay-1', { amount: 40 });

      expect(mockVerifySettledCardCharge).toHaveBeenCalledWith(stripeClient, {
        chargeId: 'ch_abc', paymentIntentId: 'pi_abc', expectedAmountCents: 10000,
      });
      const [params, options] = stripeClient.refunds.create.mock.calls[0];
      expect(params).toEqual(expect.objectContaining({ charge: 'ch_abc', amount: 4000 }));
      expect(params.payment_intent).toBeUndefined();
      expect(params.metadata).toEqual({
        waves_admin_refund_version: '1',
        waves_admin_refund_attempt: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(options.idempotencyKey).toBe(`refund_card_${params.metadata.waves_admin_refund_attempt}`);
      expect(mockVerifySettledCardCharge.mock.invocationCallOrder[0])
        .toBeLessThan(stripeClient.refunds.create.mock.invocationCallOrder[0]);
      const claim = JSON.parse(updatePayments.mock.calls[0][0].metadata);
      expect(claim).toEqual(expect.objectContaining({
        settled_card_refund_ledger: 1,
        pending_refund_version: 1,
        pending_refund_charge_id: 'ch_abc',
        pending_refund_provider_key: options.idempotencyKey,
      }));
      const stamped = JSON.parse(updatePayments.mock.calls[1][0].metadata);
      expect(stamped.settled_card_refund_ledger).toBe(1);
      expect(stamped.pending_refund_key).toBeUndefined();
      expect(stamped.pending_refund_provider_key).toBeUndefined();
      expect(mockUsesSettledCardRefundLedger).toHaveBeenCalledTimes(3);
    });

    test('a new attempt after a definitive rejection uses a fresh Stripe key at the same balance', async () => {
      eligibleCard();
      const rejection = Object.assign(new Error('issuer declined the refund'), { type: 'StripeCardError' });
      stripeClient.refunds.create.mockRejectedValue(rejection);
      const service = loadService();
      await expect(service.refund('pay-1', { amount: 40 })).rejects.toThrow('Refund processing failed');
      await expect(service.refund('pay-1', { amount: 40 })).rejects.toThrow('Refund processing failed');

      const keys = stripeClient.refunds.create.mock.calls.map(([params, options]) => {
        expect(options.idempotencyKey).toBe(`refund_card_${params.metadata.waves_admin_refund_attempt}`);
        return options.idempotencyKey;
      });
      expect(new Set(keys).size).toBe(2);
    });

    test('a late rejection from the previous UUID preserves the new attempt at the same balance', async () => {
      eligibleCard();
      stripeClient.refunds.create.mockImplementationOnce(async () => {
        const claim = JSON.parse(paymentRow.metadata);
        paymentRow.metadata = JSON.stringify({
          ...claim,
          pending_refund_id: attemptId,
          pending_refund_provider_key: `refund_card_${attemptId}`,
        });
        throw Object.assign(new Error('issuer declined the refund'), { type: 'StripeCardError' });
      });
      await expect(loadService().refund('pay-1', { amount: 40 })).rejects.toThrow('Refund processing failed');

      expect(JSON.parse(paymentRow.metadata)).toMatchObject({
        pending_refund_id: attemptId,
        pending_refund_key: 'refund_pay_pay-1_4000_0',
        pending_refund_provider_key: `refund_card_${attemptId}`,
      });
    });

    test('durable enrollment continues an exact replay after the live gate turns off', async () => {
      eligibleCard();
      mockSettledCardRefundsLive.mockReturnValue(false);
      paymentRow.metadata = JSON.stringify(pendingAttempt());

      await loadService().refund('pay-1', { amount: 40 });

      expect(mockVerifySettledCardCharge).not.toHaveBeenCalled();
      const [params, options] = stripeClient.refunds.create.mock.calls[0];
      expect(params).toEqual(expect.objectContaining({
        charge: 'ch_abc',
        metadata: {
          waves_admin_refund_version: '1',
          waves_admin_refund_attempt: attemptId,
        },
      }));
      expect(options.idempotencyKey).toBe('refund_pay_pay-1_4000_0');
    });

    test('gate-on but ineligible payment keeps the legacy PI parameters and metadata', async () => {
      mockSettledCardRefundsLive.mockReturnValue(true);
      mockUsesSettledCardRefundLedger.mockResolvedValue(false);

      await loadService().refund('pay-1', { amount: 40 });

      const [params] = stripeClient.refunds.create.mock.calls[0];
      expect(params).toEqual(expect.objectContaining({ payment_intent: 'pi_abc', amount: 4000 }));
      expect(params.charge).toBeUndefined();
      expect(params.metadata).toBeUndefined();
      expect(JSON.parse(updatePayments.mock.calls[0][0].metadata).settled_card_refund_ledger).toBeUndefined();
      expect(mockReadSinglePaymentRefunds).not.toHaveBeenCalled();
    });

    test('aged enrolled attempt adopts only its exact tagged refund from the original charge', async () => {
      eligibleCard();
      paymentRow.metadata = JSON.stringify(pendingAttempt({
        pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      }));
      const refund = {
        id: 're_exact', status: 'succeeded', amount: 4000, charge: 'ch_abc', payment_intent: 'pi_abc',
        metadata: { waves_admin_refund_version: '1', waves_admin_refund_attempt: attemptId },
      };
      const refunds = new Map([[refund.id, refund]]);
      mockListPaymentRefunds.mockResolvedValue(refunds);
      mockReadSinglePaymentRefunds.mockResolvedValue({
        chargeId: 'ch_abc', paymentIntentId: 'pi_abc', refunds,
        activeIds: ['re_exact'], totalCents: 4000, capturedCents: 10000, chargeRefunded: false,
      });

      await loadService().refund('pay-1', { amount: 40 });

      expect(mockListPaymentRefunds).toHaveBeenCalledWith(stripeClient, { charge: 'ch_abc' });
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
      expect(updatePayments).toHaveBeenLastCalledWith(expect.objectContaining({
        refund_amount: 40, stripe_refund_id: 're_exact',
      }));
    });

    test('aged enrolled attempt with no exact identity fails closed before new money', async () => {
      eligibleCard();
      paymentRow.metadata = JSON.stringify(pendingAttempt({
        pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      }));

      await expect(loadService().refund('pay-1', { amount: 40 }))
        .rejects.toThrow(/no exact supported Stripe refund identifier/i);
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
      expect(JSON.parse(paymentRow.metadata).pending_refund_id).toBe(attemptId);
    });

    test('an expired UUID cannot adopt the last recorded refund for another attempt at the same balance', async () => {
      eligibleCard();
      const lastRefund = { id: 're_earlier', amount: 4000, charge: 'ch_abc', payment_intent: 'pi_abc' };
      paymentRow.metadata = JSON.stringify(pendingAttempt({
        pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
        last_admin_refund: {
          key: 'refund_pay_pay-1_4000_0', attempt_id: '22222222-2222-4222-8222-222222222222',
          id: lastRefund.id, amount_cents: lastRefund.amount,
        },
      }));
      mockListPaymentRefunds.mockResolvedValue(new Map([[lastRefund.id, lastRefund]]));

      await expect(loadService().refund('pay-1', { amount: 40 })).rejects.toThrow(/no exact supported Stripe refund identifier/i);
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
      expect(JSON.parse(paymentRow.metadata).pending_refund_id).toBe(attemptId);
    });

    test('a recent pre-UUID attempt is read-only and cannot issue a new refund', async () => {
      eligibleCard();
      paymentRow.metadata = JSON.stringify({
        settled_card_refund_ledger: 1,
        pending_refund_key: 'refund_pay_pay-1_4000_0',
        pending_refund_request: '4000',
        pending_refund_base: '4000',
        pending_refund_gross: 4000,
        pending_refund_reason: 'requested_by_customer',
        pending_refund_at: new Date().toISOString(),
      });

      await expect(loadService().refund('pay-1', { amount: 40 }))
        .rejects.toThrow(/no exact supported Stripe refund identifier/i);
      expect(mockListPaymentRefunds).toHaveBeenCalledWith(stripeClient, { charge: 'ch_abc' });
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    });

    test('a tagged refund from a different charge is never adopted', async () => {
      eligibleCard();
      paymentRow.metadata = JSON.stringify(pendingAttempt({
        pending_refund_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      }));
      mockListPaymentRefunds.mockResolvedValue(new Map([['re_wrong', {
        id: 're_wrong', status: 'succeeded', amount: 4000,
        charge: 'ch_other', payment_intent: 'pi_abc',
        metadata: { waves_admin_refund_version: '1', waves_admin_refund_attempt: attemptId },
      }]]));

      await expect(loadService().refund('pay-1', { amount: 40 }))
        .rejects.toThrow(/does not belong to the original charge/i);
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
      expect(updatePayments).not.toHaveBeenCalled();
    });

    test('the locked charge and PI must still exactly match the verified read', async () => {
      eligibleCard();
      mockVerifySettledCardCharge.mockImplementationOnce(async () => {
        paymentRow.stripe_payment_intent_id = 'pi_changed';
        return {
          id: 'ch_abc', payment_intent: 'pi_abc', paid: true, captured: true, status: 'succeeded',
          amount: 10000, amount_captured: 10000,
          payment_method_details: { type: 'card' },
        };
      });

      await expect(loadService().refund('pay-1', { amount: 40 }))
        .rejects.toThrow(/payment changed while the refund was starting/i);
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    });

    test('a provider response with different attempt metadata stays pending for reconciliation', async () => {
      eligibleCard();
      stripeClient.refunds.create.mockImplementationOnce(async (params) => ({
        id: 're_mismatch', status: 'succeeded', amount: params.amount,
        charge: params.charge, payment_intent: 'pi_abc',
        metadata: { ...params.metadata, waves_admin_refund_attempt: '22222222-2222-4222-8222-222222222222' },
      }));

      await expect(loadService().refund('pay-1', { amount: 40 }))
        .rejects.toThrow(/exact attempt metadata or charge did not match/i);
      expect(updatePayments).toHaveBeenCalledTimes(1);
      expect(JSON.parse(paymentRow.metadata).pending_refund_key).toBe('refund_pay_pay-1_4000_0');
      expect(mockReadSinglePaymentRefunds).not.toHaveBeenCalled();
    });

    test('a rest attempt freezes its remaining surcharge if another refund bounces first', async () => {
      eligibleCard();
      paymentRow.amount = '102.90';
      paymentRow.refund_amount = '51.45';
      paymentRow.surcharge_amount_cents = 290;
      paymentRow.refunded_surcharge_cents = 145;
      mockVerifySettledCardCharge.mockResolvedValueOnce({
        id: 'ch_abc', payment_intent: 'pi_abc', paid: true, captured: true, status: 'succeeded',
        amount: 10290, amount_captured: 10290,
        payment_method_details: { type: 'card' },
      });
      mockReadSinglePaymentRefunds.mockImplementationOnce(async () => {
        const refund = await stripeClient.refunds.create.mock.results[0].value;
        // The earlier 5145-cent refund bounced after this amount-omitted
        // request was accepted, leaving this refund as a partial by itself.
        paymentRow.refund_amount = null;
        paymentRow.refunded_surcharge_cents = 0;
        const refunds = new Map([[refund.id, refund]]);
        return {
          chargeId: 'ch_abc', paymentIntentId: 'pi_abc', refunds,
          activeIds: [refund.id], totalCents: 5145, capturedCents: 10290, chargeRefunded: false,
        };
      });
      mockProjectSinglePaymentRefund.mockImplementationOnce((row, snapshot, refundId) => ({
        bounced: false,
        totalCents: snapshot.totalCents,
        isFull: false,
        latestRefundId: refundId,
        refundCents: snapshot.refunds.get(refundId).amount,
        metadata: {
          ...JSON.parse(row.metadata),
          settled_card_refund_ledger: 1,
          stamped_refund_ids: [refundId],
        },
      }));

      await loadService().refund('pay-1');

      expect(stripeClient.refunds.create.mock.calls[0][0].amount).toBeUndefined();
      expect(JSON.parse(updatePayments.mock.calls[0][0].metadata).pending_refund_surcharge_cents).toBe(145);
      expect(updatePayments).toHaveBeenLastCalledWith(expect.objectContaining({
        refund_amount: 51.45,
        refunded_surcharge_cents: 145,
      }));
    });

    test('the settled stamp does not add surcharge twice when its webhook stamped first', async () => {
      eligibleCard();
      paymentRow.amount = '102.90';
      paymentRow.surcharge_amount_cents = 290;
      mockVerifySettledCardCharge.mockResolvedValueOnce({
        id: 'ch_abc', payment_intent: 'pi_abc', paid: true, captured: true, status: 'succeeded',
        amount: 10290, amount_captured: 10290,
        payment_method_details: { type: 'card' },
      });
      mockReadSinglePaymentRefunds.mockImplementationOnce(async () => {
        const refund = await stripeClient.refunds.create.mock.results[0].value;
        const pending = JSON.parse(paymentRow.metadata);
        paymentRow.refund_amount = '51.45';
        paymentRow.refunded_surcharge_cents = 145;
        paymentRow.stripe_refund_id = refund.id;
        paymentRow.metadata = JSON.stringify({ ...pending, stamped_refund_ids: [refund.id] });
        const refunds = new Map([[refund.id, refund]]);
        return {
          chargeId: 'ch_abc', paymentIntentId: 'pi_abc', refunds,
          activeIds: [refund.id], totalCents: 5145, capturedCents: 10290, chargeRefunded: false,
        };
      });
      mockProjectSinglePaymentRefund.mockImplementationOnce((row, snapshot, refundId) => ({
        bounced: false,
        totalCents: snapshot.totalCents,
        isFull: false,
        latestRefundId: refundId,
        refundCents: snapshot.refunds.get(refundId).amount,
        metadata: { ...JSON.parse(row.metadata), settled_card_refund_ledger: 1 },
      }));

      await loadService().refund('pay-1', { amount: 50 });

      expect(updatePayments).toHaveBeenLastCalledWith(expect.objectContaining({
        refund_amount: 51.45,
        refunded_surcharge_cents: 145,
      }));
    });

    test('same concurrent amount joins the locked claim; a different amount fails before Stripe', async () => {
      eligibleCard();
      const concurrent = pendingAttempt();
      mockVerifySettledCardCharge.mockImplementationOnce(async () => {
        paymentRow.metadata = JSON.stringify(concurrent);
        return { id: 'ch_abc' };
      });

      await loadService().refund('pay-1', { amount: 40 });
      expect(stripeClient.refunds.create.mock.calls[0][0]).toEqual(expect.objectContaining({
        charge: 'ch_abc', metadata: expect.objectContaining({ waves_admin_refund_attempt: attemptId }),
      }));

      jest.resetModules();
      updatePayments.mockClear();
      stripeClient.refunds.create.mockClear();
      paymentRow.metadata = JSON.stringify(pendingAttempt({
        pending_refund_key: 'refund_pay_pay-1_2500_0',
        pending_refund_request: '2500', pending_refund_base: '2500', pending_refund_gross: 2500,
      }));
      await expect(loadService().refund('pay-1', { amount: 40 })).rejects.toThrow(/unresolved refund attempt/i);
      expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    });
  });

  // B03: the annual-prepay claw-back must read the invoice AFTER the
  // credit-restore block terminalized it to 'refunded' under its row lock —
  // a refunded invoice is refused by every replacement-settlement path, so a
  // replacement payment cannot take ownership between the sync's ownership
  // read and the term cancel.
  describe('full-refund ordering: credit restore, then prepay claw-back', () => {
    let order;
    let invoiceRow;
    let statusSeenBySync;
    let creditMock;
    let syncMock;

    // The invoices lookup the credit-restore block runs (by the payment's PI).
    function stubInvoiceLookup(row) {
      const original = dbMock.getMockImplementation();
      const invoicesQuery = { where: jest.fn(() => invoicesQuery), first: jest.fn(async () => row) };
      dbMock.mockImplementation((table) => (table === 'invoices' ? invoicesQuery : original(table)));
      return invoicesQuery;
    }

    function loadWithRecorders() {
      const StripeService = loadService();
      creditMock = require('../services/customer-credit').returnAppliedCreditOnRefund;
      syncMock = require('../services/annual-prepay-renewals').syncTermForRefundedPayment;
      return StripeService;
    }

    beforeEach(() => {
      order = [];
      invoiceRow = { id: 'inv-1', status: 'paid' };
      statusSeenBySync = null;
    });

    function recordOrder() {
      creditMock.mockImplementation(async () => {
        order.push('credit');
        invoiceRow.status = 'refunded'; // what the real helper does under the row lock
      });
      syncMock.mockImplementation(async () => {
        order.push('sync');
        statusSeenBySync = invoiceRow.status;
      });
    }

    test('an owned invoice is terminalized by the credit restore BEFORE the term sync reads it', async () => {
      const invoicesQuery = stubInvoiceLookup(invoiceRow);
      const StripeService = loadWithRecorders();
      recordOrder();

      await StripeService.refund('pay-1', {});

      expect(invoicesQuery.where).toHaveBeenCalledWith({ stripe_payment_intent_id: 'pi_abc' });
      expect(order).toEqual(['credit', 'sync']);
      expect(statusSeenBySync).toBe('refunded');
      expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'pay-1', stripe_payment_intent_id: 'pi_abc' }));
    });

    test('no invoice owned by this PI (credit restore does not apply): the sync still runs, as before', async () => {
      stubInvoiceLookup(null);
      const StripeService = loadWithRecorders();
      recordOrder();

      await StripeService.refund('pay-1', {});

      expect(creditMock).not.toHaveBeenCalled();
      expect(order).toEqual(['sync']);
    });

    test('a credit restore that throws is logged and never skips the claw-back', async () => {
      stubInvoiceLookup(invoiceRow);
      const StripeService = loadWithRecorders();
      recordOrder();
      creditMock.mockImplementation(async () => { order.push('credit'); throw new Error('lock timeout'); });

      const result = await StripeService.refund('pay-1', {});

      expect(order).toEqual(['credit', 'sync']);
      // The refund itself still reports success.
      expect(result.refund_issued_amount).toBe(100);
    });

    test('a sync that throws never masks the refund or undoes the credit restore', async () => {
      stubInvoiceLookup(invoiceRow);
      const StripeService = loadWithRecorders();
      recordOrder();
      syncMock.mockImplementation(async () => { order.push('sync'); throw new Error('prepay sync down'); });

      const result = await StripeService.refund('pay-1', {});

      expect(order).toEqual(['credit', 'sync']);
      expect(invoiceRow.status).toBe('refunded');
      expect(result.refund_issued_amount).toBe(100);
    });

    test('a PARTIAL refund runs neither the credit restore nor the claw-back', async () => {
      stubInvoiceLookup(invoiceRow);
      const StripeService = loadWithRecorders();
      recordOrder();

      await StripeService.refund('pay-1', { amount: 40 });

      expect(order).toEqual([]);
      expect(invoiceRow.status).toBe('paid');
    });
  });
});
