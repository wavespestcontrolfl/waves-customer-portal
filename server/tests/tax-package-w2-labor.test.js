/**
 * Census A8: the CPA tax package and W-2 pay (GATE_TAX_PACKAGE_W2_LABOR).
 *
 * Locked-down behaviors:
 *  1. The reader is strict 'true', read at call time.
 *  2. w2PayrollToCSV: one row per check, hours = minutes / 60 to 2 places, money from
 *     integer cents, week end = week start + 6, one TOTAL row, no SSN or bank column.
 *  3. generateReadme: gate off is today's text; gate on swaps item 6, adds item 7
 *     (w2-payroll.csv) and renumbers the P&L as 8.
 *  4. The package route: gate off writes the same files and the README text it always
 *     did and never reads payroll_checks; gate on adds w2-payroll.csv and narrows the
 *     time-tracking read to technicians who are not W-2 employees.
 * The real Postgres variant is tax-package-w2-labor-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { touched: [], summaryCalls: [], checkRows: [], checkCalls: [] };
function mockChain(resolveWith, record) {
  const b = new Proxy(function chainable() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(resolveWith('then')).then(res, rej);
      if (prop === 'first') return () => Promise.resolve(resolveWith('first'));
      return (...args) => { if (record) record.push([prop, args]); return b; };
    },
    apply() { return b; },
  });
  return b;
}
const emptyChain = () => mockChain((kind) => (kind === 'first' ? undefined : []));
function table(name) {
  state.touched.push(name);
  if (name === 'time_entry_daily_summary as s') return mockChain(() => [], state.summaryCalls);
  if (name === 'payroll_checks') return mockChain(() => state.checkRows, state.checkCalls);
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
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/tax-shared-bills', () => ({
  ...jest.requireActual('../services/tax-shared-bills'),
  listBills: jest.fn(() => Promise.resolve([])), getHomeOffice: jest.fn(() => Promise.resolve(null)),
}));

const express = require('express');
const csv = require('../services/csv-generators');
const { taxPackageW2LaborLive } = require('../config/feature-gates');
const taxRouter = require('../routes/admin-tax');
const { readZip } = require('./helpers/read-zip');

const GATE = 'GATE_TAX_PACKAGE_W2_LABOR';
const OLD_GATE = process.env[GATE];

// Today's README file list, frozen: gate off must keep printing exactly this.
const LEGACY_LIST = [
  '  6. labor-timetracking-informational.csv',
  '                          — Owner time-tracking detail, INFORMATIONAL ONLY.',
  '                            The cost column is an internal job-costing',
  "                            estimate of the owner-operator's own time, which",
  '                            is NOT a deductible payroll expense and is NOT',
  '                            included in the P&L.',
  '  7. pnl.csv              — Profit & Loss statement',
].join('\n');

const CHECK = {
  employee_name: 'Sample Employee',
  week_start: '2026-09-14',
  pay_date: '2026-09-25',
  regular_minutes: '2400.00',
  overtime_minutes: '90.00',
  gross_cents: 100000,
  federal_income_tax_cents: 9000,
  social_security_cents: 6200,
  medicare_cents: 1450,
  additional_medicare_cents: 50,
  employer_social_security_cents: 6200,
  employer_medicare_cents: 1450,
  futa_cents: 600,
  fl_reemployment_cents: 270,
  net_cents: 83300,
};

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  Object.assign(state, { touched: [], summaryCalls: [], checkRows: [], checkCalls: [] });
  mockDb.mockClear();
  delete process.env[GATE];
});
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
});

describe('GATE_TAX_PACKAGE_W2_LABOR reader', () => {
  test('on only for the exact string true, read at call time', () => {
    expect(taxPackageW2LaborLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) { process.env[GATE] = v; expect(taxPackageW2LaborLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(taxPackageW2LaborLive()).toBe(true);
    delete process.env[GATE];
    expect(taxPackageW2LaborLive()).toBe(false);
  });
});

describe('w2PayrollToCSV', () => {
  test('one row per check with hours, cents-to-dollars, week end and a totals row', () => {
    const second = { ...CHECK, employee_name: 'Sample Second', week_start: '2026-09-21', pay_date: '2026-10-02', regular_minutes: '1234.50', overtime_minutes: '0.00', gross_cents: 50001, net_cents: 41000, medicare_cents: 725, additional_medicare_cents: 0 };
    const lines = csv.w2PayrollToCSV([CHECK, second]).split('\n');
    expect(lines[0]).toBe('Employee,Week Start,Week End,Pay Date,Regular Hours,Overtime Hours,Gross Wages,Federal Income Tax Withheld,Employee Social Security,Employee Medicare (incl. Additional Medicare),Employer Social Security,Employer Medicare,FUTA,Florida Reemployment Tax,Net Pay');
    // 2400 min = 40.00 h; 90 min = 1.50 h; medicare 14.50 + 0.50 = 15.00
    expect(lines[1]).toBe('Sample Employee,2026-09-14,2026-09-20,2026-09-25,40.00,1.50,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
    // 1234.5 min = 20.575 h -> 20.58 (same rounding as the pay stub)
    expect(lines[2]).toBe('Sample Second,2026-09-21,2026-09-27,2026-10-02,20.58,0.00,500.01,90.00,62.00,7.25,62.00,14.50,6.00,2.70,410.00');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('TOTAL,,,,60.58,1.50,1500.01,180.00,124.00,22.25,124.00,29.00,12.00,5.40,1243.00');
  });

  test('no checks: header and a zero totals row; no SSN or bank column', () => {
    const lines = csv.w2PayrollToCSV([]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('TOTAL,,,,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00');
    expect(lines[0]).not.toMatch(/ssn|social security number|bank|routing|account/i);
  });
});

describe('generateReadme', () => {
  test('gate off is today\'s text', () => {
    const off = csv.generateReadme(2026, null);
    expect(off).toBe(csv.generateReadme(2026, null, { w2Labor: false }));
    expect(off).toContain(LEGACY_LIST);
    expect(off).not.toContain('w2-payroll.csv');
  });

  test('gate on: item 6 is the owner\'s time, item 7 is w2-payroll.csv, the P&L is item 8', () => {
    const on = csv.generateReadme(2026, null, { w2Labor: true });
    expect(on).not.toContain(LEGACY_LIST);
    expect(on).toMatch(/6\. labor-timetracking-informational\.csv\n\s+— The owner's own time-tracking detail \(technicians\n\s+who are not W-2 employees\)/);
    expect(on).toMatch(/7\. w2-payroll\.csv\s+— W-2 employee pay from finalized pay runs/);
    expect(on).toContain('Schedule C line 26');
    expect(on).toContain('employer taxes (line 23)');
    expect(on).toContain("totals match the portal's W-2 and W-3 figures");
    expect(on).toMatch(/The P&L does not read pay runs yet/);
    expect(on).toMatch(/expenses\.csv and pnl\.csv, so\s+compare them with this file so nothing is counted\s+twice or missed/);
    expect(on).toMatch(/8\. pnl\.csv\s+— Profit & Loss statement/);
    expect(on).not.toMatch(/7\. pnl\.csv/);
  });
});

describe('tax package route', () => {
  const pack = async () => {
    const res = await fetch(`${baseUrl}/admin/tax/export/tax-package?year=2026`);
    if (res.status !== 200) throw new Error(await res.text());
    return readZip(Buffer.from(await res.arrayBuffer()));
  };
  const whereCallbacks = () => state.summaryCalls.filter(([m, a]) => m === 'where' && typeof a[0] === 'function');

  test('gate off: the same files, today\'s README, no pay check read, no technician filter', async () => {
    const files = await pack();
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'depreciation.csv', 'expenses.csv', 'labor-timetracking-informational.csv', 'mileage.csv', 'pnl.csv', 'refunds.csv', 'transactions.csv']);
    expect(files['README.txt']).toContain(LEGACY_LIST);
    expect(files['README.txt']).not.toContain('w2-payroll');
    expect(state.touched).not.toContain('payroll_checks');
    expect(whereCallbacks()).toHaveLength(0);
  });

  test('gate on: w2-payroll.csv holds the finalized checks, the time file is narrowed, the README says so', async () => {
    process.env[GATE] = 'true';
    state.checkRows = [CHECK];
    const files = await pack();
    expect(Object.keys(files)).toContain('w2-payroll.csv');
    const lines = files['w2-payroll.csv'].split('\n');
    expect(lines[1]).toBe('Sample Employee,2026-09-14,2026-09-20,2026-09-25,40.00,1.50,1000.00,90.00,62.00,15.00,62.00,14.50,6.00,2.70,833.00');
    expect(lines[2].startsWith('TOTAL,')).toBe(true);
    expect(files['README.txt']).toMatch(/7\. w2-payroll\.csv/);
    expect(files['README.txt']).toMatch(/8\. pnl\.csv/);
    // finalized only, pay date in the year
    const wheres = state.checkCalls.filter(([m]) => m === 'where').map(([, a]) => a);
    expect(wheres).toEqual(expect.arrayContaining([['status', 'finalized'], ['pay_date', '>=', '2026-01-01'], ['pay_date', '<=', '2026-12-31']]));
    expect(whereCallbacks()).toHaveLength(1);
  });
});
