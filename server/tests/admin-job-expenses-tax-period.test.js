/**
 * Job expenses (ExpenseCapture) used to insert `expenses` rows with an
 * expense_date but no tax_year/quarter, so they counted in job costing and
 * P&L (expense_date filters) yet were invisible to the tax dashboard,
 * 1040-ES estimate, tax advisor and IB tax tools (tax_year filters).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { inserted: [], updates: [], existing: null };

function expensesBuilder() {
  const b = {
    where: jest.fn(() => b),
    first: jest.fn(() => Promise.resolve(state.existing)),
    update: jest.fn((u) => { state.updates.push(u); return Promise.resolve(1); }),
    insert: jest.fn((row) => { state.inserted.push(row); return b; }),
    returning: jest.fn(() => Promise.resolve([{ id: 'exp-1', ...state.inserted[state.inserted.length - 1] }])),
  };
  return b;
}
const mockDb = jest.fn(() => expensesBuilder());
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(() => Promise.resolve()) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const router = require('../routes/admin-job-expenses');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/job-expenses', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { state.inserted = []; state.updates = []; state.existing = { id: 'exp-1', scheduled_service_id: 'ss-1' }; });

const send = (method, path, body) => fetch(`${baseUrl}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /admin/job-expenses', () => {
  test('derives tax_year/quarter from expense_date', async () => {
    const res = await send('POST', '/admin/job-expenses', { scheduled_service_id: 'ss-1', amount: 12.5, expense_date: '2026-04-01' });
    expect(res.status).toBe(200);
    expect(state.inserted[0]).toMatchObject({ expense_date: '2026-04-01', tax_year: '2026', quarter: 'Q2' });
  });

  test('defaults expense_date to today (ET) and still sets the period', async () => {
    const res = await send('POST', '/admin/job-expenses', { scheduled_service_id: 'ss-1', amount: 5 });
    expect(res.status).toBe(200);
    const row = state.inserted[0];
    expect(row.expense_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.tax_year).toBe(row.expense_date.slice(0, 4));
    expect(row.quarter).toMatch(/^Q[1-4]$/);
  });

  test('400 on an invalid expense_date instead of a NaN period', async () => {
    const res = await send('POST', '/admin/job-expenses', { scheduled_service_id: 'ss-1', amount: 5, expense_date: 'garbage' });
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });
});

describe('PUT /admin/job-expenses/:id', () => {
  test('re-derives the period when expense_date changes', async () => {
    const res = await send('PUT', '/admin/job-expenses/exp-1', { expense_date: '2025-12-31', notes: 'x' });
    expect(res.status).toBe(200);
    expect(state.updates[0]).toEqual({ expense_date: '2025-12-31', tax_year: '2025', quarter: 'Q4', notes: 'x' });
  });

  test('leaves the period alone when expense_date is not supplied', async () => {
    const res = await send('PUT', '/admin/job-expenses/exp-1', { amount: 9 });
    expect(res.status).toBe(200);
    expect(state.updates[0]).toEqual({ amount: 9, tax_deductible_amount: 9 });
  });

  test('400 on an invalid expense_date', async () => {
    const res = await send('PUT', '/admin/job-expenses/exp-1', { expense_date: '2026-13-40' });
    expect(res.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });
});
