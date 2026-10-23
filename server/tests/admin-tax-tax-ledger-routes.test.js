/**
 * /admin/tax/bank-import/ledger/* routes (GATE_TAX_LEDGER, nested under
 * GATE_BANK_IMPORT).
 *
 * Locked-down behaviors:
 *  1. Bank import on but the ledger gate off → /ledger/status answers
 *     {enabled:false} without touching the table; every other ledger route
 *     is a 404 (dark means invisible).
 *  2. Gate on → status counts enabled rules, open rows (later and income
 *     shelves excluded) and the income shelf; the inbox pages with a
 *     clamped limit and open | later | income views.
 *  3. decide validates the id, hands the body to the service and maps the
 *     service's status errors (400/404/409) to the response.
 *  4. rules: list, create (201, owner priority by default), update, apply.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { counts: {}, rows: [], queries: [] };
function builder(table) {
  const q = { table, wheres: [], raws: [], limit: null, offset: null, orderBy: [] };
  state.queries.push(q);
  const b = {
    where: jest.fn((c) => { q.wheres.push(c); return b; }),
    whereRaw: jest.fn((sql) => { q.raws.push(sql); return b; }),
    count: jest.fn(() => b),
    first: jest.fn(() => Promise.resolve({ n: String(state.counts[table] ?? 0) })),
    orderBy: jest.fn((c, d) => { q.orderBy.push([c, d]); return b; }),
    limit: jest.fn((n) => { q.limit = n; return b; }),
    offset: jest.fn((n) => { q.offset = n; return b; }),
    select: jest.fn(() => Promise.resolve(state.rows)),
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql, bindings) => (bindings ? { sql, bindings } : sql));
mockDb.fn = { now: jest.fn(() => new Date()) };
mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(), getPeriodRange: jest.fn(), paidRevenueForWindow: jest.fn(),
  rateAsOf: jest.fn(), prorateAssetDepreciation: jest.fn(), annotateMidQuarter: jest.fn(),
  outflowTransactionsQuery: jest.fn(),
  dateCellStr: jest.requireActual('../services/pnl-report').dateCellStr,
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn(), invoiceWithdrawnFromCustomer: () => false }));
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn(() => Promise.resolve({})) }));
jest.mock('../services/expense-categorizer', () => ({
  autoCategorizeExpense: jest.fn(),
  sanitizeDeductiblePercent: jest.requireActual('../services/expense-categorizer').sanitizeDeductiblePercent,
  categoryDeductibleAmount: jest.requireActual('../services/expense-categorizer').categoryDeductibleAmount,
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  runDeterministicMatching: jest.fn(() => Promise.resolve({ scanned: 0 })),
}));
// The service has its own suite; the route test asserts the wiring, the gate
// and the error mapping. isOn stays real so the gate reads the env.
jest.mock('../services/tax-ledger-rules', () => ({
  ...jest.requireActual('../services/tax-ledger-rules'),
  decide: jest.fn(), listRules: jest.fn(), createRule: jest.fn(), updateRule: jest.fn(), applyRules: jest.fn(),
}));
const ledger = require('../services/tax-ledger-rules');

const express = require('express');
const taxRouter = require('../routes/admin-tax');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const P = '/admin/tax/bank-import/ledger';
const get = (path) => fetch(`${baseUrl}${path}`);
const send = (method, path, body) => fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const httpError = (status, message) => Object.assign(new Error(message), { status });

beforeEach(() => {
  Object.assign(state, { counts: {}, rows: [], queries: [] });
  mockDb.mockClear();
  for (const fn of ['decide', 'listRules', 'createRule', 'updateRule', 'applyRules']) ledger[fn].mockReset();
  process.env.GATE_BANK_IMPORT = 'true';
  delete process.env.GATE_TAX_LEDGER;
});

describe('gate darkness (bank import on, ledger off)', () => {
  test('status answers enabled:false without touching the table', async () => {
    const res = await get(`${P}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(mockDb).not.toHaveBeenCalled();
  });
  test('every other ledger route is a 404', async () => {
    for (const [method, path] of [['GET', `${P}/inbox`], ['POST', `${P}/decide`], ['GET', `${P}/rules`], ['POST', `${P}/rules`], ['PUT', `${P}/rules/r1`], ['POST', `${P}/rules/apply`]]) {
      const res = method === 'GET' ? await get(path) : await send(method, path, { id: 'x' });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(ledger.decide).not.toHaveBeenCalled();
  });
  test('bank import off hides the ledger too, status included', async () => {
    delete process.env.GATE_BANK_IMPORT; process.env.GATE_TAX_LEDGER = 'true';
    expect((await get(`${P}/status`)).status).toBe(404);
    expect((await get(`${P}/inbox`)).status).toBe(404);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_TAX_LEDGER = 'true'; });

  test('status counts enabled rules and open rows, later rows excluded', async () => {
    state.counts = { tax_ledger_rules: 37, bank_transactions: 12 };
    const res = await get(`${P}/status`);
    expect(await res.json()).toEqual({ enabled: true, rules: 37, inbox: 12, income: 12, bankImport: 12, unexamined: 12 });
    const rules = state.queries.find((q) => q.table === 'tax_ledger_rules');
    expect(rules.wheres).toContainEqual({ enabled: true });
    const [open, income, bankImport, unexamined] = state.queries.filter((q) => q.table === 'bank_transactions');
    expect(unexamined.raws).toContainEqual(ledger.VIEW_SQL.unexamined);
    expect(open.wheres).toContainEqual({ status: 'unmatched' });
    expect(open.raws).toEqual(expect.arrayContaining([expect.stringContaining('plaidModified'), ledger.VIEW_SQL.open]));
    expect(income.raws).toContainEqual(ledger.VIEW_SQL.income);
    expect(bankImport.raws).toContainEqual(ledger.VIEW_SQL.bankImport);
  });

  test('inbox pages open rows newest first with a clamped limit; view=later flips the filter', async () => {
    state.counts = { bank_transactions: 3 };
    state.rows = [{ id: 'b1', txn_date: '2026-10-20', description: 'WAWA', amount: '41.10', direction: 'debit', suggestion: null }];
    let res = await get(`${P}/inbox?limit=999&offset=-4`);
    expect(await res.json()).toEqual({ rows: state.rows, total: 3, limit: 200, offset: 0, view: 'open' });
    let page = state.queries.filter((q) => q.table === 'bank_transactions').pop();
    expect(page.limit).toBe(200); expect(page.offset).toBe(0);
    expect(page.orderBy[0]).toEqual(['txn_date', 'desc']);
    expect(page.raws).toContainEqual(ledger.VIEW_SQL.open);
    state.queries = [];
    res = await get(`${P}/inbox?view=later&limit=10&offset=20`);
    expect((await res.json()).view).toBe('later');
    page = state.queries.filter((q) => q.table === 'bank_transactions').pop();
    expect(page.limit).toBe(10); expect(page.offset).toBe(20);
    expect(page.raws).toContainEqual(ledger.VIEW_SQL.later);
    state.queries = [];
    res = await get(`${P}/inbox?view=income`);
    expect((await res.json()).view).toBe('income');
    expect(state.queries.filter((q) => q.table === 'bank_transactions').pop().raws).toContainEqual(ledger.VIEW_SQL.income);
    res = await get(`${P}/inbox?view=whatever`);
    expect((await res.json()).view).toBe('open');
  });

  test('decide needs an id, hands the body to the service and maps its status errors', async () => {
    let res = await send('POST', `${P}/decide`, { decision: 'personal' });
    expect(res.status).toBe(400);
    expect(ledger.decide).not.toHaveBeenCalled();
    ledger.decide.mockResolvedValueOnce({ success: true, action: 'ignored', ruleCreated: true });
    res = await send('POST', `${P}/decide`, { id: 'b1', decision: 'personal', always: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, action: 'ignored', ruleCreated: true });
    expect(ledger.decide).toHaveBeenCalledWith({ id: 'b1', decision: 'personal', categoryId: null, always: true });
    ledger.decide.mockRejectedValueOnce(httpError(409, 'only an open (unmatched) row can be decided'));
    res = await send('POST', `${P}/decide`, { id: 'b1', decision: 'income' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/open/);
  });

  test('rules: list, create at owner priority, update, apply', async () => {
    ledger.listRules.mockResolvedValueOnce([{ id: 'r1', pattern: 'wawa' }]);
    expect(await (await get(`${P}/rules`)).json()).toEqual({ rules: [{ id: 'r1', pattern: 'wawa' }] });

    ledger.createRule.mockResolvedValueOnce({ id: 'r2', pattern: 'siteone', kind: 'expense' });
    let res = await send('POST', `${P}/rules`, { pattern: 'siteone', kind: 'expense', categoryId: 'cat-s' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule: { id: 'r2', pattern: 'siteone', kind: 'expense' } });
    expect(ledger.createRule).toHaveBeenCalledWith({ pattern: 'siteone', kind: 'expense', categoryId: 'cat-s', note: null, priority: 10, source: 'owner' });
    ledger.createRule.mockRejectedValueOnce(httpError(400, 'an expense rule needs a categoryId'));
    res = await send('POST', `${P}/rules`, { pattern: 'siteone', kind: 'expense' });
    expect(res.status).toBe(400);

    ledger.updateRule.mockResolvedValueOnce({ id: 'r2', enabled: false });
    res = await send('PUT', `${P}/rules/r2`, { enabled: false });
    expect(await res.json()).toEqual({ rule: { id: 'r2', enabled: false } });
    expect(ledger.updateRule).toHaveBeenCalledWith('r2', { enabled: false });
    ledger.updateRule.mockRejectedValueOnce(httpError(404, 'rule not found'));
    expect((await send('PUT', `${P}/rules/ghost`, { enabled: false })).status).toBe(404);

    ledger.applyRules.mockResolvedValueOnce({ examined: 5, suggested: 2, byKind: { expense: 2 } });
    res = await send('POST', `${P}/rules/apply`, {});
    expect(await res.json()).toEqual({ success: true, examined: 5, suggested: 2, byKind: { expense: 2 } });
    // the manual pass re-examines every open row unless told otherwise
    expect(ledger.applyRules).toHaveBeenCalledWith({ limit: 5000, force: true, after: null });
    ledger.applyRules.mockResolvedValueOnce({ examined: 1, suggested: 0, byKind: {} });
    await send('POST', `${P}/rules/apply`, { force: false, limit: 100 });
    expect(ledger.applyRules).toHaveBeenLastCalledWith({ limit: 100, force: false, after: null });
    // continuation: the cursor from a previous answer; anything else is a 400
    ledger.applyRules.mockResolvedValueOnce({ examined: 1, suggested: 0, byKind: {}, more: false, cursor: null });
    res = await send('POST', `${P}/rules/apply`, { after: { txn_date: '2026-03-01T05:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' } });
    expect(res.status).toBe(200);
    expect(ledger.applyRules).toHaveBeenLastCalledWith({ limit: 5000, force: true, after: { txn_date: '2026-03-01', id: '11111111-1111-4111-8111-111111111111' } });
    res = await send('POST', `${P}/rules/apply`, { after: { txn_date: 'yesterday', id: '1 or 1=1' } });
    expect(res.status).toBe(400);
  });
});
