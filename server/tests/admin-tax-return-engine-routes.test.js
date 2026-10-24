/**
 * /admin/tax/tax-years and /return-engine/status (GATE_TAX_RETURN_ENGINE,
 * nested under GATE_BANK_IMPORT).
 *
 * Locked-down behaviors:
 *  1. Gate off (or GATE_BANK_IMPORT off) -> /return-engine/status answers
 *     {enabled:false}; every /tax-years route is a 404 and touches nothing.
 *  2. Gate on -> list, detail, save, file, unfile and return go to the
 *     services; a service error keeps its status and message; anything else is
 *     a 500.
 *  3. PUT refuses bad numbers and unknown fields with a 400 before any write;
 *     filing a filed year and editing a filed year are 409s; the return
 *     endpoint answers the engine's shape and a 400 for a year with no constants.
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
// The services have their own suites; here the gate, the wiring and the error
// mapping. Validation inside tax-years stays real where a test says so.
jest.mock('../services/tax-years', () => ({
  ...jest.requireActual('../services/tax-years'),
  listYears: jest.fn(), getYearDetail: jest.fn(), upsertYear: jest.fn(), unmarkFiled: jest.fn(),
}));
jest.mock('../services/tax-return-engine', () => ({ computeYear: jest.fn(), fileYear: jest.fn() }));
const ty = require('../services/tax-years');
const engine = require('../services/tax-return-engine');
const realTaxYears = jest.requireActual('../services/tax-years');

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

const DETAIL = (extra = {}) => ({
  year: 2025, exists: true,
  row: { tax_year: 2025, filing_status: 'single', status: 'draft', filed_on: null, other_income: 0, estimates_paid: 0, nol_in: 0, qbi_loss_in: 0, sec179_carry_in: 0, home_office_carry_in: 0, notes: null },
  carry_in: { nol: { value: 0, source: 'none', from_year: null } },
  ...extra,
});

beforeEach(() => {
  mockDb.mockClear();
  for (const fn of [ty.listYears, ty.getYearDetail, ty.upsertYear, ty.unmarkFiled, engine.computeYear, engine.fileYear]) fn.mockReset();
  process.env.GATE_BANK_IMPORT = 'true';
  delete process.env.GATE_TAX_RETURN_ENGINE;
});
afterAll(() => { delete process.env.GATE_BANK_IMPORT; delete process.env.GATE_TAX_RETURN_ENGINE; });

describe('gate darkness', () => {
  test('status answers enabled:false and every other route is a 404 that touches nothing', async () => {
    expect(await (await get(`${P}/return-engine/status`)).json()).toEqual({ enabled: false });
    const calls = [
      ['GET', '/tax-years'], ['GET', '/tax-years/2025'], ['PUT', '/tax-years/2025'], ['POST', '/tax-years/2025/file'],
      ['POST', '/tax-years/2025/unfile'], ['GET', '/tax-years/2025/return'],
    ];
    for (const [method, path] of calls) {
      const res = await send(method, `${P}${path}`, {});
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(mockDb).not.toHaveBeenCalled();
    for (const fn of [ty.listYears, ty.getYearDetail, ty.upsertYear, ty.unmarkFiled, engine.computeYear, engine.fileYear]) expect(fn).not.toHaveBeenCalled();
  });

  test('the engine gate alone is not enough without GATE_BANK_IMPORT', async () => {
    process.env.GATE_TAX_RETURN_ENGINE = 'true';
    delete process.env.GATE_BANK_IMPORT;
    expect(await (await get(`${P}/return-engine/status`)).json()).toEqual({ enabled: false });
    expect((await get(`${P}/tax-years`)).status).toBe(404);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_TAX_RETURN_ENGINE = 'true'; });

  test('status says enabled', async () => {
    expect(await (await get(`${P}/return-engine/status`)).json()).toEqual({ enabled: true });
  });

  test('list answers the years and the years with constants', async () => {
    ty.listYears.mockResolvedValue([{ tax_year: 2025, status: 'draft' }]);
    expect(await (await get(`${P}/tax-years`)).json()).toEqual({ years: [{ tax_year: 2025, status: 'draft' }], supported_years: [2024, 2025, 2026] });
  });

  test('detail adds whether the constants for the year are loaded', async () => {
    ty.getYearDetail.mockResolvedValue(DETAIL());
    expect(await (await get(`${P}/tax-years/2025`)).json()).toMatchObject({ year: 2025, constants_loaded: true });
    ty.getYearDetail.mockResolvedValue(DETAIL({ year: 2023 }));
    expect((await (await get(`${P}/tax-years/2023`)).json()).constants_loaded).toBe(false);
  });

  test('save hands the body to the service and answers the year detail', async () => {
    ty.upsertYear.mockResolvedValue({});
    ty.getYearDetail.mockResolvedValue(DETAIL());
    const res = await send('PUT', `${P}/tax-years/2025`, { other_income: '1200', filing_status: 'mfj' });
    expect(res.status).toBe(200);
    expect(ty.upsertYear).toHaveBeenCalledWith('2025', { other_income: '1200', filing_status: 'mfj' });
    expect((await res.json()).row.tax_year).toBe(2025);
  });

  test('save refuses a bad number, an unknown field and a bad status with a 400 before any write', async () => {
    ty.upsertYear.mockImplementation(realTaxYears.upsertYear);
    for (const body of [{ other_income: '50junk' }, { nol_in: -1 }, { status: 'filed' }, { filing_status: 'mfs' }, {}]) {
      const res = await send('PUT', `${P}/tax-years/2025`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await send('PUT', `${P}/tax-years/abc`, { other_income: 1 })).status).toBe(400);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('editing a filed year is a 409', async () => {
    ty.upsertYear.mockRejectedValue(httpError(409, '2025 is marked filed: unmark it before changing it'));
    const res = await send('PUT', `${P}/tax-years/2025`, { other_income: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/marked filed/);
  });

  test('file freezes through the engine; a filed year is a 409; a body date goes along', async () => {
    engine.fileYear.mockResolvedValue({});
    ty.getYearDetail.mockResolvedValue(DETAIL({ row: { ...DETAIL().row, status: 'filed', filed_on: '2026-04-10' } }));
    const res = await send('POST', `${P}/tax-years/2025/file`, { filed_on: '2026-04-10' });
    expect(engine.fileYear).toHaveBeenCalledWith('2025', { filed_on: '2026-04-10' });
    expect((await res.json()).row.status).toBe('filed');
    engine.fileYear.mockRejectedValue(httpError(409, '2025 is already marked filed'));
    expect((await send('POST', `${P}/tax-years/2025/file`, {})).status).toBe(409);
    engine.fileYear.mockRejectedValue(httpError(400, 'tax constants for 2023 are not loaded'));
    expect((await send('POST', `${P}/tax-years/2023/file`, {})).status).toBe(400);
  });

  test('unfile: back to a draft, 409 when not filed, 404 when there is no record', async () => {
    ty.unmarkFiled.mockResolvedValue({});
    ty.getYearDetail.mockResolvedValue(DETAIL());
    expect((await (await send('POST', `${P}/tax-years/2025/unfile`)).json()).row.status).toBe('draft');
    ty.unmarkFiled.mockRejectedValue(httpError(409, '2025 is not marked filed'));
    expect((await send('POST', `${P}/tax-years/2025/unfile`)).status).toBe(409);
    ty.unmarkFiled.mockRejectedValue(httpError(404, 'no 2025 tax year record'));
    expect((await send('POST', `${P}/tax-years/2025/unfile`)).status).toBe(404);
  });

  test('return answers what the engine computes; a year with no constants is a 400', async () => {
    const result = { year: 2025, schedule_c: [{ line: '1', label: 'Gross receipts', amount: 10 }], total_tax: 0, owed: 0, carry_out: {}, warnings: [] };
    engine.computeYear.mockResolvedValue(result);
    expect(await (await get(`${P}/tax-years/2025/return`)).json()).toEqual(result);
    expect(engine.computeYear).toHaveBeenCalledWith('2025');
    engine.computeYear.mockRejectedValue(httpError(400, 'tax constants for 2023 are not loaded'));
    const res = await get(`${P}/tax-years/2023/return`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('tax constants for 2023 are not loaded');
  });

  test('an unexpected error is a 500, not a leaked status', async () => {
    engine.computeYear.mockRejectedValue(new Error('db down'));
    expect((await get(`${P}/tax-years/2025/return`)).status).toBe(500);
  });
});
