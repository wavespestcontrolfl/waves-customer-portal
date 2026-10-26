// Real PostgreSQL transaction (rolled back): the P&L and the Schedule C draft with
// GATE_PNL_PAY_RUN_WAGES off and on, on the migrated schema. Pay checks: a finalized one
// in the year counts; a draft, a voided one, and finalized ones paid outside the year do
// not. Expenses: one in the "Payroll (counted from pay runs)" category, one uncategorized,
// one Taxes and licenses, one Insurance. Also the migration's two paths. All names are
// synthetic. DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-years', () => ({
  ...jest.requireActual('../services/tax-years'),
  getYearDetail: jest.fn(() => Promise.resolve({
    year: 2026, exists: true,
    row: { filing_status: 'single', other_income: 0, estimates_paid: 0, status: 'draft', filed_on: null, filed_snapshot: null, version: 'v1' },
    carry_in: { nol: { value: 0 }, qbi_loss: { value: 0 }, sec179: { value: 0 }, home_office: { value: 0 } },
    prior_version: 'p1',
  })),
}));

const { randomUUID } = require('node:crypto');
const { buildPnlReport, computeQuarterlyEstimate } = require('../services/pnl-report');
const { gatherInputs } = require('../services/tax-return-engine');
const migration = require('../models/migrations/20261026150000_expense_category_pay_runs');

jest.setTimeout(60000);
const GATE = 'GATE_PNL_PAY_RUN_WAGES';
const CATEGORY = 'Payroll (counted from pay runs)';

postgres('P&L and Schedule C from pay runs', () => {
  let database;
  let trx;
  const OLD_GATE = process.env[GATE];

  const run = async (weekStart, payDate, status) => {
    const id = randomUUID();
    await trx('payroll_runs').insert({ id, week_start: weekStart, pay_date: payDate, status });
    return id;
  };
  const check = async (runId, technicianId, weekStart, payDate, status) => {
    const w4 = randomUUID();
    await trx('payroll_w4_elections').insert({
      id: w4, technician_id: technicianId, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    await trx('payroll_checks').insert({
      run_id: runId, technician_id: technicianId, employee_name: 'Sample Hire', week_start: weekStart, pay_date: payDate,
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '90.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 9000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 50,
      net_cents: 83300, employer_social_security_cents: 6200, employer_medicare_cents: 1450, futa_cents: 600,
      fl_reemployment_cents: 270, ytd_gross_before_cents: 0, w4_election_id: w4, calc_snapshot: JSON.stringify({}),
      pay_method: 'check', status,
    });
  };
  const expense = async (categoryName, description, amount, date = '2026-09-25') => {
    let categoryId = null;
    if (categoryName) categoryId = (await trx('expense_categories').where({ name: categoryName }).first('id')).id;
    await trx('expenses').insert({
      category_id: categoryId, description, amount, expense_date: date, tax_year: date.slice(0, 4),
    });
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    delete process.env[GATE];
    const hire = randomUUID();
    await trx('technicians').insert({ id: hire, name: 'Sample Hire', employment_type: 'w2', employment_status: 'active' });
    await check(await run('2026-09-14', '2026-09-25', 'finalized'), hire, '2026-09-14', '2026-09-25', 'finalized');
    await check(await run('2026-09-21', '2026-10-02', 'draft'), hire, '2026-09-21', '2026-10-02', 'draft');
    await check(await run('2026-09-28', '2026-10-09', 'voided'), hire, '2026-09-28', '2026-10-09', 'voided');
    await check(await run('2025-12-22', '2025-12-31', 'finalized'), hire, '2025-12-22', '2025-12-31', 'finalized');
    await check(await run('2026-12-28', '2027-01-08', 'finalized'), hire, '2026-12-28', '2027-01-08', 'finalized');
    await expense(CATEGORY, 'Bank payroll payment', '1085.20');
    await expense(null, 'Uncategorized charge', '50.00');
    await expense('Taxes & Licenses', 'Business tax receipt', '120.00');
    await expense('Insurance', 'Sample policy', '400.00');
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
  });
  afterAll(async () => { if (database) await database.destroy(); });

  const opexTotals = (report) => Object.fromEntries(report.operatingExpenses.categories.map((c) => [c.name, c.amount]));
  const byLine = (lines) => {
    const out = {};
    for (const l of lines) out[l.line] = Math.round(((out[l.line] || 0) + l.amount) * 100) / 100;
    return out;
  };

  it('the migration seeds the category with the flag on and no Schedule C line', async () => {
    const row = await trx('expense_categories').where({ name: CATEGORY }).first();
    expect(row).toMatchObject({ irs_line: null, is_deductible: false, counted_from_pay_runs: true });
    expect(await trx('expense_categories').where({ name: CATEGORY }).count('* as n').first()).toMatchObject({ n: '1' });
    const others = await trx('expense_categories').whereNot({ name: CATEGORY }).where({ counted_from_pay_runs: true });
    expect(others).toHaveLength(0);
  });

  it('the migration is safe to run again, flags an existing row, and re-seeds a missing one', async () => {
    await migration.up(trx);
    expect(await trx('expense_categories').where({ name: CATEGORY }).count('* as n').first()).toMatchObject({ n: '1' });
    // An existing row of that name with the flag off gets the flag, not a second row.
    await trx('expense_categories').where({ name: CATEGORY }).update({ counted_from_pay_runs: false, irs_line: '27a' });
    await migration.up(trx);
    const flagged = await trx('expense_categories').where({ name: CATEGORY });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].counted_from_pay_runs).toBe(true);
    // A missing row is inserted at the end of the list (the expense above first loses its category).
    await trx('expenses').where({ description: 'Bank payroll payment' }).del();
    await trx('expense_categories').where({ name: CATEGORY }).del();
    const max = (await trx('expense_categories').max('sort_order as max').first()).max;
    await migration.up(trx);
    const seeded = await trx('expense_categories').where({ name: CATEGORY }).first();
    expect(seeded.sort_order).toBe(max + 1);
    expect(seeded.counted_from_pay_runs).toBe(true);
  });

  it('the migration down keeps the row while an expense uses it', async () => {
    await migration.down(trx);
    // Column dropped, row kept because the bank payment expense still references it.
    expect(await trx('expense_categories').where({ name: CATEGORY }).count('* as n').first()).toMatchObject({ n: '1' });
    expect(await trx.schema.hasColumn('expense_categories', 'counted_from_pay_runs')).toBe(false);
  });

  it('P&L gate off: labor 0, no payroll key, the bank payment is a normal opex category', async () => {
    const report = await buildPnlReport(trx, '2026-01-01', '2026-12-31');
    expect(report.cogs.labor).toBe(0);
    expect(Object.keys(report)).not.toContain('payroll');
    expect(opexTotals(report)).toMatchObject({
      [CATEGORY]: 1085.2, Uncategorized: 50, 'Taxes & Licenses': 120, Insurance: 400,
    });
    expect(report.operatingExpenses.total).toBe(1655.2);
  });

  it('P&L gate on: labor = wages + employer taxes; the bank payment is left out; the uncategorized row stays', async () => {
    process.env[GATE] = 'true';
    const report = await buildPnlReport(trx, '2026-01-01', '2026-12-31');
    expect(report.cogs.labor).toBe(1085.2); // 1000.00 + 62.00 + 14.50 + 6.00 + 2.70
    const names = opexTotals(report);
    expect(names[CATEGORY]).toBeUndefined();
    expect(names).toMatchObject({ Uncategorized: 50, 'Taxes & Licenses': 120, Insurance: 400 });
    expect(report.operatingExpenses.total).toBe(570);
    expect(report.payroll).toMatchObject({
      source: 'finalized pay runs', checks: 1, wages: 1000, employerTaxes: 85.2, total: 1085.2,
      bankLinesLeftOut: { count: 1, amount: 1085.2 },
    });
  });

  it('P&L gate on counts a check by its pay date: a December wage paid in January is the next year', async () => {
    process.env[GATE] = 'true';
    const report2027 = await buildPnlReport(trx, '2027-01-01', '2027-12-31');
    expect(report2027.payroll.checks).toBe(1);
    const report2025 = await buildPnlReport(trx, '2025-01-01', '2025-12-31');
    expect(report2025.payroll.checks).toBe(1);
  });

  it('Schedule C gate off: the bank payment lands on line 27a with the uncategorized row', async () => {
    const g = await gatherInputs(2026);
    expect(byLine(g.expense_lines)).toEqual({ 15: 400, 23: 120, '27a': 1135.2 });
    expect(g.warnings.map((w) => w.code)).toContain('uncategorized');
  });

  it('Schedule C gate on: line 26 = wages, line 23 = employer taxes + Taxes and licenses, bank payment left out', async () => {
    process.env[GATE] = 'true';
    const g = await gatherInputs(2026);
    expect(byLine(g.expense_lines)).toEqual({ 15: 400, 23: 205.2, 26: 1000, '27a': 50 });
  });

  it('quarterly estimate year to date: gate off counts the bank payment, gate on counts the pay runs', async () => {
    const off = await computeQuarterlyEstimate(trx, { year: 2026, qNum: 4, today: '2026-12-31' });
    expect(off.ytdExpenses).toBe(1655.2);
    process.env[GATE] = 'true';
    const on = await computeQuarterlyEstimate(trx, { year: 2026, qNum: 4, today: '2026-12-31' });
    expect(on.ytdExpenses).toBe(1655.2); // 570 + 1085.20: the same total, counted from the pay runs
  });
});
