// InvoiceService.voidInvoice's `requireUnsettled` precondition (Codex
// round-3 audit P0) against REAL PostgreSQL. The termite-annual-renewal
// grace lapse's OWN eligibility re-check (resolveLapseVoidEligibility)
// commits and releases its row lock BEFORE the actual void call — a
// settlement (account credit, an ACH clearing, a card payment) landing in
// that exact gap used to void a now-settled invoice, restore its credit,
// and raise a station retrieval task for a renewal the customer actually
// paid. `requireUnsettled: true` re-verifies "genuinely still unpaid, no
// reconciliation pending" a SECOND time, under THIS invoice row's own
// lock, at the actual chokepoint where the void itself commits — closing
// the race no earlier, separately-committing check can.
//
// Self-skips without REPAIR_TEST_DATABASE_URL set to a local disposable
// database, e.g.:
//   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
//     ../node_modules/.bin/jest --runInBand --coverage=false invoice-void-unsettled-chokepoint-postgres.test.js
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.setTimeout(30000);

postgres('voidInvoice({ requireUnsettled: true }) — real Postgres chokepoint', () => {
  let db;
  let InvoiceService;
  const customerIds = [];

  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(() => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('This test requires a local disposable database');
    }
    // `../models/db` (the module-level handle every service under test —
    // InvoiceService, annual-prepay-renewals, stripe's reconciliation
    // guard — actually uses) reads DATABASE_URL at require time. Bridge
    // this lane's own REPAIR_TEST_DATABASE_URL convention onto it, same
    // pattern as annual-prepay-parent-decision-lock-postgres.test.js.
    process.env.DATABASE_URL = process.env.REPAIR_TEST_DATABASE_URL;
    db = require('../models/db');
    InvoiceService = require('../services/invoice');
  });

  afterEach(async () => {
    // ON DELETE CASCADE from customers -> invoices/annual_prepay_terms.
    if (customerIds.length) {
      await db('customers').whereIn('id', customerIds).del();
      customerIds.length = 0;
    }
  });

  afterAll(async () => {
    await db?.destroy();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  async function insertInvoice(overrides = {}) {
    const customerId = randomUUID();
    customerIds.push(customerId);
    await db('customers').insert({
      id: customerId,
      first_name: 'Chokepoint Test',
      phone: `+1555${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`,
    });
    const invoiceId = randomUUID();
    await db('invoices').insert({
      id: invoiceId,
      token: randomUUID(),
      invoice_number: `WPC-TEST-${invoiceId.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Termite Annual Renewal',
      line_items: JSON.stringify([]),
      subtotal: 249,
      tax_rate: 0,
      tax_amount: 0,
      total: 249,
      status: 'sent',
      credit_applied: 0,
      ...overrides,
    });
    return { customerId, invoiceId };
  }

  test('a genuinely unpaid, collectible invoice voids normally under requireUnsettled', async () => {
    const { invoiceId } = await insertInvoice({ status: 'sent' });
    const result = await InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true });
    expect(result.status).toBe('void');
    const fresh = await db('invoices').where({ id: invoiceId }).first('status');
    expect(fresh.status).toBe('void');
  });

  // The exact race: the eligibility re-check would have seen this invoice
  // as still open — THEN, in the gap before the void call, account credit
  // settles it (status -> prepaid, credit_applied > 0). Modeled here as
  // the invoice already reading that settled state by the time
  // voidInvoice itself runs — the precise state the race produces,
  // regardless of the exact timing that got it there.
  test('credit-settled (prepaid, credit_applied > 0) between the eligibility check and the void: REFUSED, credit untouched, never voided', async () => {
    const { invoiceId } = await insertInvoice({ status: 'prepaid', credit_applied: 249, prepaid_at: new Date() });
    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true }))
      .rejects.toMatchObject({ code: 'INVOICE_SETTLED_REFUSE_VOID' });
    const fresh = await db('invoices').where({ id: invoiceId }).first('status', 'credit_applied');
    // Never voided, and the credit this refusal is protecting was never
    // touched (no restore ran, because the whole transaction never
    // committed the throwing branch's own write).
    expect(fresh.status).toBe('prepaid');
    expect(Number(fresh.credit_applied)).toBe(249);
  });

  // Codex #4971 round-4 (post-merge audit) P1: a PARTIAL credit application
  // (customer-credit.js's auto-apply, or a partial admin apply) leaves the
  // invoice's own status untouched (never 'prepaid') because the balance is
  // NOT fully covered — $10 applied to a $249 invoice still leaves $239
  // due. This is durable (won't clear on its own like an in-flight charge)
  // but it is genuinely NOT settlement either, so it must get its OWN typed
  // code — never silently classified as either "settled, retire" or
  // "unsettled, void normally".
  test('partial credit applied (some, not fully covering the total): its OWN typed refusal, never treated as settled', async () => {
    const { invoiceId } = await insertInvoice({ status: 'sent', credit_applied: 10 });
    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true }))
      .rejects.toMatchObject({ code: 'INVOICE_PARTIAL_CREDIT_REFUSE_VOID' });
    const fresh = await db('invoices').where({ id: invoiceId }).first('status', 'credit_applied');
    expect(fresh.status).toBe('sent');
    expect(Number(fresh.credit_applied)).toBe(10);
  });

  // 'paid' and 'processing' are ALREADY refused unconditionally by
  // assertInvoiceVoidable's own pre-existing transition matrix (an
  // un-typed error, checked before requireUnsettled's own code ever
  // runs, for EVERY caller) — there is no gap to close there. The gap is
  // specifically 'prepaid': assertInvoiceVoidable deliberately ALLOWS it
  // through (an operator's legitimate un-prepay), so it is the ONE status
  // that reaches requireUnsettled's own check at all. Pinning that these
  // two statuses stay blocked (by whichever layer) protects against a
  // regression in the existing guard without duplicating its own
  // ownership of the assertion.
  test('a fully paid (paid_at set) invoice: still refused (by the pre-existing guard), never voided', async () => {
    const { invoiceId } = await insertInvoice({ status: 'paid', paid_at: new Date() });
    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true })).rejects.toThrow();
    const fresh = await db('invoices').where({ id: invoiceId }).first('status');
    expect(fresh.status).toBe('paid');
  });

  test('an ACH payment still "processing": still refused (by the pre-existing guard), never voided', async () => {
    const { invoiceId } = await insertInvoice({ status: 'processing' });
    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true })).rejects.toThrow();
    const fresh = await db('invoices').where({ id: invoiceId }).first('status');
    expect(fresh.status).toBe('processing');
  });

  // A claimed-but-unresolved Stripe charge attempt on an otherwise-open
  // invoice — assertNoInvoiceChargeReconciliationPending's own guard, now
  // folded into voidInvoice's SAME locked transaction.
  test('a pending Stripe charge reconciliation on an otherwise-open invoice: REFUSED, never voided', async () => {
    const { invoiceId } = await insertInvoice({ status: 'sent' });
    await db('stripe_invoice_charge_attempts').insert({
      id: randomUUID(),
      invoice_id: invoiceId,
      stripe_payment_method_id: 'pm_test_chokepoint',
      status: 'claimed',
      idempotency_key: randomUUID(),
      submitted_at: new Date(),
    });
    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true }))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS' });
    const fresh = await db('invoices').where({ id: invoiceId }).first('status');
    expect(fresh.status).toBe('sent');
  });

  test('an authentication challenge committed after grace preflight is caught by the final locked void guard', async () => {
    const { invoiceId } = await insertInvoice({ status: 'sent' });
    const StripeService = require('../services/stripe');

    // The grace preflight completed while the invoice was still clear. The
    // saved-card worker then commits authentication_required in the gap before
    // voidInvoice opens its own transaction and takes the invoice row lock.
    await expect(StripeService.assertNoInvoiceChargeReconciliationPending(invoiceId, db, { checkout: true }))
      .resolves.toBeUndefined();
    const attemptId = randomUUID();
    await db('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      stripe_payment_method_id: 'pm_test_auth_chokepoint',
      stripe_payment_intent_id: `pi_${attemptId.replaceAll('-', '')}`,
      stripe_payment_intent_bound_at: new Date(),
      status: 'failed',
      decline_code: 'authentication_required',
      idempotency_key: randomUUID(),
      submitted_at: new Date(),
      resolved_at: new Date(),
    });

    await expect(InvoiceService.voidInvoice(invoiceId, { requireUnsettled: true }))
      .rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: attemptId });
    await expect(db('invoices').where({ id: invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'sent' });
  });

  test('a regular staff void returns an operational conflict until the exact authentication PI is canceled', async () => {
    const { customerId, invoiceId } = await insertInvoice({ status: 'sent' });
    const attemptId = randomUUID();
    const intentId = `pi_${attemptId.replaceAll('-', '')}`;
    const stripeMethodId = 'pm_test_regular_void_auth';
    await db('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      stripe_payment_method_id: stripeMethodId,
      stripe_payment_intent_id: intentId,
      worker_payment_intent_id: intentId,
      stripe_payment_intent_bound_at: new Date(),
      status: 'failed',
      decline_code: 'authentication_required',
      idempotency_key: randomUUID(),
      submitted_at: new Date(),
      resolved_at: new Date(),
    });

    await expect(InvoiceService.voidInvoice(invoiceId)).rejects.toMatchObject({
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      chargeAttemptId: attemptId,
      statusCode: 409,
      isOperational: true,
      message: expect.stringMatching(/^Cannot void/),
    });
    await expect(db('invoices').where({ id: invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'sent' });

    await require('../services/invoice-payment-authentication').recordAuthenticationCancellation({
      id: intentId,
      status: 'canceled',
      payment_method: stripeMethodId,
      metadata: {
        source: 'admin_card_on_file',
        saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId,
        waves_customer_id: customerId,
      },
    }, db);

    await expect(InvoiceService.voidInvoice(invoiceId)).resolves.toMatchObject({ status: 'void' });
  });

  test('a blocked void commits a stale submitted claim promotion before returning its 409', async () => {
    const { invoiceId } = await insertInvoice({ status: 'sent' });
    const attemptId = randomUUID();
    await db('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      stripe_payment_method_id: 'pm_test_stale_submitted_void',
      stripe_payment_intent_id: `pi_${attemptId.replaceAll('-', '')}`,
      status: 'claimed',
      idempotency_key: randomUUID(),
      submitted_at: new Date(Date.now() - 6 * 60 * 1000),
      created_at: new Date(Date.now() - 6 * 60 * 1000),
    });

    await expect(InvoiceService.voidInvoice(invoiceId)).rejects.toMatchObject({
      code: 'STRIPE_AMBIGUOUS_OUTCOME',
      chargeAttemptId: attemptId,
      statusCode: 409,
      isOperational: true,
    });
    await expect(db('stripe_invoice_charge_attempts').where({ id: attemptId }).first('status', 'resolved_at'))
      .resolves.toMatchObject({ status: 'ambiguous', resolved_at: null });
    await expect(db('invoices').where({ id: invoiceId }).first('status'))
      .resolves.toMatchObject({ status: 'sent' });
  });

  test('a shared checkout keeps canonical allocation-lock order before a direct void cancels it', async () => {
    const { customerId, invoiceId: firstId } = await insertInvoice({ status: 'sent' });
    const secondId = randomUUID();
    const [siblingId, targetId] = [firstId, secondId].sort();
    const intentId = `pi_shared_${randomUUID().replaceAll('-', '')}`;
    await db('invoices').insert({
      id: secondId,
      token: randomUUID(),
      invoice_number: `WPC-TEST-${secondId.slice(0, 8)}`,
      customer_id: customerId,
      title: 'Synthetic combined allocation member',
      line_items: JSON.stringify([]),
      subtotal: 50,
      tax_rate: 0,
      tax_amount: 0,
      total: 50,
      status: 'sent',
      credit_applied: 0,
    });
    await db('invoices').whereIn('id', [siblingId, targetId]).update({ stripe_payment_intent_id: intentId });

    const PayCombined = require('../services/pay-combined');
    const StripeService = require('../services/stripe');
    const originalStableLock = PayCombined.lockCombinedCustomerStable;
    let signalVoidAtCombinedLock;
    const voidAtCombinedLock = new Promise((resolve) => { signalVoidAtCombinedLock = resolve; });
    const stableLockSpy = jest.spyOn(PayCombined, 'lockCombinedCustomerStable').mockImplementation(async (...args) => {
      signalVoidAtCombinedLock();
      return originalStableLock(...args);
    });
    const retrieveSpy = jest.spyOn(StripeService, 'retrievePaymentIntent')
      .mockResolvedValue({ id: intentId, status: 'requires_payment_method' });
    const cancelSpy = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({ id: intentId, status: 'canceled' });
    const checkoutTrx = await db.transaction();
    try {
      await PayCombined.lockCombinedCustomers(checkoutTrx, [String(customerId)]);
      await checkoutTrx('invoices').where({ id: siblingId }).forUpdate().first('id');

      const voiding = InvoiceService.voidInvoice(targetId);
      await voidAtCombinedLock;
      await checkoutTrx.raw("SET LOCAL lock_timeout = '1s'");
      await expect(checkoutTrx('invoices').where({ id: targetId }).forUpdate().first('id'))
        .resolves.toMatchObject({ id: targetId });
      await checkoutTrx.commit();

      await expect(voiding).resolves.toMatchObject({ id: targetId, status: 'void' });
      await expect(db('invoices').where({ id: siblingId }).first('stripe_payment_intent_id'))
        .resolves.toMatchObject({ stripe_payment_intent_id: null });
      expect(cancelSpy).toHaveBeenCalledWith(intentId, { cancellation_reason: 'abandoned' });
    } finally {
      if (!checkoutTrx.isCompleted()) await checkoutTrx.rollback();
      stableLockSpy.mockRestore();
      retrieveSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  test('an already-void repair leaves annual coverage intact until the exact authentication PI is canceled', async () => {
    const { customerId, invoiceId } = await insertInvoice({ status: 'void' });
    const termId = randomUUID();
    const attemptId = randomUUID();
    const intentId = `pi_${attemptId.replaceAll('-', '')}`;
    const stripeMethodId = 'pm_test_void_repair_auth';
    await db('annual_prepay_terms').insert({
      id: termId,
      customer_id: customerId,
      prepay_invoice_id: invoiceId,
      plan_label: 'Synthetic repair coverage',
      term_start: '2020-01-01',
      term_end: '2099-12-31',
      status: 'active',
    });
    await db('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      stripe_payment_method_id: stripeMethodId,
      stripe_payment_intent_id: intentId,
      worker_payment_intent_id: intentId,
      stripe_payment_intent_bound_at: new Date(),
      status: 'failed',
      decline_code: 'authentication_required',
      idempotency_key: randomUUID(),
      submitted_at: new Date(),
      resolved_at: new Date(),
    });

    await expect(InvoiceService.voidInvoice(invoiceId)).rejects.toMatchObject({
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      chargeAttemptId: attemptId,
      statusCode: 409,
      isOperational: true,
    });
    await expect(db('annual_prepay_terms').where({ id: termId }).first('status'))
      .resolves.toMatchObject({ status: 'active' });

    await require('../services/invoice-payment-authentication').recordAuthenticationCancellation({
      id: intentId,
      status: 'canceled',
      payment_method: stripeMethodId,
      metadata: {
        source: 'admin_card_on_file',
        saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId,
        waves_customer_id: customerId,
      },
    }, db);

    await expect(InvoiceService.voidInvoice(invoiceId)).resolves.toMatchObject({ status: 'void' });
    await expect(db('annual_prepay_terms').where({ id: termId }).first('status'))
      .resolves.toMatchObject({ status: 'cancelled' });
  });

  // The universal saved-card fence does not import requireUnsettled's stricter
  // settlement-shape rules. A credit-settled prepaid invoice is deliberately
  // still voidable for an operator's ordinary un-prepay action.
  test('with requireUnsettled omitted, a clear credit-settled prepaid invoice still voids', async () => {
    const { invoiceId } = await insertInvoice({ status: 'prepaid', credit_applied: 249, prepaid_at: new Date() });
    const result = await InvoiceService.voidInvoice(invoiceId);
    expect(result.status).toBe('void');
  });
});
