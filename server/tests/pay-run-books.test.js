/**
 * services/pay-run-books (GATE_PNL_PAY_RUN_WAGES, census M11): the one reader the P&L and
 * the Schedule C draft share. A small in-memory knex stand-in applies the where clauses
 * the shared reader (tax-package-w2 loadFinalizedW2Checks) builds, so the predicate
 * itself is exercised: finalized only, pay_date inside the window, inclusive at both ends.
 * All figures are synthetic.
 */
const { payRunTotals, leaveOutPayRunCategory, PAY_RUN_CATEGORY_NAME } = require('../services/pay-run-books');

function fakeConn(rows) {
  const conn = (table) => {
    if (table !== 'payroll_checks') throw new Error(`unexpected table ${table}`);
    const preds = [];
    const b = {
      where(col, op, val) {
        if (val === undefined) { preds.push((r) => r[col] === op); return b; }
        preds.push((r) => (op === '>=' ? r[col] >= val : op === '<=' ? r[col] <= val : r[col] === val));
        return b;
      },
      orderBy() { return b; },
      select() { return b; },
      then(res, rej) { return Promise.resolve(rows.filter((r) => preds.every((p) => p(r)))).then(res, rej); },
    };
    return b;
  };
  conn.raw = (sql) => sql;
  return conn;
}

const check = (payDate, status, over = {}) => ({
  status,
  pay_date: payDate,
  gross_cents: 100000,
  employer_social_security_cents: 6200,
  employer_medicare_cents: 1450,
  futa_cents: 600,
  fl_reemployment_cents: 270,
  ...over,
});

describe('payRunTotals', () => {
  test('counts finalized checks only: a draft and a voided check are left out', async () => {
    const conn = fakeConn([
      check('2026-09-25', 'finalized'),
      check('2026-10-02', 'draft'),
      check('2026-10-09', 'voided'),
    ]);
    const t = await payRunTotals(conn, '2026-01-01', '2026-12-31');
    expect(t.checks).toBe(1);
    expect(t.wagesCents).toBe(100000);
    expect(t.wages).toBe(1000);
  });

  test('the window is inclusive at both ends and leaves out the days around it', async () => {
    const conn = fakeConn([
      check('2025-12-31', 'finalized'),
      check('2026-01-01', 'finalized'),
      check('2026-12-31', 'finalized'),
      check('2027-01-01', 'finalized'),
    ]);
    const t = await payRunTotals(conn, '2026-01-01', '2026-12-31');
    expect(t.checks).toBe(2);
    expect(t.wagesCents).toBe(200000);
  });

  test('employer taxes sum the four columns; cents become dollars', async () => {
    const conn = fakeConn([
      check('2026-03-06', 'finalized', {
        gross_cents: 123456, employer_social_security_cents: 7654, employer_medicare_cents: 1790,
        futa_cents: 741, fl_reemployment_cents: 333,
      }),
      check('2026-03-13', 'finalized', {
        gross_cents: 1, employer_social_security_cents: 1, employer_medicare_cents: 1, futa_cents: 0, fl_reemployment_cents: 2,
      }),
    ]);
    const t = await payRunTotals(conn, '2026-01-01', '2026-12-31');
    expect(t.wagesCents).toBe(123457);
    expect(t.employerTaxesCents).toBe(7654 + 1790 + 741 + 333 + 4);
    expect(t.wages).toBe(1234.57);
    expect(t.employerTaxes).toBe(105.22);
    expect(t.total).toBe(1339.79);
  });

  test('no checks reads as zero', async () => {
    const t = await payRunTotals(fakeConn([]), '2026-01-01', '2026-12-31');
    expect(t).toEqual({ checks: 0, wagesCents: 0, employerTaxesCents: 0, wages: 0, employerTaxes: 0, total: 0 });
  });
});

describe('leaveOutPayRunCategory', () => {
  test('is NULL-safe: NOT EXISTS keeps uncategorized rows, and it never uses NOT IN', () => {
    const calls = [];
    const q = { whereRaw: (sql) => { calls.push(sql); return q; } };
    expect(leaveOutPayRunCategory(q)).toBe(q);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^NOT EXISTS/);
    expect(calls[0]).toContain('pay_run_cat.id = expenses.category_id');
    expect(calls[0]).toContain('counted_from_pay_runs IS TRUE');
    expect(calls[0]).not.toMatch(/NOT IN/i);
  });

  test('the category name is the one the migration seeds', () => {
    expect(PAY_RUN_CATEGORY_NAME).toBe('Payroll (counted from pay runs)');
  });
});
