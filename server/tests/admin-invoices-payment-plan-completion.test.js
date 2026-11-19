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
// The Undo marker recordManualPayment writes with the payment (invoice-manual-payment-undo.js reads it back).
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
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
  lockCombinedCustomerStable: jest.fn(async (_trx, _invoiceId, customerId) => customerId),
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
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentPlanConfirmed: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/customer-credit', () => ({
  round2: (v) => Math.round((Number(v) || 0) * 100) / 100,
  getBalance: jest.fn(async () => 100),
  accountCreditSnapshotForInvoice: jest.fn(async () => ({ spendable: 500 })),
  spendableAccountCreditForInvoice: jest.fn(async ({ balance }) => Number(balance)),
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
  ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereNull', 'orWhereColumn', 'andWhere', 'whereExists', 'orderBy', 'orderByRaw', 'limit', 'forUpdate', 'noWait'].forEach((m) => {
    qb[m] = jest.fn((arg) => {
      if (['where', 'orWhere'].includes(m) && typeof arg === 'function') arg.call(qb, qb);
      return qb;
    });
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
  let trxPlans, trxCustomers, trxChargeAttempts;

  beforeEach(() => {
    jest.clearAllMocks();

    const paidRow = { ...INVOICE, status: 'paid' };
    trxInvoices = makeRecorder({
      // first('status') = completeActivePlansForInvoice's FOR UPDATE
      // settlement re-check — the same trx already flipped the row paid.
      first: jest.fn(async (...args) => (args[0] === 'status' ? { status: 'paid' } : { ...INVOICE })),
      update: jest.fn(() => ({ returning: jest.fn(async () => [paidRow]) })),
    });
    // The payments insert is chained to returning('id') so the Undo marker can name the ledger row.
    trxPayments = makeRecorder({ insert: jest.fn(() => Object.assign(Promise.resolve(1), { returning: jest.fn(async () => [{ id: 'pay-1' }]) })) });
    trxPlans = makeRecorder();
    trxCustomers = makeRecorder({
      first: jest.fn(async () => ({ id: INVOICE.customer_id, account_credits: 500 })),
    });
    trxChargeAttempts = makeRecorder();
    trx = jest.fn((table) => {
      if (table === 'invoices') return trxInvoices;
      if (table === 'payments') return trxPayments;
      if (table === 'payment_plans') return trxPlans;
      // apply-credit locks the customer (customer → visit lock order) before
      // the visit fence and the credit movement.
      if (table === 'customers') return trxCustomers;
      // completeActivePlansForInvoice also releases plan-owned dunning stops.
      if (table === 'invoice_followup_sequences') return makeRecorder();
      // The saved-card claim fence (assertNoInvoiceChargeReconciliationPending)
      // reads these two tables under the same lock as the paid/prepaid flip —
      // no claim/orphan fixtures here, so an empty first() clears the fence.
      if (table === 'stripe_invoice_charge_attempts') return trxChargeAttempts;
      if (table === 'stripe_orphan_charges') return makeRecorder();
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
      // Off-gateway settlement clears the pay-page PI stamp + stale processor
      // tag so the tax export never synthesizes a Stripe gap row beside the
      // manual ledger row (codex #3610 r3 P1).
      expect(trxInvoices.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'paid',
        stripe_payment_intent_id: null,
        processor: null,
      }));
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

  test("apply-credit refuses (409 visit_never_ran) when the invoice's visit is cancelled under the lock — no prepaid flip, no credit movement (#3878 r2 fence)", async () => {
    const withVisit = { ...INVOICE, scheduled_service_id: 'svc-1' };
    trxInvoices.first = jest.fn(async () => ({ ...withVisit }));
    const trxVisits = makeRecorder({ first: jest.fn(async () => ({ id: 'svc-1', status: 'cancelled' })) });
    const prev = trx.getMockImplementation();
    trx.mockImplementation((table) => (table === 'scheduled_services' ? trxVisits : prev(table)));
    db.mockImplementation((table) => {
      if (table === 'invoices') return makeRecorder({ first: jest.fn(async () => ({ ...withVisit })) });
      if (table === 'activity_log') return makeRecorder();
      throw new Error(`unexpected table ${table}`);
    });
    const lockOrder = [];
    trxCustomers.forUpdate.mockImplementation(() => { lockOrder.push('customers'); return trxCustomers; });
    trxVisits.forUpdate.mockImplementation(() => { lockOrder.push('scheduled_services'); return trxVisits; });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      expect(lockOrder).toEqual(['customers', 'scheduled_services']);
      const body = await res.json();
      expect(body.error).toMatch(/visit is cancelled/);
      expect(trxVisits.forUpdate).toHaveBeenCalled();
      expect(trxInvoices.update).not.toHaveBeenCalled();
      expect(trx).not.toHaveBeenCalledWith('payment_plans');
    });
  });

  test('credit application preserves a stamped checkout when the saved card is still awaiting verification', async () => {
    const original = db.getMockImplementation();
    const stamped = makeRecorder({ first: jest.fn(async () => ({ ...INVOICE, stripe_payment_intent_id: 'pi_stamped' })) });
    const pending = makeRecorder({ first: jest.fn(async () => ({ id: 'attempt-auth', status: 'failed' })) });
    db.mockImplementation((table) => {
      if (table === 'invoices') return stamped;
      if (table === 'stripe_invoice_charge_attempts') return pending;
      return original(table);
    });
    const stripe = require('../services/stripe');
    const lookup = jest.spyOn(stripe, 'retrievePaymentIntent');
    try {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(409);
        expect((await response.json()).error).toMatch(/awaiting verification/);
      });
      expect(lookup).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(require('../services/customer-credit').postCreditMovement).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  test('a saved-card claim that appears after apply-credit preflight refuses under the invoice lock before checkout retirement', async () => {
    const stampedInvoice = { ...INVOICE, stripe_payment_intent_id: 'pi_stamped' };
    const original = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'invoices') return makeRecorder({ first: jest.fn(async () => ({ ...stampedInvoice })) });
      // Pool preflight is clear; the transaction fixture below sees the raced claim.
      if (table === 'stripe_invoice_charge_attempts' || table === 'stripe_orphan_charges' || table === 'payments') return makeRecorder();
      return original(table);
    });
    trxInvoices.first.mockResolvedValue({ ...stampedInvoice });
    trxChargeAttempts.first.mockResolvedValueOnce({
      id: 'attempt-raced',
      status: 'failed',
      decline_code: 'authentication_required',
      resolved_at: new Date(),
      stripe_payment_intent_id: 'pi_saved_card',
    });
    const stripe = require('../services/stripe');
    const retrieve = jest.spyOn(stripe, 'retrievePaymentIntent');
    const cancel = jest.spyOn(stripe, 'cancelPaymentIntent');
    try {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const body = await response.json();
        expect({ status: response.status, error: body.error }).toEqual({
          status: 409,
          error: expect.stringMatching(/awaiting verification.*resolve it before applying credit/i),
        });
      });
      expect(trxInvoices.forUpdate).toHaveBeenCalled();
      expect(require('../services/pay-combined').lockCombinedCustomerStable)
        .toHaveBeenCalledWith(trx, 'inv-1', 'cust-1');
      expect(require('../services/pay-combined').lockCombinedCustomerStable.mock.invocationCallOrder[0])
        .toBeLessThan(trxCustomers.forUpdate.mock.invocationCallOrder[0]);
      expect(trxCustomers.forUpdate.mock.invocationCallOrder[0])
        .toBeLessThan(trxInvoices.forUpdate.mock.invocationCallOrder[0]);
      expect(trxInvoices.forUpdate.mock.invocationCallOrder[0])
        .toBeLessThan(trxChargeAttempts.where.mock.invocationCallOrder[0]);
      expect(retrieve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(require('../services/pay-combined').releaseCombinedSessionBeforeCollection).not.toHaveBeenCalled();
      expect(require('../services/customer-credit').postCreditMovement).not.toHaveBeenCalled();
      expect(trxInvoices.update).not.toHaveBeenCalled();
    } finally {
      retrieve.mockRestore();
      cancel.mockRestore();
    }
  });

  test('credit spent after preflight leaves the customer checkout available', async () => {
    const stampedInvoice = { ...INVOICE, stripe_payment_intent_id: 'pi_customer_checkout' };
    const original = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'invoices') return makeRecorder({ first: jest.fn(async () => stampedInvoice) });
      if (['stripe_invoice_charge_attempts', 'stripe_orphan_charges', 'payments'].includes(table)) return makeRecorder();
      return original(table);
    });
    trxInvoices.first.mockResolvedValue(stampedInvoice);
    trxCustomers.first.mockResolvedValue({ id: INVOICE.customer_id, account_credits: '25.00' });
    const stripe = require('../services/stripe');
    const retrieve = jest.spyOn(stripe, 'retrievePaymentIntent').mockResolvedValue({ status: 'requires_payment_method' });
    const cancel = jest.spyOn(stripe, 'cancelPaymentIntent').mockResolvedValue({ status: 'canceled' });
    try {
      await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatch(/Insufficient account credit.*\$25\.00.*\$100\.00/i);
      });
      expect(trxCustomers.forUpdate).toHaveBeenCalled();
      expect(trxCustomers.first).toHaveBeenCalledWith('id', 'account_credits');
      expect(retrieve).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(require('../services/pay-combined').releaseCombinedSessionBeforeCollection).not.toHaveBeenCalled();
      expect(require('../services/customer-credit').postCreditMovement).not.toHaveBeenCalled();
      expect(trxInvoices.update).not.toHaveBeenCalled();
    } finally {
      retrieve.mockRestore();
      cancel.mockRestore();
    }
  });

  test('apply-credit returns 409 when a potentially settling card payment is found under the invoice lock', async () => {
    trxChargeAttempts.first.mockResolvedValueOnce({
      id: 'attempt-auth-1',
      status: 'failed',
      decline_code: 'authentication_required',
      resolved_at: new Date(),
      stripe_payment_intent_id: 'pi_auth_1',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'An earlier card payment is awaiting verification. Please contact us before trying again. — resolve it before applying credit',
      });
      expect(trxChargeAttempts.where).toHaveBeenCalledWith({
        'stripe_invoice_charge_attempts.status': 'failed',
        'stripe_invoice_charge_attempts.decline_code': 'authentication_required',
      });
      expect(require('../services/customer-credit').postCreditMovement).not.toHaveBeenCalled();
      expect(trxInvoices.update).not.toHaveBeenCalled();
      expect(trx).not.toHaveBeenCalledWith('payment_plans');
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

  test('apply-credit leaves another invoice\'s unposted saved-card allocation reserved', async () => {
    const CustomerCredit = require('../services/customer-credit');
    trxCustomers.first.mockResolvedValue({ id: INVOICE.customer_id, account_credits: 100 });
    CustomerCredit.spendableAccountCreditForInvoice.mockResolvedValueOnce(75);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Insufficient account credit. $75.00 is available for this invoice, which needs $100.00.',
      });
      expect(CustomerCredit.spendableAccountCreditForInvoice).toHaveBeenCalledWith({
        customerId: INVOICE.customer_id,
        invoiceId: INVOICE.id,
        balance: 100,
      }, trx);
      expect(CustomerCredit.postCreditMovement).not.toHaveBeenCalled();
      expect(trxInvoices.update).not.toHaveBeenCalled();
    });
  });

  test('the staff credit context reports the account balance while posting checks spendable credit before retiring a payment session', async () => {
    const CustomerCredit = require('../services/customer-credit');
    CustomerCredit.accountCreditSnapshotForInvoice.mockResolvedValueOnce({ spendable: 75 });

    await withServer(async (baseUrl) => {
      const preview = await fetch(`${baseUrl}/admin/invoices/inv-1/credit-context`);
      expect(preview.status).toBe(200);
      await expect(preview.json()).resolves.toMatchObject({ balance: 100, amount_due: 100 });
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/apply-credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Insufficient account credit. $75.00 is available for this invoice, which needs $100.00.',
      });
      expect(CustomerCredit.accountCreditSnapshotForInvoice).toHaveBeenCalledWith({
        customerId: INVOICE.customer_id,
        invoiceId: INVOICE.id,
      }, db);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(CustomerCredit.postCreditMovement).not.toHaveBeenCalled();
    });
  });
});
