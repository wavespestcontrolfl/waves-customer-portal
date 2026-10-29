/**
 * Partial payments, the writer (owner 2026-10-29): recordManualPayment takes an explicit amount.
 *   more than owed  -> 400, nothing opened
 *   the whole owed  -> today's paid flip, now fenced to that figure; resets amount_paid and books the REMAINDER
 *   less than owed  -> a part payment: behind GATE_PARTIAL_PAYMENTS, person-entered, never for Auto Pay, a plan, an annual prepay
 *                      invoice or a payer-billed invoice; no paid flip, no receipt, no reminder stop
 * The real-Postgres suite (invoice-partial-payment-postgres.test.js) shows the same rules against the real tables.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => ({ status: 'canceled' })),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
}));
jest.mock('../services/pay-combined', () => ({
  clearPaymentIntentStamps: jest.fn(async () => undefined),
  releaseCombinedSessionBeforeCollection: jest.fn(async () => undefined),
}));
jest.mock('../services/invoice', () => ({ sendReceipt: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => undefined) }));
jest.mock('../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => undefined) }));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
jest.mock('../services/payment-plans', () => ({ completeActivePlansForInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/open-balance', () => ({ rowIsSelfPayDue: jest.fn(async () => true) }));
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: jest.fn(async () => null) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/invoice-issued-closeout', () => ({
  recordApprovedPaidCloseoutTarget: jest.fn(async () => undefined),
  closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: false })),
}));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(async () => ({ enqueued: true })),
  scheduleReceiptDeliveryDrain: jest.fn(),
  claimReceiptJobForOperatorSend: jest.fn(async () => ({ id: 'job-1', token: 'claim-1', prior: null })),
  recordOperatorReceiptDelivered: jest.fn(async () => undefined),
  releaseOperatorReceiptClaim: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const { recordAuditEvent } = require('../services/audit-log');
const { sendReceiptEmail } = require('../services/invoice-email');
const FollowUps = require('../services/invoice-followups');
const PaymentPlans = require('../services/payment-plans');
const { resolveInvoiceTermId } = require('../services/invoice-prepay');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { rowIsSelfPayDue } = require('../services/open-balance');
const { recordManualPayment } = require('../services/invoice-manual-payment');

function recorder({ first = null, returning = [] } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotIn', 'andWhere', 'orderBy', 'limit', 'forUpdate', 'noWait', 'whereNull', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => Object.assign(Promise.resolve(undefined), { returning: jest.fn(async () => [{ id: 'pay-1' }]) }));
  q.returning = jest.fn(async () => returning);
  return q;
}

const openInvoice = (over = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2026-0500', customer_id: 'cust-1', status: 'sent',
  total: '100.00', credit_applied: 0, amount_paid: 0, stripe_payment_intent_id: null, payer_id: null, payer_statement_id: null, notes: null,
  ...over,
});

async function refusalOf(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a refusal');
}

let lastPre = null;
// The Invoices page sends the amount owed it showed beside the amount (owedCentsSeen); these cases send what the pre-lock row owes.
const owedCentsOf = (inv) => Math.max(0, Math.round(Number(inv.total) * 100) - Math.round(Number(inv.credit_applied || 0) * 100)
  - Math.round(Number(inv.amount_paid || 0) * 100));
const recordFromPage = (id, opts) => recordManualPayment(id, { owedCentsSeen: owedCentsOf(lastPre), ...opts });

// The pool answers the pre-lock reads (the invoice, the part-payment checks, the activity row); the transaction answers the locked ones.
// `locked` is the row FOR UPDATE returns; `after` is what the UPDATE ... RETURNING gives back.
function harness({ pre = openInvoice(), locked = pre, after = null, plan = null, term = null, customer = { id: 'cust-1' } } = {}) {
  lastPre = pre;
  const calls = { invoiceUpdate: null, paymentsInsert: null };
  const activity = recorder();
  db.mockImplementation((table) => {
    if (table === 'invoices') return recorder({ first: pre });
    if (table === 'payment_plans') return recorder({ first: plan });
    if (table === 'annual_prepay_terms') return recorder({ first: term });
    if (table === 'customers') return recorder({ first: customer });
    if (table === 'activity_log') return activity;
    throw new Error(`unexpected table ${table}`);
  });
  db.transaction.mockImplementation(async (fn) => {
    const trx = jest.fn((table) => {
      if (table === 'invoices') {
        const r = recorder({ first: locked, returning: [after || locked] });
        r.update = jest.fn((payload) => { calls.invoiceUpdate = payload; return r; });
        return r;
      }
      if (table === 'payments') {
        const r = recorder();
        r.insert = jest.fn((payload) => {
          calls.paymentsInsert = payload;
          return Object.assign(Promise.resolve(undefined), { returning: jest.fn(async () => [{ id: 'pay-1' }]) });
        });
        return r;
      }
      if (table === 'payment_plans') return recorder({ first: plan });
      if (table === 'annual_prepay_terms') return recorder({ first: term });
      if (table === 'customers') return recorder({ first: customer });
      throw new Error(`unexpected trx table ${table}`);
    });
    trx.fn = { now: () => 'NOW()' };
    trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    trx.schema = { hasTable: jest.fn(async () => true) };
    return fn(trx);
  });
  return { calls, activity };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PARTIAL_PAYMENTS = 'true';
  customerOnAutopay.mockResolvedValue(false);
  resolveInvoiceTermId.mockResolvedValue(null);
  rowIsSelfPayDue.mockResolvedValue(true);
  db.mockImplementation((table) => { throw new Error(`unexpected table ${table}`); });
  db.transaction.mockReset();
});
afterAll(() => { delete process.env.GATE_PARTIAL_PAYMENTS; });

describe('the amount against what is owed', () => {
  test('more than owed is refused before anything opens', async () => {
    harness({ pre: openInvoice({ amount_paid: '30.00' }) });
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 7001 }));
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('That is more than the $70.00 still owed on this invoice. Nothing was recorded.');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a bad amount is refused before any read', async () => {
    for (const amountCents of [0, -5, 12.5]) {
      const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents }));
      expect(err.statusCode).toBe(400);
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('the whole amount owed is the full path: paid flip, amount_paid reset, fenced to the figure the page showed', async () => {
    const { calls } = harness({ pre: openInvoice(), after: openInvoice({ status: 'paid', amount_paid: 0 }) });
    const out = await recordFromPage('inv-1', { method: 'check', amountCents: 10000, sendReceipt: false });
    expect(out.partial).toBeUndefined();
    expect(calls.invoiceUpdate).toMatchObject({ status: 'paid', amount_paid: 0 });
    expect(calls.paymentsInsert.amount).toBe(100);
    expect(FollowUps.stopOnPayment).toHaveBeenCalledWith('inv-1');
    // The page's figure no longer matches what is owed (an edit or credit since): refused, nothing written.
    harness({ pre: openInvoice({ total: '90.00' }) });
    const err = await refusalOf(recordFromPage('inv-1', { method: 'check', amountCents: 10000 }));
    expect(err.statusCode).toBe(400);
  });

  test('the paid flip of a part-paid invoice books the REMAINDER, links the row, resets amount_paid, and the marker keeps the old figure', async () => {
    const locked = openInvoice({ amount_paid: '40.00' });
    const { calls, activity } = harness({ pre: locked, locked, after: openInvoice({ status: 'paid', amount_paid: 0 }) });
    await recordManualPayment('inv-1', { method: 'cash', sendReceipt: false });
    expect(calls.invoiceUpdate).toMatchObject({ status: 'paid', amount_paid: 0 });
    expect(calls.paymentsInsert.amount).toBe(60);
    expect(JSON.parse(calls.paymentsInsert.metadata)).toMatchObject({ invoice_id: 'inv-1', completes_part_payments: true, amount_paid_before: 40 });
    const marker = recordAuditEvent.mock.calls.map(([e]) => e).find((e) => e.action === 'invoice.manual_payment_recorded');
    expect(marker.metadata.amount).toBe(60);
    expect(marker.metadata.partial).toBeUndefined();
    expect(marker.metadata.previous.amount_paid).toBe('40.00');
    expect(activity.insert.mock.calls[0][0].description).toMatch(/\(\$60\.00 via cash/);
  });
});

describe('a part payment', () => {
  test('records the part: amount_paid grows, status and tender stay, one payments row, both markers, nothing else fires', async () => {
    const { calls, activity } = harness({ after: openInvoice({ amount_paid: '40.00' }) });
    const out = await recordFromPage('inv-1', {
      method: 'zelle', reference: 'ZL1', note: 'half now', amountCents: 4000, recordedBy: 'Office', recordedByTechnicianId: 7,
    });
    expect(out.partial).toEqual({ amount: 40, remaining: 60 });
    expect(out.receipt).toBeNull();
    const update = calls.invoiceUpdate;
    expect(update).not.toHaveProperty('status');
    expect(update).not.toHaveProperty('paid_at');
    expect(update).not.toHaveProperty('payment_method');
    expect(update).toMatchObject({ payment_recorded_by: 'Office', stripe_payment_intent_id: null, processor: null });
    expect(update.amount_paid.bindings).toEqual([40]);
    expect(update.notes).toMatch(/ZELLE ZL1: half now/);
    expect(calls.paymentsInsert).toMatchObject({ amount: 40, status: 'paid', customer_id: 'cust-1' });
    expect(calls.paymentsInsert.description).toMatch(/^Invoice WPC-2026-0500 — zelle \(part payment\) \(ZL1\)$/);
    expect(JSON.parse(calls.paymentsInsert.metadata)).toEqual({ invoice_id: 'inv-1', partial_payment: true });
    const events = recordAuditEvent.mock.calls.map(([e]) => e);
    expect(events.map((e) => e.action)).toEqual(['invoice.manual_payment_recorded', 'invoice.manual_payment_effects_done']);
    expect(events[0].metadata).toMatchObject({ paymentId: 'pay-1', amount: 40, partial: true, automated: false, method: 'zelle' });
    expect(Object.keys(events[0].metadata.previous).sort()).toEqual(['notes', 'payment_recorded_at', 'payment_recorded_by']);
    expect(events[1].metadata).toEqual({ paymentId: 'pay-1' });
    expect(activity.insert.mock.calls[0][0].description).toMatch(/Part payment recorded for WPC-2026-0500 \(\$40\.00 via zelle · ref ZL1; \$60\.00 still owed\) — Office/);
    // Reminders continue, no receipt, no plan completion, no review ask, no closeout, no prepay activation, no pause clear.
    expect(FollowUps.stopOnPayment).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(PaymentPlans.completeActivePlansForInvoice).not.toHaveBeenCalled();
    expect(require('../services/review-request').enrollForPaidInvoice).not.toHaveBeenCalled();
    expect(require('../services/annual-prepay-renewals').syncTermForInvoicePayment).not.toHaveBeenCalled();
    expect(require('../services/billing-pause').maybeResumeBillingPauseOnPayment).not.toHaveBeenCalled();
    expect(require('../services/invoice-issued-closeout').closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
    // It rides the live self-pay re-resolution, like the Zelle paths.
    expect(rowIsSelfPayDue).toHaveBeenCalled();
  });

  test('a second part is a part of what is still owed', async () => {
    const pre = openInvoice({ amount_paid: '40.00' });
    harness({ pre, after: openInvoice({ amount_paid: '90.00' }) });
    const out = await recordFromPage('inv-1', { method: 'cash', amountCents: 5000 });
    expect(out.partial).toEqual({ amount: 50, remaining: 10 });
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 6001 }));
    expect(err.message).toBe('That is more than the $60.00 still owed on this invoice. Nothing was recorded.');
  });

  test.each([
    ['the gate is off', () => { process.env.GATE_PARTIAL_PAYMENTS = 'false'; }, {}, 400, /Part payments are not turned on/],
    ['the gate is unset', () => { delete process.env.GATE_PARTIAL_PAYMENTS; }, {}, 400, /Part payments are not turned on/],
    ['the caller is the Zelle reconciler', () => {}, { automated: true }, 400, /entered by hand on the Invoices page/],
    ['the caller carries an expected figure (notice Apply, Intelligence Bar)', () => {}, { expectedAmountCents: 10000 }, 400, /entered by hand/],
    ['the caller carries a settlement fence', () => {}, { settlementFence: async () => true }, 400, /entered by hand/],
    ['the caller asks for the self-pay fence', () => {}, { requireSelfPay: true }, 400, /entered by hand/],
  ])('refused when %s, before any transaction', async (_label, arrange, extra, status, message) => {
    arrange();
    harness();
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 4000, ...extra }));
    expect(err.statusCode).toBe(status);
    expect(err.message).toMatch(message);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['a payer-billed invoice', { pre: openInvoice({ payer_id: 'payer-1' }) }, () => {}, /billed to a payer/],
    ['an active payment plan', { plan: { id: 'plan-1' } }, () => {}, /payment plan/],
    ['an annual prepay invoice (term resolves)', {}, () => resolveInvoiceTermId.mockResolvedValue('term-1'), /annual prepay invoice/],
    ['an annual prepay invoice (it is a term\'s prepay invoice)', { term: { id: 'term-1' } }, () => {}, /annual prepay invoice/],
    ['an Auto Pay customer', {}, () => customerOnAutopay.mockResolvedValue(true), /on Auto Pay/],
    ['an Auto Pay read that fails (fail closed)', {}, () => customerOnAutopay.mockRejectedValue(new Error('db down')), /Auto Pay could not be checked/],
    ['an unreadable customer row', { customer: null }, () => {}, /on Auto Pay/],
  ])('refused for %s: 409, nothing recorded', async (_label, setup, arrange, message) => {
    harness(setup);
    arrange();
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 4000 }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(message);
    expect(err.message).toMatch(/Nothing was recorded\.$/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('Auto Pay is read fail-closed against the pool before the lock and again on the locked row', async () => {
    harness();
    await recordFromPage('inv-1', { method: 'cash', amountCents: 4000 });
    expect(customerOnAutopay).toHaveBeenCalledTimes(2);
    for (const call of customerOnAutopay.mock.calls) expect(call[1]).toMatchObject({ failClosed: true });
  });

  test('a customer who joined Auto Pay, or a plan created, between the first read and the lock: 409 under the lock, nothing written', async () => {
    const h = harness();
    customerOnAutopay.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 4000 }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/on Auto Pay/);
    expect(h.calls.invoiceUpdate).toBeNull();
    expect(h.calls.paymentsInsert).toBeNull();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('the amount owed moved to the part or below while waiting for the lock: 409, nothing written', async () => {
    const h = harness({ pre: openInvoice(), locked: openInvoice({ amount_paid: '60.00' }) });
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 4000 }));
    expect(err.statusCode).toBe(409);
    // The locked row no longer owes what the page showed ($100): the owed-amount fence answers first.
    expect(err.message).toMatch(/changed to \$40\.00 since the page loaded/);
    expect(h.calls.invoiceUpdate).toBeNull();
    expect(h.calls.paymentsInsert).toBeNull();
  });

  test('a payer assigned after the first read refuses under the lock (the live self-pay re-resolution)', async () => {
    const h = harness();
    rowIsSelfPayDue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const err = await refusalOf(recordFromPage('inv-1', { method: 'cash', amountCents: 4000 }));
    expect(err.statusCode).toBe(409);
    expect(h.calls.paymentsInsert).toBeNull();
  });
});

describe('a part-paid invoice and the Zelle reconciler', () => {
  test('an automated settlement refuses before the Stripe session is retired', async () => {
    harness({ pre: openInvoice({ amount_paid: '40.00', stripe_payment_intent_id: 'pi_live' }) });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', automated: true, expectedAmountCents: 6000, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/part payment.*Zelle notice cannot settle it by itself/);
    expect(require('../services/stripe').cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a part payment that lands between the pre-lock read and the lock refuses under the lock', async () => {
    const h = harness({ pre: openInvoice(), locked: openInvoice({ amount_paid: '40.00' }) });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'zelle', automated: true, requireSelfPay: true }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/Zelle notice cannot settle it by itself/);
    expect(h.calls.paymentsInsert).toBeNull();
  });
});

describe('a repeated submit never books the same part payment twice (pre-push P0)', () => {
  test('an amount without the amount owed the page showed is refused before anything opens', async () => {
    harness();
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash', amountCents: 4000 }));
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/Reload the invoice/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the same $40 submitted again after the first landed meets $60 owed, not the $100 it saw, and is refused', async () => {
    harness({ pre: openInvoice({ amount_paid: '40.00' }) });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash', amountCents: 4000, owedCentsSeen: 10000 }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/changed to \$60\.00 since the page loaded/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a part payment that committed while this one waited for the lock is seen on the locked row: refused, nothing written', async () => {
    const { calls } = harness({ pre: openInvoice(), locked: openInvoice({ amount_paid: '40.00' }) });
    const err = await refusalOf(recordManualPayment('inv-1', { method: 'cash', amountCents: 4000, owedCentsSeen: 10000 }));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/changed to \$60\.00/);
    expect(calls.paymentsInsert).toBeNull();
    expect(calls.invoiceUpdate).toBeNull();
  });
});
