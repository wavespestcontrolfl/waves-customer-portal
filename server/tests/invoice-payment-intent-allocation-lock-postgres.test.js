// Real PostgreSQL regression coverage for the invoice/PaymentIntent lock
// boundary. A shared PI is mutable as one allocation: staff settlement,
// checkout finalize and void must lock every stamped member in canonical id
// order before they cancel the provider session or mutate sibling stamps.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

postgres('invoice PaymentIntent allocation locking', () => {
  let database;
  let InvoiceService;
  let StripeService;
  let settleSucceededPaymentIntent;
  let stripeClient;
  let customerId;
  let invoiceIds;
  let piId;
  let previousPayIncludeBalanceGate;

  async function waitForBlockedBackend(blocker) {
    const { rows: [session] } = await blocker.raw('select pg_backend_pid() as pid');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await database.raw('select exists(select 1 from pg_stat_activity a where ? = any(pg_blocking_pids(a.pid))) as waiting', [session.pid]);
      if (result.rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('No competing allocation query waited for the blocker');
  }

  beforeAll(() => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ciTest) {
      throw new Error('Use a verified, task-private QA database or the isolated CI database');
    }
    // The setup regression drives the real service/transaction path with a
    // deterministic local Stripe double. No provider call can leave this test.
    stripeClient = {
      paymentIntents: {
        retrieve: jest.fn(),
        cancel: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config/stripe-config', () => ({
      secretKey: 'sk_test_local_allocation_lock',
      publishableKey: 'pk_test_local_allocation_lock',
    }));
    jest.doMock('../services/invoice-issued-closeout', () => ({
      ...jest.requireActual('../services/invoice-issued-closeout'),
      closeOutVisitForIssuedInvoice: jest.fn(),
      recordApprovedPaidCloseoutTarget: jest.fn(async () => {}),
    }));
    jest.doMock('../services/receipt-delivery-queue', () => ({
      ...jest.requireActual('../services/receipt-delivery-queue'),
      enqueueReceiptDelivery: jest.fn(), scheduleReceiptDeliveryDrain: jest.fn(),
    }));
    jest.doMock('../services/notification-triggers', () => ({
      ...jest.requireActual('../services/notification-triggers'), triggerNotification: jest.fn(),
    }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      ...jest.requireActual('../services/annual-prepay-renewals'), syncTermForInvoicePayment: jest.fn(),
    }));
    jest.doMock('../services/invoice-followups', () => ({
      ...jest.requireActual('../services/invoice-followups'), stopOnPayment: jest.fn(async () => {}),
    }));
    previousPayIncludeBalanceGate = process.env.GATE_PAY_INCLUDE_BALANCE;
    delete process.env.GATE_PAY_INCLUDE_BALANCE;
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    InvoiceService = require('../services/invoice');
    StripeService = require('../services/stripe');
    ({ _handlePaymentIntentSucceeded: settleSucceededPaymentIntent } = require('../routes/stripe-webhook'));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const fn of Object.values(stripeClient.paymentIntents)) fn.mockReset();
    customerId = randomUUID();
    invoiceIds = [randomUUID(), randomUUID()].sort();
    piId = `pi_lock_${randomUUID().replaceAll('-', '')}`;
    await database('customers').insert({
      id: customerId,
      first_name: 'Allocation',
      last_name: 'Lock',
      phone: '+12025550173',
      email: `${customerId}@example.invalid`,
    });
    await database('invoices').insert(invoiceIds.map((id, index) => ({
      id,
      customer_id: customerId,
      invoice_number: `TEST-ALLOC-${id.slice(0, 8)}`,
      token: randomUUID(),
      status: index ? 'sent' : 'viewed',
      subtotal: 100,
      total: 100,
      line_items: '[]',
      stripe_payment_intent_id: piId,
    })));
  });

  afterEach(async () => {
    await database('invoices').whereIn('id', invoiceIds || []).del().catch(() => {});
    if (customerId) await database('customers').where({ id: customerId }).del().catch(() => {});
  });

  afterAll(async () => {
    if (database) await database.destroy();
    await require('../models/db').destroy();
    if (previousPayIncludeBalanceGate == null) delete process.env.GATE_PAY_INCLUDE_BALANCE;
    else process.env.GATE_PAY_INCLUDE_BALANCE = previousPayIncludeBalanceGate;
  });

  test('waits on the first canonical sibling before locking the target row', async () => {
    const blocker = await database.transaction();
    let waiterFinished = false;
    try {
      await blocker('invoices').where({ id: invoiceIds[0] }).forUpdate().first('id');

      const waiter = database.transaction(async (trx) => {
        const locked = await InvoiceService.lockInvoicePaymentIntentAllocation(trx, {
          id: invoiceIds[1],
          piId,
          customerId,
          targetForUpdate: true,
        });
        waiterFinished = true;
        return locked;
      });
      await waitForBlockedBackend(blocker);
      expect(waiterFinished).toBe(false);

      // The allocation query is blocked on the lower-id sibling and has not
      // skipped ahead to lock the target. That is the property that prevents
      // target-vs-anchor AB/BA deadlocks during sibling-stamp cleanup.
      await database.transaction(async (probe) => {
        await probe.raw("SET LOCAL lock_timeout = '250ms'");
        await expect(probe('invoices').where({ id: invoiceIds[1] }).forUpdate().first('id'))
          .resolves.toMatchObject({ id: invoiceIds[1] });
      });

      await blocker.commit();
      await expect(waiter).resolves.toMatchObject({ id: invoiceIds[1] });
    } finally {
      await blocker.rollback().catch(() => {});
    }
  });

  test('failed saved-card recovery locks and clears a canceled sibling allocation after the target was parked', async () => {
    const targetId = invoiceIds[1];
    const siblingId = invoiceIds[0];
    const attemptId = randomUUID();
    const failedPiId = `pi_failed_${attemptId.replaceAll('-', '')}`;
    const idempotencyKey = `saved-card-${attemptId}`;
    const timedOutAt = new Date('2026-11-19T18:00:00.000Z');
    await database('customers').where({ id: customerId }).update({ account_credits: 15 });
    await database('invoices').where({ id: targetId }).update({
      stripe_payment_intent_id: null,
      credit_applied: 25,
    });
    await database('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: targetId,
      idempotency_key: idempotencyKey,
      status: 'ambiguous',
      stripe_payment_method_id: `pm_failed_${attemptId.replaceAll('-', '')}`,
      stripe_payment_intent_id: failedPiId,
      worker_payment_intent_id: null,
      worker_create_timed_out_at: timedOutAt,
      canceled_checkout_payment_intent_id: piId,
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: timedOutAt,
    });

    const blocker = await database.transaction();
    let outcome;
    try {
      await blocker('invoices').where({ id: siblingId }).forUpdate().first('id');
      outcome = StripeService.resolveFailedInvoiceSavedCardChargeAttempt({
        attemptId,
        invoiceId: targetId,
        customerId,
        stripePaymentIntentId: failedPiId,
        requestIdempotencyKey: idempotencyKey,
        failureMessage: 'simulated final saved-card failure',
        database,
      });
      await waitForBlockedBackend(blocker);

      // The union is locked in invoice-id order: while waiting on the lower
      // canceled-PI sibling, recovery has not skipped ahead to lock the target.
      await database.transaction(async (probe) => {
        await probe.raw("SET LOCAL lock_timeout = '250ms'");
        await expect(probe('invoices').where({ id: targetId }).forUpdate().first('id'))
          .resolves.toMatchObject({ id: targetId });
      });

      await blocker.commit();
      await expect(outcome).resolves.toBe(true);
      await expect(database('invoices').where({ id: siblingId }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: null });
      await expect(database('invoices').where({ id: targetId }).first('stripe_payment_intent_id', 'credit_applied'))
        .resolves.toMatchObject({ stripe_payment_intent_id: null, credit_applied: '0.00' });
      await expect(database('customers').where({ id: customerId }).first('account_credits'))
        .resolves.toMatchObject({ account_credits: '40.00' });
      await expect(database('customer_credit_ledger').where({ invoice_id: targetId }).pluck('delta'))
        .resolves.toEqual(['25.00']);
    } finally {
      await blocker.rollback().catch(() => {});
      if (outcome) await outcome.catch(() => {});
      await database('customer_credit_ledger').where({ invoice_id: targetId }).del().catch(() => {});
      await database('stripe_invoice_charge_attempts').where({ id: attemptId }).del().catch(() => {});
    }
  });

  test('authenticated success locks a restored canceled sibling before its higher-id parked target', async () => {
    const targetId = invoiceIds[1];
    const siblingId = invoiceIds[0];
    const attemptId = randomUUID();
    const succeededPiId = `pi_authenticated_${attemptId.replaceAll('-', '')}`;
    const paymentMethodId = `pm_authenticated_${attemptId.replaceAll('-', '')}`;
    await database('customers').where({ id: customerId }).update({ account_credits: 40 });
    await database('invoices').where({ id: targetId }).update({ stripe_payment_intent_id: null });
    await database('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: targetId,
      idempotency_key: `saved-card-auth-${attemptId}`,
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_method_id: paymentMethodId,
      canceled_checkout_payment_intent_id: piId,
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: new Date('2026-11-19T18:00:00.000Z'),
      resolved_at: new Date('2026-11-19T18:00:01.000Z'),
    });
    const intent = {
      id: succeededPiId,
      status: 'succeeded',
      amount: 7500,
      amount_received: 7500,
      payment_method: {
        id: paymentMethodId,
        type: 'card',
        card: { brand: 'visa', last4: '4242', funding: 'credit' },
      },
      payment_method_types: ['card'],
      metadata: {
        source: 'admin_card_on_file',
        saved_card_attempt_id: attemptId,
        waves_invoice_id: targetId,
        waves_customer_id: customerId,
        base_amount: '75',
        card_surcharge: '0',
        surcharge_policy_version: 'test',
      },
    };

    const blocker = await database.transaction();
    let outcome;
    try {
      await blocker('invoices').where({ id: siblingId }).forUpdate().first('id');
      outcome = settleSucceededPaymentIntent(intent);
      await waitForBlockedBackend(blocker);

      // Settlement is waiting on the lower-id canceled allocation member and
      // has not skipped ahead to lock the higher-id target.
      await database.transaction(async (probe) => {
        await probe.raw("SET LOCAL lock_timeout = '250ms'");
        await expect(probe('invoices').where({ id: targetId }).forUpdate().first('id'))
          .resolves.toMatchObject({ id: targetId });
      });

      await blocker.commit();
      await expect(outcome).resolves.toBeUndefined();
      await expect(database('invoices').where({ id: siblingId }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: null });
      await expect(database('invoices').where({ id: targetId }).first('status', 'stripe_payment_intent_id', 'credit_applied'))
        .resolves.toMatchObject({ status: 'paid', stripe_payment_intent_id: succeededPiId, credit_applied: '25.00' });
      await expect(database('customers').where({ id: customerId }).first('account_credits'))
        .resolves.toMatchObject({ account_credits: '15.00' });
    } finally {
      await blocker.rollback().catch(() => {});
      if (outcome) await outcome.catch(() => {});
      await database('customer_credit_ledger').where({ invoice_id: targetId }).del().catch(() => {});
      await database('payments').where({ stripe_payment_intent_id: succeededPiId }).del().catch(() => {});
      await database('stripe_orphan_charges').where({ stripe_payment_intent_id: succeededPiId }).del().catch(() => {});
      await database('stripe_invoice_charge_attempts').where({ id: attemptId }).del().catch(() => {});
    }
  });

  test('gate-off setup waits on a stale lower-id PI sibling before locking the target or canceling', async () => {
    const targetId = invoiceIds[1];
    const blocker = await database.transaction();
    stripeClient.paymentIntents.retrieve.mockResolvedValue({
      id: piId,
      status: 'requires_payment_method',
      amount: 20000,
      client_secret: `${piId}_secret`,
      metadata: {
        waves_invoice_id: targetId,
        combined_allocation: 'old-combined-allocation',
      },
    });
    stripeClient.paymentIntents.cancel.mockResolvedValue({ id: piId, status: 'canceled' });
    stripeClient.paymentIntents.create.mockResolvedValue({
      id: `${piId}_replacement`,
      status: 'requires_payment_method',
      client_secret: `${piId}_replacement_secret`,
    });
    try {
      await blocker('invoices').where({ id: invoiceIds[0] }).forUpdate().first('id');

      const setup = StripeService.createInvoicePaymentIntent(targetId, { includeOpenBalance: true });
      await waitForBlockedBackend(blocker);

      // Before the canonical setup lock, this request held the higher-id
      // target and had already canceled the old PI while waiting to clear the
      // lower sibling. It must now be blocked before both effects.
      expect(stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
      expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
      await database.transaction(async (probe) => {
        await probe.raw("SET LOCAL lock_timeout = '250ms'");
        await expect(probe('invoices').where({ id: targetId }).forUpdate().first('id'))
          .resolves.toMatchObject({ id: targetId });
      });

      await blocker.commit();
      await expect(setup).resolves.toMatchObject({
        paymentIntentId: `${piId}_replacement`,
      });
      expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith(piId);
      await expect(database('invoices').where({ id: invoiceIds[0] }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: null });
      await expect(database('invoices').where({ id: targetId }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: `${piId}_replacement` });
    } finally {
      await blocker.rollback().catch(() => {});
    }
  });

  test('saved-card charging waits for the entire existing checkout and refuses a replacement without contacting Stripe', async () => {
    const targetId = invoiceIds[1];
    const methodId = randomUUID();
    await database('payment_methods').insert({ id: methodId, customer_id: customerId, processor: 'stripe',
      method_type: 'card', stripe_payment_method_id: `pm_simulated_${methodId.replaceAll('-', '')}` });
    const client = jest.spyOn(StripeService, 'ensureStripeCustomer').mockResolvedValue('cus_simulated');
    const blocker = await database.transaction();
    let outcome;
    try {
      await blocker('invoices').where({ id: invoiceIds[0] }).forUpdate().first('id');
      outcome = StripeService.chargeInvoiceWithSavedCard(targetId, methodId).then(() => null, (err) => err);
      await waitForBlockedBackend(blocker);
      expect(stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
      expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
      await database.transaction(async (replacement) => {
        await replacement.raw("SET LOCAL lock_timeout = '500ms'");
        await replacement('invoices').where({ id: targetId }).update({ stripe_payment_intent_id: 'pi_replacement' });
      });
      await blocker.commit();
      await expect(outcome).resolves.toMatchObject({ statusCode: 409 });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
      expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
    } finally {
      await blocker.rollback().catch(() => {});
      await outcome;
      client.mockRestore();
      await database('stripe_invoice_charge_attempts').where({ invoice_id: targetId }).del();
      await database('payment_methods').where({ id: methodId }).del();
    }
  });

  test('a failed staff ledger transaction clears only the checkout already canceled at Stripe', async () => {
    const targetId = invoiceIds[1];
    stripeClient.paymentIntents.retrieve.mockResolvedValue({ id: piId, status: 'requires_payment_method', metadata: {} });
    stripeClient.paymentIntents.cancel.mockResolvedValue({ id: piId, status: 'canceled' });
    const completePlan = jest.spyOn(require('../services/payment-plans'), 'completeActivePlansForInvoice')
      .mockRejectedValueOnce(new Error('simulated late ledger write failure'));
    try {
      const { recordManualPayment } = require('../services/invoice-manual-payment');
      await expect(recordManualPayment(targetId, { method: 'cash', sendReceipt: false }))
        .rejects.toThrow('simulated late ledger write failure');
      expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledTimes(1);
      const invoices = await database('invoices').whereIn('id', invoiceIds).orderBy('id');
      expect(invoices.map((row) => row.stripe_payment_intent_id)).toEqual([null, null]);
      expect(invoices.map((row) => row.status)).toEqual(['viewed', 'sent']);
      expect(await database('payments').where({ customer_id: customerId })).toHaveLength(0);
    } finally {
      completePlan.mockRestore();
    }
  });

  test('a page void that waited and finds changed status rejects without canceling or clearing the PI', async () => {
    const targetId = invoiceIds[1];
    const blocker = await database.transaction();
    const retrieve = jest.spyOn(StripeService, 'retrievePaymentIntent').mockRejectedValue(new Error('Unexpected simulated Stripe retrieval'));
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockRejectedValue(new Error('Unexpected simulated Stripe cancellation'));
    try {
      await blocker('invoices').where({ id: targetId }).forUpdate().first('id');

      // The outer snapshot sees `sent`; the transaction then waits for this
      // row lock. Commit a status-only change while retaining the exact PI.
      const voidOutcome = InvoiceService.voidInvoice(targetId).then(() => null, (err) => err);
      await waitForBlockedBackend(blocker);
      await blocker('invoices').where({ id: targetId }).update({ status: 'viewed' });
      await blocker.commit();

      expect((await voidOutcome)?.message).toMatch(/status changed while voiding/i);
      expect(retrieve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      await expect(database('invoices').where({ id: targetId }).first('status', 'stripe_payment_intent_id'))
        .resolves.toMatchObject({ status: 'viewed', stripe_payment_intent_id: piId });
      await expect(database('invoices').where({ id: invoiceIds[0] }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: piId });
    } finally {
      retrieve.mockRestore();
      cancel.mockRestore();
      await blocker.rollback().catch(() => {});
    }
  });
});
