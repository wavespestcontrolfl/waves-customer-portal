/**
 * The Intelligence Bar's apply_invoice_credit card (owner ruling 2026-10-12, Stage 3 cards) replays the Invoices page's own
 * Apply credit handler (admin-invoices.js applyCreditFromBar). The real handler runs here against recorders: the page’s path
 * is unchanged (no version, no extra predicate); the bar adds the invoice version the card showed, checked on the first
 * read (before any balance read or Stripe call), on the LOCKED row, and the account credit left after the draw-down inside
 * the transaction (a mismatch rolls it back). Money moves only from account credit. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/pay-combined', () => ({
  releaseCombinedSessionBeforeCollection: jest.fn(async () => undefined),
  clearPaymentIntentStamps: jest.fn(async () => undefined),
}));
const mockStopOnPayment = jest.fn(async () => undefined);
jest.mock('../services/invoice-followups', () => ({
  stopOnPayment: (...a) => mockStopOnPayment(...a),
  pauseSequence: jest.fn(async () => undefined),
}));
jest.mock('../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => undefined) }));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/project-report-hold', () => ({ scheduleHoldReleaseSweep: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentPlanConfirmed: jest.fn(async () => ({ ok: true })) }));
const mockGetBalance = jest.fn();
const mockPostMovement = jest.fn();
jest.mock('../services/customer-credit', () => ({
  round2: (v) => Math.round((Number(v) || 0) * 100) / 100,
  getBalance: (...a) => mockGetBalance(...a),
  postCreditMovement: (...a) => mockPostMovement(...a),
}));
const mockRetirePi = jest.fn();
jest.mock('../services/invoice-manual-payment', () => ({
  VALID_PAYMENT_METHODS: ['cash', 'check'],
  recordManualPayment: jest.fn(),
  retireOpenPaymentIntentBeforeSettlement: (...a) => mockRetirePi(...a),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-invoices');

const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const INVOICE = {
  id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '100.00', credit_applied: 0, invoice_number: 'WPC-2099-0001',
  payer_id: null, payer_statement_id: null, stripe_payment_intent_id: null, notes: null, updated_at: UPDATED, scheduled_service_id: null,
};
const EXPECTED = { status: 'sent', updatedAt: UPDATED.getTime(), total: 100, creditApplied: 0, paymentIntentId: null, balanceAfterCents: 40000 };
const ACTOR = { technicianId: 'admin-1', name: 'Pat Admin', email: 'admin@example.com' };

function makeRecorder(overrides = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'andWhere', 'whereExists', 'orderBy', 'limit', 'forUpdate', 'noWait'].forEach((m) => { qb[m] = jest.fn(() => qb); });
  qb.first = jest.fn(async () => null);
  qb.insert = jest.fn(() => Promise.resolve(1));
  qb.update = jest.fn(async () => 1);
  qb.returning = jest.fn(async () => []);
  Object.assign(qb, overrides);
  return qb;
}

async function viaPage(body = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/inv-1/apply-credit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

let trx; let trxInvoices; let trxPlans; let trxCustomers; let preInvoices; let trxProjects;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetBalance.mockResolvedValue(500);
  mockPostMovement.mockResolvedValue({ balanceAfter: 400 });
  mockRetirePi.mockResolvedValue(null);
  const prepaidRow = { ...INVOICE, status: 'prepaid' };
  trxInvoices = makeRecorder({
    first: jest.fn(async (...args) => (args[0] === 'status' ? { status: 'prepaid' } : { ...INVOICE })),
    update: jest.fn(() => ({ returning: jest.fn(async () => [prepaidRow]) })),
  });
  trxPlans = makeRecorder();
  trxCustomers = makeRecorder({ first: jest.fn(async () => ({ id: INVOICE.customer_id })) });
  trxProjects = makeRecorder();
  trx = jest.fn((table) => {
    if (table === 'projects') return trxProjects;
    if (table === 'invoices') return trxInvoices;
    if (table === 'payment_plans') return trxPlans;
    if (table === 'customers') return trxCustomers;
    if (['invoice_followup_sequences', 'stripe_invoice_charge_attempts', 'stripe_orphan_charges', 'payments'].includes(table)) return makeRecorder();
    throw new Error(`unexpected trx table ${table}`);
  });
  trx.isTransaction = true;
  trx.fn = { now: jest.fn(() => 'NOW()') };
  preInvoices = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE })) });
  db.mockReset();
  db.mockImplementation((table) => {
    if (table === 'invoices') return preInvoices;
    if (table === 'activity_log') return makeRecorder();
    throw new Error(`unexpected table ${table}`);
  });
  db.transaction.mockImplementation(async (cb) => cb(trx));
});

describe('apply-credit — the page and the bar', () => {
  test('the page applies the credit with no version check; the bar with the card’s version applies the same credit and answers alike', async () => {
    const page = await viaPage({});
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ ok: true, applied: 100, fully_covered: true, balance: 400 });
    expect(mockPostMovement).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', delta: -100, source: 'invoice_prepaid', invoiceId: 'inv-1', createdBy: 'admin-1' }), trx);
    mockPostMovement.mockClear();
    const bar = await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false, note: 'Goodwill' }, actor: ACTOR, expected: EXPECTED });
    expect(bar.status).toBe(200);
    expect(bar.json).toMatchObject({ ok: true, applied: 100, fully_covered: true, balance: 400 });
    // The recorder is the staff member's name, as the page reads it from the login; the note rides to the credit entry.
    expect(mockPostMovement).toHaveBeenCalledWith(expect.objectContaining({ delta: -100, createdBy: 'Pat Admin', note: 'Goodwill' }), trx);
    expect(mockStopOnPayment).toHaveBeenCalledTimes(2);
    // Both flips are the page's own: prepaid, the whole amount due, and the setup fee is never waived by the bar.
    for (const [updates] of trxInvoices.update.mock.calls) {
      expect(updates).toMatchObject({ status: 'prepaid', credit_applied: 100 });
      expect(updates).not.toHaveProperty('setup_fee_waived');
    }
    expect(trxInvoices.update.mock.calls.map(([u]) => u.prepaid_by)).toEqual(['admin-1', 'Pat Admin']);
  });

  test('the HTTP route never takes the version from the request', async () => {
    trxInvoices.first.mockImplementation(async () => ({ ...INVOICE, updated_at: new Date('2099-05-05T00:00:00Z') }));
    const page = await viaPage({ ibExpectedCredit: EXPECTED, expected: EXPECTED, waiveSetupFee: false });
    expect(page.status).toBe(200);
    expect(mockPostMovement).toHaveBeenCalledTimes(1);
  });

  test('a changed invoice on the first read refuses before any balance read, Stripe call or transaction', async () => {
    for (const change of [{ updated_at: new Date('2099-01-02T00:00:00Z') }, { total: '110.00' }, { credit_applied: 5 }, { status: 'viewed' }, { stripe_payment_intent_id: 'pi_new' }]) {
      preInvoices.first.mockImplementation(async () => ({ ...INVOICE, ...change }));
      const answer = await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED });
      expect(answer).toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED' } });
    }
    expect(mockGetBalance).not.toHaveBeenCalled();
    expect(mockRetirePi).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  test('an edit between the first read and the lock is caught on the LOCKED row: no credit is drawn, nothing is flipped', async () => {
    trxInvoices.first.mockImplementation(async () => ({ ...INVOICE, updated_at: new Date('2099-01-03T00:00:00Z') }));
    const answer = await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED });
    expect(answer).toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED' } });
    expect(mockPostMovement).not.toHaveBeenCalled();
    expect(trxInvoices.update).not.toHaveBeenCalled();
    expect(mockStopOnPayment).not.toHaveBeenCalled();
  });

  test('the account credit left after the draw-down must be the one the card showed; otherwise the transaction rolls back before the prepaid flip', async () => {
    mockPostMovement.mockResolvedValue({ balanceAfter: 390 });
    const answer = await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED });
    expect(answer).toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED', error: expect.stringMatching(/account credit balance is no longer what the card showed/) } });
    expect(trxInvoices.update).not.toHaveBeenCalled();
    expect(mockStopOnPayment).not.toHaveBeenCalled();
    // The page has no such pin: the same movement completes.
    const page = await viaPage({});
    expect(page.status).toBe(200);
  });

  test('the page’s own refusals reach the shim unchanged (a payer invoice, insufficient credit)', async () => {
    preInvoices.first.mockImplementation(async () => ({ ...INVOICE, payer_id: 'payer-1' }));
    await expect(router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: { ...EXPECTED } })).resolves
      .toMatchObject({ status: 400, json: { error: expect.stringMatching(/third-party payer/) } });
    preInvoices.first.mockImplementation(async () => ({ ...INVOICE }));
    mockGetBalance.mockResolvedValue(50);
    await expect(router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED })).resolves
      .toMatchObject({ status: 400, json: { error: expect.stringMatching(/Insufficient account credit/) } });
    expect(mockPostMovement).not.toHaveBeenCalled();
  });

  test('an invoice linked to ANY project is refused for the bar under the invoice lock, before any credit moves; the page is untouched', async () => {
    trxProjects.first.mockImplementation(async () => ({ id: 'proj-1' }));
    const answer = await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED });
    expect(answer).toMatchObject({ status: 409, json: { code: 'NEEDS_INVOICES_PAGE', error: expect.stringMatching(/linked to a project/) } });
    expect(trxProjects.where).toHaveBeenCalledWith({ invoice_id: 'inv-1' });
    // A plain read under the invoice row's FOR UPDATE (project links take that invoice row FOR SHARE first); no project-row lock, which
    // would invert the project -> invoice lock order.
    expect(trxProjects.forUpdate).not.toHaveBeenCalled();
    expect(trxInvoices.forUpdate).toHaveBeenCalled();
    expect(mockPostMovement).not.toHaveBeenCalled();
    expect(trxInvoices.update).not.toHaveBeenCalled();
    expect(mockStopOnPayment).not.toHaveBeenCalled();
    // The page does not read projects here at all.
    trx.mockClear();
    const page = await viaPage({});
    expect(page.status).toBe(200);
    expect(trx).not.toHaveBeenCalledWith('projects');
  });

  test('applying credit sends nothing and charges no card: no Stripe charge call exists on this path', async () => {
    await router.applyCreditFromBar({ invoiceId: 'inv-1', body: { waiveSetupFee: false }, actor: ACTOR, expected: EXPECTED });
    // The only Stripe-facing step is retiring an open card session (none here); the bar's card refuses an invoice that has one.
    expect(mockRetirePi).toHaveBeenCalledTimes(1);
    expect(require('../services/review-request').enrollForPaidInvoice).toHaveBeenCalledTimes(1);
  });
});
