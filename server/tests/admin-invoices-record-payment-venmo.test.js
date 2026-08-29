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

const express = require('express');
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
