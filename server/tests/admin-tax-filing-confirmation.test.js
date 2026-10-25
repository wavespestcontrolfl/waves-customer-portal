/**
 * PUT /admin/tax/filings/:id — the confirmation number (payroll layer 2): null
 * or text of at most 100 characters after trim, stored trimmed, blank stored
 * as null. Anything else is a 400 before the row is touched.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const updates = [];
const mockDb = jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => ({ id: 'f1', status: 'upcoming', amount_paid: null }));
  b.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
  return b;
});
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: jest.fn(() => 'now()') };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  requireAdmin: (_req, _res, next) => next(),
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: jest.fn(),
}));
jest.mock('../services/expense-categorizer', () => ({ autoCategorizeExpense: jest.fn(), categoryDeductibleAmount: jest.fn() }));
jest.mock('../services/bouncie-mileage', () => ({ getIrsRate: jest.fn(() => 0.7) }));
jest.mock('../services/bank-import', () => ({}));
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn() }));

const express = require('express');
const taxRouter = require('../routes/admin-tax');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { updates.length = 0; });

const put = async (body) => {
  const res = await fetch(`${baseUrl}/admin/tax/filings/f1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('PUT /admin/tax/filings/:id confirmationNumber', () => {
  test('stores the trimmed text', async () => {
    const res = await put({ status: 'filed', confirmationNumber: '  EFT-12345  ' });
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ status: 'filed', confirmation_number: 'EFT-12345' });
  });

  test('blank text and null are stored as null', async () => {
    expect((await put({ confirmationNumber: '   ' })).status).toBe(200);
    expect((await put({ confirmationNumber: null })).status).toBe(200);
    expect(updates.map((u) => u.confirmation_number)).toEqual([null, null]);
  });

  test('100 characters pass, 101 and non-text values get 400 with no write', async () => {
    expect((await put({ confirmationNumber: 'a'.repeat(100) })).status).toBe(200);
    updates.length = 0;
    expect((await put({ confirmationNumber: 'a'.repeat(101) })).status).toBe(400);
    expect((await put({ confirmationNumber: `  ${'a'.repeat(100)}  ` })).status).toBe(200);
    updates.length = 0;
    expect((await put({ confirmationNumber: 12345 })).status).toBe(400);
    expect((await put({ confirmationNumber: { id: 1 } })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  test('a request without confirmationNumber leaves the column out of the update', async () => {
    await put({ notes: 'sample' });
    expect(updates[0]).not.toHaveProperty('confirmation_number');
  });
});
