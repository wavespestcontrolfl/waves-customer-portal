/**
 * /admin/tax/worksheets (GATE_TAX_WORKSHEETS, nested under GATE_BANK_IMPORT):
 * the Sales tax (DR-15) and 1099s screens.
 *
 * Locked-down behaviors:
 *  1. Gate off (or GATE_BANK_IMPORT off) -> /worksheets/status answers
 *     {enabled:false}; /worksheets/sales-tax and /worksheets/1099 are 404s that
 *     touch nothing.
 *  2. Gate on -> both routes pass the query to the service and answer its
 *     shape; a service error keeps its status and message.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

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
// the router loads many services; no route in this suite may reach a table
const emptyChain = () => mockChain((kind) => (kind === 'first' ? undefined : []));
const mockDb = jest.fn(() => emptyChain());
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
// The service has its own suite; here the gate, the wiring and the error mapping.
jest.mock('../services/tax-worksheets', () => ({ salesTaxSheet: jest.fn(), form1099List: jest.fn() }));
const ws = require('../services/tax-worksheets');

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
const httpError = (status, message) => Object.assign(new Error(message), { status });

beforeEach(() => {
  mockDb.mockClear();
  ws.salesTaxSheet.mockReset();
  ws.form1099List.mockReset();
  process.env.GATE_BANK_IMPORT = 'true';
  delete process.env.GATE_TAX_WORKSHEETS;
});
afterAll(() => { delete process.env.GATE_BANK_IMPORT; delete process.env.GATE_TAX_WORKSHEETS; });

describe('gate darkness', () => {
  test('status answers enabled:false and both screens are 404s that touch nothing', async () => {
    expect(await (await get(`${P}/worksheets/status`)).json()).toEqual({ enabled: false });
    for (const path of ['/worksheets/sales-tax?kind=month&year=2026&index=9', '/worksheets/1099?year=2025']) {
      const res = await get(`${P}${path}`);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(mockDb).not.toHaveBeenCalled();
    expect(ws.salesTaxSheet).not.toHaveBeenCalled();
    expect(ws.form1099List).not.toHaveBeenCalled();
  });

  test('the worksheets gate alone is not enough without GATE_BANK_IMPORT', async () => {
    process.env.GATE_TAX_WORKSHEETS = 'true';
    delete process.env.GATE_BANK_IMPORT;
    expect(await (await get(`${P}/worksheets/status`)).json()).toEqual({ enabled: false });
    expect((await get(`${P}/worksheets/1099?year=2025`)).status).toBe(404);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_TAX_WORKSHEETS = 'true'; });

  test('status says enabled', async () => {
    expect(await (await get(`${P}/worksheets/status`)).json()).toEqual({ enabled: true });
  });

  test('sales tax passes the period query to the service and answers its sheet', async () => {
    ws.salesTaxSheet.mockResolvedValue({ period: { label: 'Sep 2026' }, lines: { amount_due: 50 } });
    const res = await get(`${P}/worksheets/sales-tax?kind=month&year=2026&index=9`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ period: { label: 'Sep 2026' }, lines: { amount_due: 50 } });
    expect(ws.salesTaxSheet).toHaveBeenCalledWith({ kind: 'month', year: '2026', index: '9' });
  });

  test('the 1099 list passes the year and answers the list', async () => {
    ws.form1099List.mockResolvedValue({ year: 2025, payees: [] });
    const res = await get(`${P}/worksheets/1099?year=2025`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ year: 2025, payees: [] });
    expect(ws.form1099List).toHaveBeenCalledWith('2025');
  });

  test('a service error keeps its status and message; anything else is a 500', async () => {
    ws.salesTaxSheet.mockRejectedValue(httpError(400, 'Nov 2026 has not started'));
    const bad = await get(`${P}/worksheets/sales-tax?kind=month&year=2026&index=11`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Nov 2026 has not started' });
    ws.form1099List.mockRejectedValue(new Error('boom'));
    expect((await get(`${P}/worksheets/1099?year=2025`)).status).toBe(500);
  });
});
