/**
 * A settled invoice must never keep an ACTIVE payment plan.
 *
 * payment_plans rows gate invoice edits (invoice.js), credit reversal
 * (reverse-prepaid) and auto-credit (customer-credit.js), but until the
 * auto-complete hook nothing ever moved a plan out of 'active' — a paid
 * invoice stayed edit-locked behind a plan with nothing left to collect.
 *
 * These tests drive the real record-payment and apply-credit handlers and
 * assert the plan flip to 'completed' runs on the SAME transaction as the
 * paid/prepaid flip, so a refactor that drops the call or moves it post-commit
 * (where a crash strands the plan) fails here.
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
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/pay-combined', () => ({
  releaseCombinedSessionBeforeCollection: jest.fn(async () => undefined),
  clearPaymentIntentStamps: jest.fn(async () => undefined),
}));
jest.mock('../services/invoice-followups', () => ({
  stopOnPayment: jest.fn(async () => undefined),
  pauseSequence: jest.fn(async () => undefined),
}));
jest.mock('../services/billing-pause', () => ({
  maybeResumeBillingPauseOnPayment: jest.fn(async () => undefined),
}));
jest.mock('../services/review-request', () => ({
  enrollForPaidInvoice: jest.fn(async () => undefined),
}));
jest.mock('../services/project-report-hold', () => ({
  scheduleHoldReleaseSweep: jest.fn(),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentPlanConfirmed: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/customer-credit', () => ({
  round2: (v) => Math.round((Number(v) || 0) * 100) / 100,
  getBalance: jest.fn(async () => 500),
  postCreditMovement: jest.fn(async () => ({ balanceAfter: 400 })),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-invoices');

const INVOICE = {
  id: 'inv-1',
  customer_id: 'cust-1',
  status: 'sent',
  total: '100.00',
  credit_applied: 0,
  invoice_number: 'WPC-2026-0001',
  payer_id: null,
  payer_statement_id: null,
  stripe_payment_intent_id: null,
  notes: null,
};

function makeRecorder(overrides = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereNotIn', 'andWhere', 'whereExists', 'orderBy', 'limit', 'forUpdate'].forEach((m) => {
    qb[m] = jest.fn(() => qb);
  });
  qb.first = jest.fn(async () => null);
  qb.insert = jest.fn(() => Promise.resolve(1));
  qb.update = jest.fn(async () => 1);
  qb.returning = jest.fn(async () => []);
  Object.assign(qb, overrides);
  return qb;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('active payment plans auto-complete when the invoice settles', () => {
  let trx;
  let trxInvoices;
  let trxPayments;
  let trxPlans;

  beforeEach(() => {
    jest.clearAllMocks();

    const paidRow = { ...INVOICE, status: 'paid' };
    trxInvoices = makeRecorder({
      // first('status') = completeActivePlansForInvoice's FOR UPDATE
      // settlement re-check — the same trx already flipped the row paid.
      first: jest.fn(async (...args) => (args[0] === 'status' ? { status: 'paid' } : { ...INVOICE })),
      update: jest.fn(() => ({ returning: jest.fn(async () => [paidRow]) })),
    });
    trxPayments = makeRecorder();
    trxPlans = makeRecorder();
    trx = jest.fn((table) => {
      if (table === 'invoices') return trxInvoices;
      if (table === 'payments') return trxPayments;
      if (table === 'payment_plans') return trxPlans;
      // completeActivePlansForInvoice also releases plan-owned dunning stops.
      if (table === 'invoice_followup_sequences') return makeRecorder();
      throw new Error(`unexpected trx table ${table}`);
    });
    trx.isTransaction = true; // real knex trx flag — completeActivePlansForInvoice reuses a caller trx as-is
    trx.fn = { now: jest.fn(() => 'NOW()') };

    const invoicesQB = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE })) });
    const activityQB = makeRecorder();
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoicesQB;
      if (table === 'activity_log') return activityQB;
      throw new Error(`unexpected table ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(trx));
  });

  test('record-payment completes the active plan on the same transaction as the paid flip', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/record-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'check', sendReceipt: false }),
      });
      expect(res.status).toBe(200);
      // The completion rides the SAME trx as the status flip — a paid
      // invoice must never keep an 'active' plan that blocks edits.
      expect(trx).toHaveBeenCalledWith('payment_plans');
      expect(trxPlans.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'active' });
      expect(trxPlans.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'completed',
        completed_at: expect.any(Date),
      }));
    });
  });

  test('apply-credit completes the active plan on the same transaction as the prepaid flip', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(trx).toHaveBeenCalledWith('payment_plans');
      expect(trxPlans.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'active' });
      expect(trxPlans.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'completed',
        completed_at: expect.any(Date),
      }));
    });
  });
});
