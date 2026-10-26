/**
 * P&L from pay runs (GATE_PNL_PAY_RUN_WAGES, census M11): buildPnlReport and the
 * quarterly estimate on a queue-backed knex mock (same style as
 * admin-tax-quarterly-estimate.test.js). Gate off = the report is exactly what
 * assemblePnl made before this gate (labor 0, no payroll key, no pay-run query).
 * Gate on = labor is wages + employer taxes, the counted category is left out of the
 * opex query, and the payroll block and the year-to-date estimate carry the figures.
 * The NULL case (an uncategorized row stays) runs on real Postgres in
 * pnl-pay-run-wages-postgres.test.js. All figures are synthetic.
 */
const queues = {};
const builders = [];
const rawCalls = [];
function stage(table, ...results) { (queues[table] = queues[table] || []).push(...results); }
function nextFor(table) {
  const q = queues[table] || [];
  const v = q.length ? q.shift() : null;
  if (v instanceof Error) throw v;
  return v;
}
function makeBuilder(rawTable) {
  const table = String(rawTable).split(' ')[0];
  const b = { table, whereRawCalls: [] };
  [
    'where', 'whereIn', 'whereNotIn', 'whereNot', 'whereNull', 'whereNotNull',
    'whereBetween', 'whereExists', 'whereNotExists', 'leftJoin', 'join',
    'groupBy', 'orderBy', 'select', 'sum', 'count', 'limit',
  ].forEach((m) => { b[m] = jest.fn(() => b); });
  b.whereRaw = jest.fn((sql) => { b.whereRawCalls.push(String(sql)); return b; });
  b.first = jest.fn(() => new Promise((res) => res(nextFor(table))));
  b.then = (res, rej) => Promise.resolve(nextFor(table)).then(res, rej);
  b.catch = (fn) => Promise.resolve(nextFor(table)).catch(fn);
  builders.push(b);
  return b;
}
const mockDb = jest.fn((table) => makeBuilder(table));
mockDb.raw = jest.fn((sql) => { rawCalls.push(String(sql)); return sql; });
mockDb.fn = { now: jest.fn(() => 'now()'), uuid: jest.fn(() => 'uuid()') };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildPnlReport, computeQuarterlyEstimate, assemblePnl } = require('../services/pnl-report');

const GATE = 'GATE_PNL_PAY_RUN_WAGES';
const OLD_GATE = process.env[GATE];

// One check: wages 1,000.00; employer taxes 62.00 + 14.50 + 6.00 + 2.70 = 85.20.
const CHECK = {
  gross_cents: 100000, employer_social_security_cents: 6200, employer_medicare_cents: 1450,
  futa_cents: 600, fl_reemployment_cents: 270,
};
const OPEX_ROWS = [
  { category: 'Insurance', irs_line: '15', total: '400', non_deductible: '0' },
  { category: null, irs_line: null, total: '50', non_deductible: '0' }, // uncategorized stays
];

function stageRevenueWindow() {
  stage('payments', { total: '30700' }, { total: '0' });
  stage('invoices', { total: '0' }, { total: '700' }, { total: '0' });
  stage('estimate_deposits', { total: '0' });
  stage('stripe_payout_transactions', { total: '0' });
}
// Construction order in buildPnlReport: materials, then opex, per table.
function stageReport({ payRun = false } = {}) {
  stageRevenueWindow();
  stage('expenses', { total: '100', non_deductible: '0' }, OPEX_ROWS);
  stage('stripe_payout_transactions', { total: '0' });
  stage('mileage_log', { total: '0' });
  stage('equipment_register', [], []);
  stage('company_financials', null);
  if (payRun) {
    stage('payroll_checks', [CHECK]);
    stage('expenses', { count: 3, amount: '1085.2' }); // bank lines left out
  }
  stage('stripe_sync_state', null);
}

beforeEach(() => {
  for (const k of Object.keys(queues)) delete queues[k];
  builders.length = 0;
  rawCalls.length = 0;
  mockDb.mockClear();
  delete process.env[GATE];
});
afterAll(() => { if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE; });

describe('buildPnlReport', () => {
  test('gate off: the report is what assemblePnl made before (labor 0, no payroll key, no pay-run read)', async () => {
    stageReport();
    const report = await buildPnlReport(mockDb, '2026-01-01', '2026-03-31');
    const expected = assemblePnl({
      serviceRevenue: 30000, salesTaxCollected: 700, laborCost: 0, materialsCost: 100, opexRows: OPEX_ROWS,
    });
    expected.deductions.depreciationComplete = true;
    expected.coverage = { lastBalanceSyncAt: null, complete: false, note: expect.any(String) };
    expect(report).toEqual(expected);
    expect(Object.keys(report)).not.toContain('payroll');
    expect(report.cogs.labor).toBe(0);
    expect(builders.some((b) => b.table === 'payroll_checks')).toBe(false);
    expect(builders.flatMap((b) => b.whereRawCalls).some((sql) => /counted_from_pay_runs/.test(sql))).toBe(false);
  });

  test('any other gate value is off', async () => {
    process.env[GATE] = '1';
    stageReport();
    const report = await buildPnlReport(mockDb, '2026-01-01', '2026-03-31');
    expect(report.payroll).toBeUndefined();
  });

  test('gate on: labor is wages + employer taxes, the opex query leaves out the counted category, payroll block', async () => {
    process.env[GATE] = 'true';
    stageReport({ payRun: true });
    const report = await buildPnlReport(mockDb, '2026-01-01', '2026-03-31');
    expect(report.cogs.labor).toBe(1085.2);
    expect(report.cogs.total).toBe(1185.2); // labor + 100 materials
    // The uncategorized row stays in opex.
    expect(report.operatingExpenses.categories.map((c) => c.name).sort()).toEqual(['Insurance', 'Uncategorized']);
    expect(report.operatingExpenses.total).toBe(450);
    expect(report.netIncome).toBe(30000 - 1185.2 - 450);
    expect(report.payroll).toEqual({
      source: 'finalized pay runs',
      checks: 1,
      wages: 1000,
      employerTaxes: 85.2,
      total: 1085.2,
      bankLinesLeftOut: { count: 3, amount: 1085.2 },
      note: expect.stringContaining('"Payroll (counted from pay runs)" category are left out so nothing counts twice'),
    });
    expect(report.payroll.note).toContain('by pay date');
    expect(report.payroll.note).toContain('January for December wages stays in December');
    // The opex query (the second expenses builder) carries the NULL-safe filter.
    const expenseBuilders = builders.filter((b) => b.table === 'expenses');
    const opex = expenseBuilders[1];
    expect(opex.whereRawCalls).toHaveLength(1);
    expect(opex.whereRawCalls[0]).toMatch(/^NOT EXISTS/);
    expect(opex.whereRawCalls[0]).toContain('counted_from_pay_runs IS TRUE');
    expect(opex.whereRawCalls[0]).not.toMatch(/NOT IN/i);
    // The materials query is untouched.
    expect(expenseBuilders[0].whereRawCalls).toEqual([]);
  });
});

describe('computeQuarterlyEstimate year-to-date expenses', () => {
  test('gate off: the expenses sum is used as is, with no pay-run read', async () => {
    stageRevenueWindow();
    stage('expenses', { total: '5000' });
    stage('tax_filing_calendar', { total: '0' });
    const est = await computeQuarterlyEstimate(mockDb, { year: 2026, qNum: 2, today: '2026-08-24' });
    expect(est.ytdExpenses).toBe(5000);
    expect(builders.some((b) => b.table === 'payroll_checks')).toBe(false);
    expect(builders.filter((b) => b.table === 'expenses').flatMap((b) => b.whereRawCalls)).toEqual([]);
  });

  test('gate on: the counted category is left out and year-to-date wages + employer taxes are added', async () => {
    process.env[GATE] = 'true';
    stageRevenueWindow();
    stage('expenses', { total: '5000' });
    stage('payroll_checks', [CHECK, { ...CHECK, gross_cents: 50000, employer_social_security_cents: 3100 }]);
    stage('tax_filing_calendar', { total: '0' });
    const est = await computeQuarterlyEstimate(mockDb, { year: 2026, qNum: 2, today: '2026-08-24' });
    // 5000 + 1000.00 + 85.20 + 500.00 + (31.00 + 14.50 + 6.00 + 2.70)
    expect(est.ytdExpenses).toBe(6639.4);
    const expensesBuilder = builders.find((b) => b.table === 'expenses');
    expect(expensesBuilder.whereRawCalls).toHaveLength(1);
    expect(expensesBuilder.whereRawCalls[0]).toMatch(/^NOT EXISTS/);
  });
});
