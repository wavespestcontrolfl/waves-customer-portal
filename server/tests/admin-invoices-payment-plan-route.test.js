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
  resumeSequence: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
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
// The under-lock re-read returns a DIFFERENT owner than the pre-transaction
// read: a customer merge/undo can repoint invoices.customer_id while this
// request waits on the invoice row lock, and the plan must be attributed
// from the row it actually locked (r16) — never the stale snapshot.
const LOCKED_INVOICE = { ...INVOICE, customer_id: 'cust-2-post-repoint' };
const CREATED_PLAN = { id: 'plan-1', total_balance: '100.00', customer_id: 'cust-2-post-repoint' };

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

    trxInvoices = makeRecorder({ first: jest.fn(async () => ({ ...LOCKED_INVOICE })) });
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
      expect(trxFollowups.where).toHaveBeenCalledWith(expect.any(Function));
      expect(trxFollowups.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'stopped',
          stopped_reason: 'payment_plan_created:plan-1',
          stopped_by_admin_id: 'admin-1',
        }),
      );
    });
  });

  test('the plan is attributed from the LOCKED invoice row, not the pre-transaction read (merge/undo repoint race)', async () => {
    const email = require('../services/payment-lifecycle-email');
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
      // The invoice row was locked, and the insert carried the LOCKED row's
      // owner — a plan pinned to the stale pre-transaction customer would
      // govern the invoice's collection path under the wrong customer.
      expect(trxInvoices.forUpdate).toHaveBeenCalled();
      expect(trxPlans.insert).toHaveBeenCalledWith(expect.objectContaining({
        customer_id: 'cust-2-post-repoint',
        invoice_id: 'inv-1',
      }));
      // Post-commit attribution rides the created plan row too.
      expect(email.sendPaymentPlanConfirmed).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-2-post-repoint',
        idempotencyKey: 'payment.plan_confirmed:plan-1:cust-2-post-repoint',
      }));
    });
  });

  test('a settlement that lands while waiting on the lock is a 409, not a fresh active plan on a paid invoice', async () => {
    trxInvoices.first.mockResolvedValue({ ...LOCKED_INVOICE, status: 'paid' });
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
      expect(res.status).toBe(409);
      expect(trxPlans.insert).not.toHaveBeenCalled();
    });
  });

  test('a vanished invoice at lock time is a 409, not a plan attributed from a stale snapshot', async () => {
    trxInvoices.first.mockResolvedValue(null);
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
      expect(res.status).toBe(409);
      expect(trxPlans.insert).not.toHaveBeenCalled();
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

describe('POST /:id/payment-plan/cancel', () => {
  let trx;
  let trxInvoices;
  let trxPlans;
  let trxFollowupsSeq;

  const ACTIVE_PLAN = { id: 'plan-1', customer_id: 'cust-1', status: 'active' };
  const CANCELLED_PLAN = { ...ACTIVE_PLAN, status: 'cancelled' };

  beforeEach(() => {
    jest.clearAllMocks();
    trxInvoices = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE })) });
    trxPlans = makeRecorder({
      first: jest.fn(async () => ({ ...ACTIVE_PLAN })),
      update: jest.fn(() => ({ returning: jest.fn(async () => [CANCELLED_PLAN]) })),
    });
    trxFollowupsSeq = makeRecorder({
      // The sequence THIS plan stopped — the only kind cancel may re-arm.
      first: jest.fn(async () => ({ id: 'seq-1', status: 'stopped', stopped_reason: 'payment_plan_created:plan-1' })),
    });
    trx = jest.fn((table) => {
      if (table === 'invoices') return trxInvoices;
      if (table === 'payment_plans') return trxPlans;
      if (table === 'invoice_followup_sequences') return trxFollowupsSeq;
      throw new Error(`unexpected trx table ${table}`);
    });
    const activityQB = makeRecorder();
    db.mockImplementation((table) => {
      if (table === 'activity_log') return activityQB;
      throw new Error(`unexpected table ${table}`);
    });
    db.followupsQB = trxFollowupsSeq;
    db.transaction.mockImplementation(async (cb) => cb(trx));
  });

  test('cancels the active plan under row locks and stamps cancelled_at/by', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1', reason: 'created in error' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.paymentPlan.status).toBe('cancelled');
      // Both rows locked in the transaction before the flip.
      expect(trxInvoices.forUpdate).toHaveBeenCalled();
      expect(trxPlans.forUpdate).toHaveBeenCalled();
      // The UPDATE re-asserts status='active' so a concurrent completion
      // (invoice paid mid-request) can't be silently overwritten.
      expect(trxPlans.where).toHaveBeenCalledWith({ id: 'plan-1', status: 'active' });
      expect(trxPlans.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        cancelled_by: 'admin-1',
        cancelled_at: expect.any(Date),
      }));
      // Cancelling returns the invoice to normal collection — the dunning
      // sequence the plan stopped must be re-armed, or "reopens for
      // collection" is a lie (codex r1 P1).
      const FollowUps = require('../services/invoice-followups');
      expect(FollowUps.resumeSequence).toHaveBeenCalledWith('inv-1', expect.anything());
    });
  });

  test('the plan-owned PAUSED shape (create route pauses post-commit) is re-armed too (codex r5 P1)', async () => {
    db.followupsQB.first.mockResolvedValue({
      id: 'seq-1',
      status: 'paused',
      paused_reason: 'payment_plan_created',
      stopped_reason: 'payment_plan_created:plan-1',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(200);
      const FollowUps = require('../services/invoice-followups');
      expect(FollowUps.resumeSequence).toHaveBeenCalledWith('inv-1', expect.anything());
    });
  });

  test('no sequence row at cancel time → the existing scheduling mechanism arms one (codex r6 P1)', async () => {
    db.followupsQB.first.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(200);
      const FollowUps = require('../services/invoice-followups');
      expect(FollowUps.resumeSequence).not.toHaveBeenCalled();
      expect(FollowUps.scheduleForInvoice).toHaveBeenCalledWith('inv-1');
    });
  });

  test('a scheduling failure after cancel is NOT acknowledged as success (codex r11 P1)', async () => {
    db.followupsQB.first.mockResolvedValue(null); // no sequence → schedule path
    const FollowUps = require('../services/invoice-followups');
    FollowUps.scheduleForInvoice.mockRejectedValueOnce(new Error('db down'));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.alreadyCancelled).toBe(true);
      expect(body.error).toMatch(/retry the cancel/i);
    });
  });

  test('a sequence an admin stopped for an UNRELATED reason stays stopped after cancel (codex r2 P1)', async () => {
    db.followupsQB.first.mockResolvedValue({ id: 'seq-1', status: 'stopped', stopped_reason: 'admin_stop' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(200);
      const FollowUps = require('../services/invoice-followups');
      expect(FollowUps.resumeSequence).not.toHaveBeenCalled();
    });
  });

  test('retrying after a committed cancel re-arms the sequence instead of 409ing (idempotent)', async () => {
    // First lookup (active) → none; second lookup (latest cancelled) → the plan.
    trxPlans.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...CANCELLED_PLAN, cancelled_at: new Date() });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alreadyCancelled).toBe(true);
      // No second cancel write — but the re-arm runs again for the retry.
      expect(trxPlans.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'cancelled', id: 'plan-1' });
      expect(trxPlans.update).not.toHaveBeenCalled();
      const FollowUps = require('../services/invoice-followups');
      expect(FollowUps.resumeSequence).toHaveBeenCalledWith('inv-1', expect.anything());
    });
  });

  test('a stale cancel naming plan A never cancels replacement plan B (codex r10 P1)', async () => {
    // Active lookup conditioned on the expected id finds nothing (B is
    // active, A is cancelled); the retry probe returns A → alreadyCancelled.
    trxPlans.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...CANCELLED_PLAN, cancelled_at: new Date() });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alreadyCancelled).toBe(true);
      // Both probes were conditioned on the EXPECTED plan id.
      expect(trxPlans.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'active', id: 'plan-1' });
      expect(trxPlans.where).toHaveBeenCalledWith({ invoice_id: 'inv-1', status: 'cancelled', id: 'plan-1' });
      expect(trxPlans.update).not.toHaveBeenCalled();
    });
  });

  test('400 when paymentPlanId is missing — cancel must name the exact plan (codex r12 P1)', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(trxPlans.update).not.toHaveBeenCalled();
    });
  });

  test('409 when the invoice has no active plan', async () => {
    trxPlans.first.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(409);
      expect(trxPlans.update).not.toHaveBeenCalled();
    });
  });

  test('404 when the invoice does not exist', async () => {
    trxInvoices.first.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/payment-plan/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlanId: 'plan-1' }),
      });
      expect(res.status).toBe(404);
      expect(trxPlans.update).not.toHaveBeenCalled();
    });
  });
});
