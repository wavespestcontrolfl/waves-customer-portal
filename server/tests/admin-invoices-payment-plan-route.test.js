/**
 * Route-level coverage of POST /admin/invoices/:id/payment-plan.
 *
 * The helper stopInvoiceFollowupsForPaymentPlan has direct unit coverage
 * (admin-invoices-recipient.test.js), but its ONLY production trigger is the
 * call inside this route's plan-creation transaction. This test drives the
 * real handler and asserts the EFFECT — invoice_followup_sequences rows are
 * stopped on the SAME trx that inserts the plan — so a refactor that drops,
 * reorders, or moves the call outside the transaction fails here even though
 * the helper's own unit tests stay green (customers on a payment plan must
 * never keep receiving overdue-invoice dunning).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => sql);
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
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentPlanConfirmed: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/invoice-followups', () => ({
  pauseSequence: jest.fn(async () => undefined),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-invoices');

const INVOICE = {
  id: 'inv-1',
  customer_id: 'cust-1',
  status: 'sent',
  total: '100.00',
  invoice_number: 'WPC-2026-0001',
  payer_id: null,
};
const CREATED_PLAN = { id: 'plan-1', total_balance: '100.00' };

function makeRecorder(overrides = {}) {
  const qb = {};
  ['where', 'whereIn', 'andWhere', 'orderBy', 'limit', 'forUpdate'].forEach((m) => {
    qb[m] = jest.fn(() => qb);
  });
  qb.first = jest.fn(async () => null);
  qb.insert = jest.fn(() => Promise.resolve(1));
  qb.update = jest.fn(async () => 1);
  qb.returning = jest.fn(async () => [CREATED_PLAN]);
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

describe('POST /:id/payment-plan stops dunning inside the plan transaction', () => {
  let trx;
  let trxInvoices;
  let trxPlans;
  let trxFollowups;

  beforeEach(() => {
    jest.clearAllMocks();

    trxInvoices = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE })) });
    trxPlans = makeRecorder({
      insert: jest.fn(() => ({ returning: jest.fn(async () => [CREATED_PLAN]) })),
    });
    trxFollowups = makeRecorder();
    trx = jest.fn((table) => {
      if (table === 'invoices') return trxInvoices;
      if (table === 'payment_plans') return trxPlans;
      if (table === 'invoice_followup_sequences') return trxFollowups;
      throw new Error(`unexpected trx table ${table}`);
    });

    const invoicesQB = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE })) });
    const plansQB = makeRecorder({ first: jest.fn(async () => null) });
    const activityQB = makeRecorder();
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoicesQB;
      if (table === 'payment_plans') return plansQB;
      if (table === 'activity_log') return activityQB;
      throw new Error(`unexpected table ${table}`);
    });
    db.transaction.mockImplementation(async (cb) => cb(trx));
  });

  test('creating a plan stops active/paused/autopay_hold follow-up sequences on the trx', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentFrequency: 'monthly',
          paymentAmount: 25,
          nextPaymentDate: '2026-08-01',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.paymentPlan.id).toBe('plan-1');

      // The dunning stop must run against the SAME transaction that inserted
      // the plan — a plan without a stopped sequence keeps dunning customers.
      expect(trx).toHaveBeenCalledWith('invoice_followup_sequences');
      expect(trxFollowups.where).toHaveBeenCalledWith({ invoice_id: 'inv-1' });
      expect(trxFollowups.whereIn).toHaveBeenCalledWith('status', ['active', 'paused', 'autopay_hold']);
      expect(trxFollowups.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stopped',
          stopped_reason: 'payment_plan_created:plan-1',
          stopped_by_admin_id: 'admin-1',
        }),
      );
    });
  });

  test('a failing dunning stop aborts the plan insert (transaction atomicity)', async () => {
    trxFollowups.update.mockRejectedValue(new Error('followup stop failed'));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentFrequency: 'monthly',
          paymentAmount: 25,
          nextPaymentDate: '2026-08-01',
        }),
      });
      // The error propagates out of db.transaction — the route must not
      // report a created plan whose dunning stop never committed.
      expect(res.status).toBeGreaterThanOrEqual(500);
    });
  });
});
