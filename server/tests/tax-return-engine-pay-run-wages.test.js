/**
 * Schedule C draft from pay runs (GATE_PNL_PAY_RUN_WAGES, census M11): gatherInputs
 * on a recording knex mock. Gate on = line 26 is the wages, line 23 is the employer
 * payroll taxes plus any Taxes and licenses expense, and the expense query leaves out
 * the counted category. Gate off = today's lines. Synthetic figures only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { rows: {}, pnl: null, detail: null, builders: [] };
function chain(table) {
  const rec = { table, whereRawCalls: [] };
  state.builders.push(rec);
  const b = new Proxy(function chainable() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(state.rows[table] ?? []).then(res, rej);
      if (prop === 'first') return () => Promise.resolve(state.rows[table] ?? null);
      if (prop === 'whereRaw') return (sql) => { rec.whereRawCalls.push(String(sql)); return b; };
      return () => b;
    },
    apply() { return b; },
  });
  return b;
}
const mockDb = jest.fn((table) => chain(table));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);
jest.mock('../services/pnl-report', () => ({
  ...jest.requireActual('../services/pnl-report'),
  buildPnlReport: jest.fn(() => Promise.resolve(state.pnl)),
}));
jest.mock('../services/tax-years', () => ({
  ...jest.requireActual('../services/tax-years'),
  getYearDetail: jest.fn(() => Promise.resolve(state.detail)),
  ensureRow: jest.fn(() => Promise.resolve()),
  markFiled: jest.fn(),
}));

const engine = require('../services/tax-return-engine');

const GATE = 'GATE_PNL_PAY_RUN_WAGES';
const OLD_GATE = process.env[GATE];

beforeEach(() => {
  delete process.env[GATE];
  state.builders = [];
  state.rows = {
    // The Taxes and licenses row is a normal expense on line 23.
    expenses: [
      { line: '8', n: 2, total: '300.50' },
      { line: '23', n: 1, total: '120' },
    ],
    equipment_register: [],
    tax_home_office: null,
    payroll_checks: [
      {
        gross_cents: 100000, employer_social_security_cents: 6200, employer_medicare_cents: 1450,
        futa_cents: 600, fl_reemployment_cents: 270,
      },
      {
        gross_cents: 50000, employer_social_security_cents: 3100, employer_medicare_cents: 725,
        futa_cents: 0, fl_reemployment_cents: 0,
      },
    ],
  };
  state.pnl = { revenue: { total: 20000 }, operatingExpenses: { categories: [] }, coverage: { complete: true } };
  state.detail = {
    year: 2025, exists: true,
    row: { filing_status: 'single', other_income: 0, estimates_paid: 0, status: 'draft', filed_on: null, filed_snapshot: null, version: 'v1' },
    carry_in: { nol: { value: 0 }, qbi_loss: { value: 0 }, sec179: { value: 0 }, home_office: { value: 0 } },
    prior_version: 'p1',
  };
});
afterAll(() => { if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE; });

describe('gatherInputs with GATE_PNL_PAY_RUN_WAGES', () => {
  test('gate off: expense rows only, no pay-run read, no exclusion', async () => {
    const g = await engine.gatherInputs(2025);
    expect(g.expense_lines).toEqual([{ line: '8', amount: 300.5 }, { line: '23', amount: 120 }]);
    expect(state.builders.some((b) => b.table === 'payroll_checks')).toBe(false);
    expect(state.builders.flatMap((b) => b.whereRawCalls)).toEqual([]);
  });

  test('gate on: line 26 = wages; line 23 = employer taxes, beside the other Taxes and licenses rows', async () => {
    process.env[GATE] = 'true';
    const g = await engine.gatherInputs(2025);
    expect(g.expense_lines).toEqual([
      { line: '8', amount: 300.5 },
      { line: '23', amount: 120 },
      { line: '26', amount: 1500 },
      { line: '23', amount: 85.2 + 38.25 },
    ]);
    // The return folds the two line-23 entries into one line.
    const r = engine.computeReturn({ ...g, today: '2026-01-15' });
    const line = (n) => r.schedule_c.find((l) => l.line === n);
    expect(line('26').amount).toBe(1500);
    expect(line('23').amount).toBe(243.45); // 120 + 123.45
    expect(r.warnings.map((w) => w.code)).not.toContain('uncategorized');
  });

  test('gate on: the expense query leaves out the counted category with a NULL-safe filter', async () => {
    process.env[GATE] = 'true';
    await engine.gatherInputs(2025);
    const expenses = state.builders.filter((b) => b.table === 'expenses');
    expect(expenses).toHaveLength(1);
    expect(expenses[0].whereRawCalls).toHaveLength(1);
    expect(expenses[0].whereRawCalls[0]).toMatch(/^NOT EXISTS/);
    expect(expenses[0].whereRawCalls[0]).toContain('counted_from_pay_runs IS TRUE');
    expect(expenses[0].whereRawCalls[0]).not.toMatch(/NOT IN/i);
  });

  test('gate on with no finalized checks adds no lines', async () => {
    process.env[GATE] = 'true';
    state.rows.payroll_checks = [];
    const g = await engine.gatherInputs(2025);
    expect(g.expense_lines).toEqual([{ line: '8', amount: 300.5 }, { line: '23', amount: 120 }]);
  });
});
