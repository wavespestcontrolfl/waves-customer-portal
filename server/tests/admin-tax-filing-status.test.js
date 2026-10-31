/**
 * PUT /admin/tax/filings/:id (owner 2026-10-30, tax deadline bells): status must be one the table uses, a
 * payroll row (source_key payroll:) needs a confirmation number to become filed or paid, a paid row with no
 * paid date gets today (ET), and a marked row's reminder bells close while GATE_TAX_DEADLINE_BELLS is on.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const updates = [];
const mockState = { row: null };
const mockDb = jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => mockState.row);
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
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn(), invoiceWithdrawnFromCustomer: jest.fn() }));
jest.mock('../services/expense-categorizer', () => ({ autoCategorizeExpense: jest.fn(), categoryDeductibleAmount: jest.fn() }));
jest.mock('../services/bouncie-mileage', () => ({ getIrsRate: jest.fn(() => 0.7) }));
jest.mock('../services/bank-import', () => ({}));
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn() }));
jest.mock('../services/tax-deadline-reminders', () => ({ closeBellsForFiling: jest.fn(async () => 1) }));

const express = require('express');
const { etDateString } = require('../utils/datetime-et');
const { closeBellsForFiling } = require('../services/tax-deadline-reminders');
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

const payrollRow = (over = {}) => ({ id: 'f1', source_key: 'payroll:941_deposit:2027-01', status: 'upcoming', amount_paid: '100', confirmation_number: null, paid_date: null, ...over });
const salesTaxRow = (over = {}) => ({ id: 'f1', source_key: null, status: 'upcoming', amount_paid: '100', confirmation_number: null, paid_date: null, ...over });

beforeEach(() => {
  updates.length = 0;
  mockState.row = payrollRow();
  closeBellsForFiling.mockClear();
  delete process.env.GATE_TAX_DEADLINE_BELLS;
});

const put = async (body) => {
  const res = await fetch(`${baseUrl}/admin/tax/filings/f1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('status', () => {
  test.each(['upcoming', 'prepared', 'filed', 'paid', 'late'])('%s is accepted on a row that needs no confirmation', async (status) => {
    mockState.row = salesTaxRow();
    expect((await put({ status })).status).toBe(200);
    expect(updates[0].status).toBe(status);
  });

  test.each(['Paid', 'done', '', 7, null])('%p is a 400 with no write', async (status) => {
    expect((await put({ status })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  test('a request without status is not checked', async () => {
    expect((await put({ notes: 'x' })).status).toBe(200);
  });
});

describe('confirmation number on a payroll row', () => {
  test.each(['filed', 'paid'])('%s with no confirmation anywhere is a 400', async (status) => {
    const res = await put({ status, amountPaid: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/confirmationNumber is required/);
    expect(updates).toHaveLength(0);
  });

  test('a blank confirmation is a 400; a request with one passes', async () => {
    expect((await put({ status: 'filed', confirmationNumber: '   ' })).status).toBe(400);
    expect((await put({ status: 'filed', confirmationNumber: 'EFT-1' })).status).toBe(200);
  });

  test('the stored confirmation number counts', async () => {
    mockState.row = payrollRow({ confirmation_number: 'EFT-OLD' });
    expect((await put({ status: 'paid', amountPaid: 50 })).status).toBe(200);
  });

  test('a row that is not payroll never needs one', async () => {
    mockState.row = salesTaxRow();
    expect((await put({ status: 'filed' })).status).toBe(200);
  });

  test('moving to a status that is not done needs none, even for payroll', async () => {
    expect((await put({ status: 'prepared' })).status).toBe(200);
  });

  test('an unknown row is a 404', async () => {
    mockState.row = undefined;
    expect((await put({ status: 'filed', confirmationNumber: 'EFT-1' })).status).toBe(404);
  });
});

describe('paid date', () => {
  test('paid with no paid date anywhere gets today ET', async () => {
    await put({ status: 'paid', amountPaid: 100, confirmationNumber: 'EFT-1' });
    expect(updates[0].paid_date).toBe(etDateString());
  });

  test('the request\'s paid date and a stored one are kept', async () => {
    await put({ status: 'paid', amountPaid: 100, confirmationNumber: 'EFT-1', paidDate: '2027-02-12' });
    expect(updates[0].paid_date).toBe('2027-02-12');
    updates.length = 0;
    mockState.row = payrollRow({ paid_date: '2027-02-10' });
    await put({ status: 'paid', amountPaid: 100, confirmationNumber: 'EFT-1' });
    expect(updates[0]).not.toHaveProperty('paid_date');
  });

  test('filed gets no paid date', async () => {
    await put({ status: 'filed', confirmationNumber: 'EFT-1' });
    expect(updates[0]).not.toHaveProperty('paid_date');
  });
});

describe('reminder bells', () => {
  test('gate off: nothing is closed', async () => {
    await put({ status: 'filed', confirmationNumber: 'EFT-1' });
    expect(closeBellsForFiling).not.toHaveBeenCalled();
  });

  test('gate on: marking filed or paid closes the row\'s bells; another status does not', async () => {
    process.env.GATE_TAX_DEADLINE_BELLS = 'true';
    await put({ status: 'filed', confirmationNumber: 'EFT-1' });
    expect(closeBellsForFiling).toHaveBeenCalledWith('f1');
    closeBellsForFiling.mockClear();
    await put({ status: 'prepared' });
    expect(closeBellsForFiling).not.toHaveBeenCalled();
  });
});
