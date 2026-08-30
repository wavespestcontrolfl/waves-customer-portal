/**
 * POST /admin/invoices/:id/record-payment — Venmo is a named off-Stripe
 * tender (2026-08-29), so reports can tell it apart from 'other'. Pins the
 * method whitelist: 'venmo' passes validation; an unknown method is a 400
 * that lists every accepted tender.
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

jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => ({ status: 'canceled' })),
}));
jest.mock('../services/pay-combined', () => ({
  clearPaymentIntentStamps: jest.fn(async () => undefined),
  releaseCombinedSessionBeforeCollection: jest.fn(async () => undefined),
}));

const express = require('express');
const StripeService = require('../services/stripe');
const PayCombined = require('../services/pay-combined');
const db = require('../models/db');
const router = require('../routes/admin-invoices');

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

async function recordPayment(baseUrl, method) {
  return fetch(`${baseUrl}/admin/invoices/inv-404/record-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, sendReceipt: false }),
  });
}

describe('record-payment method whitelist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No invoice row: a method that passes validation reaches the lookup and 404s.
    db.mockImplementation((table) => {
      if (table === 'invoices') return makeRecorder();
      throw new Error(`unexpected table ${table}`);
    });
  });

  test.each(['venmo', 'paypal'])('%s passes method validation', async (method) => {
    await withServer(async (baseUrl) => {
      const res = await recordPayment(baseUrl, method);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Invoice not found' });
    });
  });

  test('an unknown method is rejected and the error lists every tender', async () => {
    await withServer(async (baseUrl) => {
      const res = await recordPayment(baseUrl, 'bitcoin');
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error).toBe('method must be one of: cash, check, zelle, venmo, paypal, other');
      expect(db).not.toHaveBeenCalled();
    });
  });
});

describe('record-payment retires an open pay-page PaymentIntent first (codex #3610 P1)', () => {
  const OPEN_INVOICE = {
    id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '150.00', credit_applied: 0,
    invoice_number: 'WPC-2026-0001', payer_id: null, payer_statement_id: null,
    stripe_payment_intent_id: 'pi_open_1', notes: null,
  };
  const SENTINEL = 'stop-before-trx';

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'invoices') return makeRecorder({ first: jest.fn(async () => ({ ...OPEN_INVOICE })) });
      throw new Error(`unexpected table ${table}`);
    });
    // The guard runs BEFORE the transaction; stop there so this suite pins
    // the guard alone (the paid-flip path is covered by the payment-plan suite).
    db.transaction.mockImplementation(async () => { throw new Error(SENTINEL); });
  });

  test('an unconfirmed PI is canceled and unstamped before the paid flip', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_open_1', status: 'requires_payment_method' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/record-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'zelle', sendReceipt: false }),
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe(SENTINEL);
    });
    expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_open_1', { cancellation_reason: 'abandoned' });
    expect(PayCombined.clearPaymentIntentStamps).toHaveBeenCalledWith(db, 'pi_open_1', { keepInvoiceIds: ['inv-1'] });
    expect(db.transaction).toHaveBeenCalled();
  });

  test.each(['processing', 'succeeded', 'requires_capture'])('money in flight (%s) refuses with 409 and never flips paid', async (status) => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_open_1', status });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/record-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'venmo', sendReceipt: false }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/already in flight/);
    });
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a NEW PI stamped between the pre-lock triage and the row lock refuses with 409 (codex r2 P1)', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_open_1', status: 'requires_payment_method' });
    const trxInvoices = makeRecorder({
      // Under the lock the invoice now carries a DIFFERENT PI — /setup won the seam.
      first: jest.fn(async () => ({ ...OPEN_INVOICE, stripe_payment_intent_id: 'pi_new_2' })),
    });
    const trx = jest.fn((table) => {
      if (table === 'invoices') return trxInvoices;
      throw new Error(`unexpected trx table ${table}`);
    });
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction.mockImplementation(async (cb) => cb(trx));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/record-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'zelle', sendReceipt: false }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/new payment session/);
    });
    expect(trxInvoices.forUpdate).toHaveBeenCalled();
    expect(trxInvoices.update).not.toHaveBeenCalled();
  });

  test('an unverifiable PI (Stripe unreachable) fails closed with 409', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/inv-1/record-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'paypal', sendReceipt: false }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/could not be verified/);
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
