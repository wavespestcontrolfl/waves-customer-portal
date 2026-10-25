/**
 * /admin/tax/shared-bills, /home-office and the create-expense hook
 * (GATE_TAX_SHARED_BILLS, nested under GATE_BANK_IMPORT).
 *
 * Locked-down behaviors:
 *  1. Gate off → /shared-bills/status answers {enabled:false}; every other
 *     route is a 404 and touches no table.
 *  2. Gate on → CRUD hands the body to the service and maps its status
 *     errors; /home-office/:year returns the row plus the computed deduction,
 *     or {year,row:null,deduction:0}.
 *  3. create-expense with the gate on and a matching bill books the business
 *     share (after the category's own partial rule), notes the share and takes
 *     the bill's category only when nothing else chose one. Gate off, the
 *     expense is byte-for-byte what it was.
 *  4. The tax package adds home-office.csv and shared-bills.csv only when on.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { bankRow: null, category: null, insertedExpenses: [], claimUpdates: [], touched: [] };
function mockChain(resolveWith) {
  const b = new Proxy(function chainable() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(resolveWith('then')).then(res, rej);
      if (prop === 'first') return () => Promise.resolve(resolveWith('first'));
      return () => b;
    },
    apply() { return b; },
  });
  return b;
}
const emptyChain = () => mockChain((kind) => (kind === 'first' ? undefined : []));
function table(name) {
  state.touched.push(name);
  if (name === 'bank_transactions') {
    const b = {
      where: jest.fn(() => b),
      whereRaw: jest.fn(() => b),
      first: jest.fn(() => Promise.resolve(state.bankRow)),
      update: jest.fn((patch) => { state.claimUpdates.push(patch); return Promise.resolve(1); }),
    };
    return b;
  }
  if (name === 'expenses') {
    const b = {
      insert: jest.fn((row) => { state.insertedExpenses.push(row); return b; }),
      returning: jest.fn(() => Promise.resolve([{ id: 'exp-new', ...state.insertedExpenses[state.insertedExpenses.length - 1] }])),
    };
    // the tax package reads this table through a long chain: anything but the insert resolves to no rows
    return new Proxy(b, { get: (t, prop) => (prop in t ? t[prop] : prop === 'then' ? undefined : emptyChain) });
  }
  if (name === 'expense_categories') {
    return { where: jest.fn(() => ({ first: jest.fn(() => Promise.resolve(state.category)) })) };
  }
  return emptyChain();
}
const mockDb = jest.fn((name) => table(name));
mockDb.raw = jest.fn((sql, bindings) => (bindings ? { sql, bindings } : sql));
mockDb.fn = { now: jest.fn(() => new Date()) };
mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(() => Promise.resolve({})), getPeriodRange: jest.fn(), paidRevenueForWindow: jest.fn(),
  rateAsOf: jest.fn(), prorateAssetDepreciation: jest.fn(), annotateMidQuarter: jest.fn((x) => x),
  outflowTransactionsQuery: jest.fn(() => mockChain(() => [])),
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
  resetDanglingLinks: jest.fn(() => Promise.resolve(0)),
}));
// The service has its own suite; here the gate, the wiring and the error
// mapping. isOn / matchBill / shareOf / homeOfficeDeduction stay real.
jest.mock('../services/tax-shared-bills', () => ({
  ...jest.requireActual('../services/tax-shared-bills'),
  listBills: jest.fn(), loadEnabledBills: jest.fn(), createBill: jest.fn(), updateBill: jest.fn(), deleteBill: jest.fn(),
  getHomeOffice: jest.fn(), upsertHomeOffice: jest.fn(), deleteHomeOffice: jest.fn(),
}));
const sb = require('../services/tax-shared-bills');

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

const P = '/admin/tax';
const get = (path) => fetch(`${baseUrl}${path}`);
const send = (method, path, body) => fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
const httpError = (status, message) => Object.assign(new Error(message), { status });

const PHONE = { id: 'b-1', pattern: 'VERIZON', label: 'Phone plan', business_pct: 50, category_id: 'cat-phone', enabled: true };

beforeEach(() => {
  Object.assign(state, { bankRow: null, category: null, insertedExpenses: [], claimUpdates: [], touched: [] });
  mockDb.mockClear();
  for (const fn of ['listBills', 'loadEnabledBills', 'createBill', 'updateBill', 'deleteBill', 'getHomeOffice', 'upsertHomeOffice', 'deleteHomeOffice']) sb[fn].mockReset();
  process.env.GATE_BANK_IMPORT = 'true';
  delete process.env.GATE_TAX_SHARED_BILLS;
});
afterAll(() => { delete process.env.GATE_BANK_IMPORT; delete process.env.GATE_TAX_SHARED_BILLS; });

describe('gate darkness', () => {
  test('status answers enabled:false and every other route is a 404 that touches nothing', async () => {
    expect(await (await get(`${P}/shared-bills/status`)).json()).toEqual({ enabled: false, actual_method: false });
    const calls = [
      ['GET', '/shared-bills'], ['POST', '/shared-bills'], ['PUT', '/shared-bills/b-1'], ['DELETE', '/shared-bills/b-1'],
      ['GET', '/home-office/2026'], ['PUT', '/home-office/2026'], ['DELETE', '/home-office/2026'],
    ];
    for (const [method, path] of calls) {
      const res = await send(method, `${P}${path}`, {});
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(mockDb).not.toHaveBeenCalled();
    expect(sb.listBills).not.toHaveBeenCalled();
  });

  test('the shared-bills gate alone is not enough without GATE_BANK_IMPORT', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    delete process.env.GATE_BANK_IMPORT;
    expect(await (await get(`${P}/shared-bills/status`)).json()).toEqual({ enabled: false, actual_method: false });
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_TAX_SHARED_BILLS = 'true'; });

  test('status says enabled, and offers the actual method only with the return engine on too', async () => {
    expect(await (await get(`${P}/shared-bills/status`)).json()).toEqual({ enabled: true, actual_method: false });
    process.env.GATE_TAX_RETURN_ENGINE = 'true';
    expect(await (await get(`${P}/shared-bills/status`)).json()).toEqual({ enabled: true, actual_method: true });
    delete process.env.GATE_TAX_RETURN_ENGINE;
  });

  test('list, create (201), update and delete go through the service', async () => {
    sb.listBills.mockResolvedValue([PHONE]);
    expect(await (await get(`${P}/shared-bills`)).json()).toEqual({ bills: [PHONE] });
    sb.createBill.mockResolvedValue(PHONE);
    const created = await send('POST', `${P}/shared-bills`, { pattern: 'verizon', label: 'Phone plan', business_pct: 50 });
    expect(created.status).toBe(201);
    expect(sb.createBill).toHaveBeenCalledWith({ pattern: 'verizon', label: 'Phone plan', business_pct: 50 });
    sb.updateBill.mockResolvedValue({ ...PHONE, enabled: false });
    expect((await (await send('PUT', `${P}/shared-bills/b-1`, { enabled: false })).json()).bill.enabled).toBe(false);
    expect(sb.updateBill).toHaveBeenCalledWith('b-1', { enabled: false });
    sb.deleteBill.mockResolvedValue(true);
    expect(await (await send('DELETE', `${P}/shared-bills/b-1`)).json()).toEqual({ success: true });
  });

  test('a service error keeps its status and message', async () => {
    sb.createBill.mockRejectedValue(httpError(400, 'business_pct must be a number from 0 to 100'));
    const res = await send('POST', `${P}/shared-bills`, { business_pct: '50junk' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/business_pct/);
    sb.updateBill.mockRejectedValue(httpError(404, 'shared bill not found'));
    expect((await send('PUT', `${P}/shared-bills/zzz`, { label: 'x' })).status).toBe(404);
    sb.deleteBill.mockRejectedValue(httpError(404, 'shared bill not found'));
    expect((await send('DELETE', `${P}/shared-bills/zzz`)).status).toBe(404);
  });

  test('an unexpected error is a 500, not a leaked status', async () => {
    sb.listBills.mockRejectedValue(new Error('db down'));
    expect((await get(`${P}/shared-bills`)).status).toBe(500);
  });

  test('home office: row plus computed deduction, or the empty answer', async () => {
    sb.getHomeOffice.mockResolvedValue({ tax_year: 2026, method: 'simplified', sq_ft: 300, months: 5, notes: null });
    expect(await (await get(`${P}/home-office/2026`)).json()).toMatchObject({ year: 2026, deduction: 625, row: { sq_ft: 300 } });
    sb.getHomeOffice.mockResolvedValue(null);
    expect(await (await get(`${P}/home-office/2026`)).json()).toEqual({ year: 2026, row: null, deduction: 0 });
  });

  test('home office save and remove', async () => {
    sb.upsertHomeOffice.mockResolvedValue({ tax_year: 2026, method: 'simplified', sq_ft: 300, months: 12, notes: null });
    const saved = await (await send('PUT', `${P}/home-office/2026`, { sq_ft: 300, months: 12 })).json();
    expect(saved).toMatchObject({ year: 2026, deduction: 1500 });
    expect(sb.upsertHomeOffice).toHaveBeenCalledWith('2026', { sq_ft: 300, months: 12 });
    sb.upsertHomeOffice.mockRejectedValue(httpError(400, 'sq_ft must be a whole number from 1 to 300'));
    expect((await send('PUT', `${P}/home-office/2026`, { sq_ft: 400 })).status).toBe(400);
    sb.deleteHomeOffice.mockResolvedValue(1);
    expect(await (await send('DELETE', `${P}/home-office/2026`)).json()).toEqual({ success: true });
  });
});

describe('create-expense hook', () => {
  const create = (body = {}) => send('POST', `${P}/bank-import/bt-1/create-expense`, body);
  beforeEach(() => {
    state.bankRow = {
      id: 'bt-1', account_label: 'test-checking', account_type: 'bank', txn_date: '2026-08-09',
      description: 'Withdrawal from VERIZON WIRELESS PAYMENT', amount: '200.01', direction: 'debit', status: 'unmatched', suggestion: null,
    };
    sb.loadEnabledBills.mockResolvedValue([PHONE]);
  });

  test('gate on + matching bill: half the amount, the bill note, the bill category', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    state.category = { name: 'Utilities' };
    const res = await create();
    expect(res.status).toBe(200);
    const exp = state.insertedExpenses[0];
    expect(exp.category_id).toBe('cat-phone');
    expect(exp.amount).toBe('200.01');
    expect(exp.tax_deductible_amount).toBe(100.01);
    expect(exp.notes).toBe('[Bank import test-checking] [Shared bill: Phone plan 50%]');
    expect(exp.notes).not.toContain('AI-categorized');
  });

  test('the operator pick wins over the bill category, and a category partial rule applies first', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    state.category = { name: 'Meals & Entertainment' };
    await create({ categoryId: 'cat-meals' });
    const exp = state.insertedExpenses[0];
    expect(exp.category_id).toBe('cat-meals');
    // meals 50% of 200.01 = 100 (the categorizer's own rounding), then the 50% share
    expect(exp.tax_deductible_amount).toBe(50);
  });

  test('a visible suggestion keeps its category and the AI-verify note beside the share note', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    state.category = { name: 'Utilities' };
    state.bankRow.suggestion = { categoryId: 'cat-sug', categoryName: 'Utilities' };
    await create();
    const exp = state.insertedExpenses[0];
    expect(exp.category_id).toBe('cat-sug');
    expect(exp.notes).toBe('[Bank import test-checking] [AI-categorized — verify] [Shared bill: Phone plan 50%]');
  });

  test('gate on but no bill matches: unchanged', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    state.bankRow.description = 'ACME HARDWARE 123';
    state.category = { name: 'Supplies' };
    await create({ categoryId: 'cat-sup' });
    const exp = state.insertedExpenses[0];
    expect(exp.tax_deductible_amount).toBe(200.01);
    expect(exp.notes).toBe('[Bank import test-checking]');
  });

  test('gate off: the full amount, no bill read, no note, no bill category', async () => {
    state.category = null;
    const res = await create();
    expect(res.status).toBe(200);
    const exp = state.insertedExpenses[0];
    expect(exp.category_id).toBeNull();
    expect(exp.tax_deductible_amount).toBe(200.01);
    expect(exp.notes).toBe('[Bank import test-checking]');
    expect(sb.loadEnabledBills).not.toHaveBeenCalled();
  });
});

describe('tax package', () => {
  const zipNames = async () => {
    const res = await get(`${P}/export/tax-package?year=2026`);
    if (res.status !== 200) throw new Error(await res.text());
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    return ['pnl.csv', 'expenses.csv', 'home-office.csv', 'shared-bills.csv'].filter((n) => text.includes(n));
  };

  test('gate off: neither file', async () => {
    expect(await zipNames()).toEqual(['pnl.csv', 'expenses.csv']);
    expect(sb.getHomeOffice).not.toHaveBeenCalled();
  });

  test('gate on: both files when the year has a home office and bills exist', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    sb.getHomeOffice.mockResolvedValue({ tax_year: 2026, method: 'simplified', sq_ft: 300, months: 12 });
    sb.listBills.mockResolvedValue([{ ...PHONE, category_name: 'Utilities' }]);
    expect(await zipNames()).toEqual(['pnl.csv', 'expenses.csv', 'home-office.csv', 'shared-bills.csv']);
  });

  test('gate on, nothing saved: no extra file', async () => {
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    sb.getHomeOffice.mockResolvedValue(null);
    sb.listBills.mockResolvedValue([]);
    expect(await zipNames()).toEqual(['pnl.csv', 'expenses.csv']);
  });
});
