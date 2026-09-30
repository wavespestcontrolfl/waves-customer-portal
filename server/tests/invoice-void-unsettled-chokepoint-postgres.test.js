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

  // Every EXISTING caller (requireUnsettled defaults off) stays
  // byte-identical — a credit-settled 'prepaid' invoice is deliberately
  // voidable for them (e.g. an operator's own un-prepay action), per
  // assertInvoiceVoidable's own transition matrix.
  test('with requireUnsettled omitted (default off), a credit-settled prepaid invoice still voids — byte-identical to every pre-existing caller', async () => {
    const { invoiceId } = await insertInvoice({ status: 'prepaid', credit_applied: 249, prepaid_at: new Date() });
    const result = await InvoiceService.voidInvoice(invoiceId);
    expect(result.status).toBe('void');
  });
});
