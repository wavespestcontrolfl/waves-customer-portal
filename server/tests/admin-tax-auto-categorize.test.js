/**
 * POST /admin/tax/expenses/auto-categorize — scope + partial-deduction policy.
 *
 * Two regressions this locks down:
 *  1. The batch used to sweep the OLDEST uncategorized expenses in the whole
 *     table while the Expenses tab counted its button from the loaded year,
 *     so a run could mutate rows the operator never saw and leave the
 *     visible backlog unchanged. Selection AND `remaining` must share scope.
 *  2. tax_deductible_amount used to move only when the MODEL returned an
 *     allowed deductiblePercent — a 50%-limited meal was deducted at 100%
 *     whenever the model omitted the field. The policy is server-owned and
 *     keyed by the matched category.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const CATEGORIES = [
  { id: 'cat-meals', name: 'Meals & Entertainment' },
  { id: 'cat-supplies', name: 'Supplies' },
];

// Chainable knex stub that RECORDS the scope of every terminal call, so the
// tests can assert the batch read and the remaining count were built from
// the same wheres.
const state = {
  rows: [],
  remaining: 0,
  selectScopes: [],
  countScopes: [],
  updates: [],
  inserted: [],
};

function expensesBuilder() {
  const scope = [];
  const b = {
    whereNull: jest.fn((c) => { scope.push(['whereNull', c]); return b; }),
    whereIn: jest.fn((c, v) => { scope.push(['whereIn', c, v]); return b; }),
    where: jest.fn((c, v) => { scope.push(['where', c, v]); return b; }),
    orderBy: jest.fn(() => b),
    limit: jest.fn((n) => { scope.push(['limit', n]); return b; }),
    count: jest.fn(() => { scope.push(['count']); return b; }),
    select: jest.fn(() => { state.selectScopes.push(scope.slice()); return Promise.resolve(state.rows); }),
    first: jest.fn(() => { state.countScopes.push(scope.slice()); return Promise.resolve({ n: state.remaining }); }),
    update: jest.fn((u) => { state.updates.push({ scope: scope.slice(), update: u }); return Promise.resolve(1); }),
    insert: jest.fn((row) => { state.inserted.push(row); return b; }),
    returning: jest.fn(() => Promise.resolve([{ id: 'exp-new' }])),
  };
  return b;
}

function categoriesBuilder() {
  let matchId = null;
  const b = {
    orderBy: jest.fn(() => Promise.resolve(CATEGORIES)),
    where: jest.fn((c) => { matchId = c?.id; return b; }),
    select: jest.fn(() => Promise.resolve(CATEGORIES)),
    first: jest.fn(() => Promise.resolve(CATEGORIES.find(c => c.id === matchId) || null)),
  };
  return b;
}

const mockDb = jest.fn((table) => (
  table === 'expense_categories' ? categoriesBuilder() : expensesBuilder()
));
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: jest.fn(() => new Date()) };
jest.mock('../models/db', () => mockDb);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// pnl-report / mileage are only imported for other routes in this file.
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(), getPeriodRange: jest.fn(), paidRevenueForWindow: jest.fn(),
  rateAsOf: jest.fn(), dateCellStr: jest.fn(), prorateAssetDepreciation: jest.fn(),
  outflowTransactionsQuery: jest.fn(),
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn() }));
jest.mock('../services/bouncie-mileage', () => ({
  getIrsRate: jest.fn(() => 0.725), computeDailySummary: jest.fn(), computeMonthlySummary: jest.fn(),
}));
jest.mock('../services/expense-categorizer', () => ({
  // Only the AI call is stubbed; the server-owned partial-deduction policy
  // (categoryDeductibleAmount + its allow-list) is the REAL implementation —
  // that policy is exactly what these tests assert.
  autoCategorizeExpense: jest.fn(),
  sanitizeDeductiblePercent: jest.requireActual('../services/expense-categorizer').sanitizeDeductiblePercent,
  categoryDeductibleAmount: jest.requireActual('../services/expense-categorizer').categoryDeductibleAmount,
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const { autoCategorizeExpense } = require('../services/expense-categorizer');
const taxRouter = require('../routes/admin-tax');

// Real listen + fetch round-trips (repo has no supertest at the root).
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

beforeEach(() => {
  jest.clearAllMocks();
  state.rows = [];
  state.remaining = 0;
  state.selectScopes = [];
  state.countScopes = [];
  state.updates = [];
  state.inserted = [];
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const AUTO = '/admin/tax/expenses/auto-categorize';

describe('auto-categorize scope', () => {
  test('rejects a non-array / empty / oversized ids payload', async () => {
    for (const ids of [{ 0: 'a' }, [], Array.from({ length: 501 }, (_, i) => `e${i}`)]) {
      const res = await post(AUTO, { ids });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/ids must be a non-empty array/);
    }
  });

  test('rejects a malformed year', async () => {
    const res = await post(AUTO, { year: '26' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/4-digit year/);
  });

  test('scopes selection AND remaining to the same year + ids', async () => {
    state.remaining = 3;
    const res = await post(AUTO, { year: '2026', ids: ['e1', 'e2'], limit: 20 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remaining).toBe(3);

    const [selectScope] = state.selectScopes;
    const [countScope] = state.countScopes;
    const wheres = (s) => s.filter(c => c[0] !== 'limit' && c[0] !== 'count');
    expect(wheres(selectScope)).toEqual([
      ['whereNull', 'category_id'],
      ['whereIn', 'id', ['e1', 'e2']],
      ['where', 'tax_year', '2026'],
    ]);
    // Identical scope — a globally-counted `remaining` is the bug.
    expect(wheres(countScope)).toEqual(wheres(selectScope));
  });

  test('no scope supplied keeps the whole-table behavior', async () => {
    const res = await post(AUTO, {});
    expect(res.status).toBe(200);
    const wheres = state.selectScopes[0].filter(c => c[0] !== 'limit');
    expect(wheres).toEqual([['whereNull', 'category_id']]);
  });
});

describe('auto-categorize partial deductions', () => {
  test('applies the 50% meals limitation from the CATEGORY even when the model omits deductiblePercent', async () => {
    state.rows = [{ id: 'e1', vendor_name: 'Cafe', description: 'Client lunch', amount: 100 }];
    autoCategorizeExpense.mockResolvedValue({
      categoryId: 'cat-meals', categoryName: 'meals & entertainment', reasoning: 'lunch',
    });

    const res = await post(AUTO, { year: '2026' });
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].update.category_id).toBe('cat-meals');
    expect(state.updates[0].update.tax_deductible_amount).toBe(50);
  });

  test('a model-claimed 100% cannot override the category policy', async () => {
    state.rows = [{ id: 'e1', vendor_name: 'Cafe', description: 'Client lunch', amount: 80 }];
    autoCategorizeExpense.mockResolvedValue({
      categoryId: 'cat-meals', categoryName: 'Meals & Entertainment', deductiblePercent: 100,
    });

    await post(AUTO, {});
    expect(state.updates[0].update.tax_deductible_amount).toBe(40);
  });

  test('a model-supplied 50% on a full-deduction category is ignored', async () => {
    state.rows = [{ id: 'e1', vendor_name: 'Chem Co', description: 'Talstar', amount: 210 }];
    autoCategorizeExpense.mockResolvedValue({
      categoryId: 'cat-supplies', categoryName: 'Supplies', deductiblePercent: 50,
    });

    await post(AUTO, {});
    // Not in the policy map = 100%: the amount is left alone entirely.
    expect(state.updates[0].update).not.toHaveProperty('tax_deductible_amount');
  });

  test('one expense failing never aborts the batch', async () => {
    state.rows = [
      { id: 'e1', vendor_name: 'A', description: 'a', amount: 10 },
      { id: 'e2', vendor_name: 'B', description: 'b', amount: 20 },
    ];
    autoCategorizeExpense
      .mockRejectedValueOnce(new Error('model down'))
      .mockResolvedValueOnce({ categoryId: 'cat-supplies', categoryName: 'Supplies' });

    const body = await (await post(AUTO, {})).json();
    expect(body.processed).toBe(2);
    expect(body.applied).toBe(1);
    expect(body.results[0]).toMatchObject({ id: 'e1', applied: false, error: 'model down' });
  });
});

describe('POST /expenses partial deductions', () => {
  test('a meals expense inserts at 50% without the model asserting a percent', async () => {
    autoCategorizeExpense.mockResolvedValue({
      categoryId: 'cat-meals', categoryName: 'Meals & Entertainment',
    });

    const res = await post('/admin/tax/expenses', {
      description: 'Client lunch', amount: 100, expenseDate: '2026-07-15', vendorName: 'Cafe',
    });
    expect(res.status).toBe(200);
    expect(state.inserted[0].tax_deductible_amount).toBe(50);
  });

  test('an operator-supplied deductibleAmount still wins', async () => {
    autoCategorizeExpense.mockResolvedValue({
      categoryId: 'cat-meals', categoryName: 'Meals & Entertainment',
    });

    await post('/admin/tax/expenses', {
      description: 'Client lunch', amount: 100, deductibleAmount: 30,
      expenseDate: '2026-07-15', vendorName: 'Cafe',
    });
    expect(state.inserted[0].tax_deductible_amount).toBe(30);
  });
});
