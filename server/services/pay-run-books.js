/**
 * Pay-run books (GATE_PNL_PAY_RUN_WAGES, census M11): the one reader the P&L
 * (pnl-report.js) and the Schedule C draft (tax-return-engine.js) share, so both
 * count W-2 wages and employer payroll taxes from the SAME pay checks the CPA
 * package lists in w2-payroll.csv (tax-package-w2.js loadFinalizedW2Checks:
 * payroll_checks.status 'finalized', pay_date inside the window, inclusive).
 *
 *   wages          = gross_cents (Schedule C line 26)
 *   employer taxes = employer Social Security + employer Medicare + FUTA +
 *                    Florida reemployment (Schedule C line 23)
 *
 * The bank sees those same dollars as net pay, the federal deposit, FUTA and the
 * Florida RT-6 payment. They are booked in the expense category
 * "Payroll (counted from pay runs)" (expense_categories.counted_from_pay_runs), and
 * the helpers below leave that category out so nothing counts twice.
 *
 * The callers own the gate; these functions only run behind it.
 */
const { loadFinalizedW2Checks } = require('./tax-package-w2');

const PAY_RUN_CATEGORY_NAME = 'Payroll (counted from pay runs)';

const toCents = (v) => Math.round(Number(v) || 0);
const dollars = (cents) => Math.round(cents) / 100;

/**
 * Wages and employer payroll taxes from finalized pay checks paid in
 * [startDate, endDate] ('YYYY-MM-DD'). Integer cents are summed, then converted.
 * Returns { checks, wagesCents, employerTaxesCents, wages, employerTaxes, total }.
 */
async function payRunTotals(db, startDate, endDate) {
  const rows = await loadFinalizedW2Checks(db, startDate, endDate);
  let wagesCents = 0;
  let employerTaxesCents = 0;
  for (const r of rows) {
    wagesCents += toCents(r.gross_cents);
    employerTaxesCents += toCents(r.employer_social_security_cents)
      + toCents(r.employer_medicare_cents)
      + toCents(r.futa_cents)
      + toCents(r.fl_reemployment_cents);
  }
  return {
    checks: rows.length,
    wagesCents,
    employerTaxesCents,
    wages: dollars(wagesCents),
    employerTaxes: dollars(employerTaxesCents),
    total: dollars(wagesCents + employerTaxesCents),
  };
}

const COUNTED_CATEGORY_SQL = `EXISTS (
  SELECT 1 FROM expense_categories pay_run_cat
   WHERE pay_run_cat.id = expenses.category_id AND pay_run_cat.counted_from_pay_runs IS TRUE
)`;

/**
 * Leave out expense rows in a counted_from_pay_runs category, KEEPING uncategorized
 * rows (category_id NULL). Written as NOT EXISTS on purpose: `category_id NOT IN
 * (...)` and `name NOT IN (...)` drop NULL rows (SQL three-valued logic), the trap
 * that once zeroed all of opex in the P&L. Needs the `expenses` table unaliased in
 * the query; no join required, so it is safe beside any existing join.
 */
function leaveOutPayRunCategory(query) {
  return query.whereRaw(`NOT ${COUNTED_CATEGORY_SQL}`);
}

/**
 * The bank payment rows left out in [startDate, endDate] (by expense_date):
 * { count, amount } in dollars, for disclosure on the P&L.
 */
async function bankLinesLeftOut(db, startDate, endDate) {
  const row = await db('expenses')
    .whereBetween('expenses.expense_date', [startDate, endDate])
    .whereRaw(COUNTED_CATEGORY_SQL)
    .select(
      db.raw('COUNT(*)::int as count'),
      db.raw("COALESCE(SUM(expenses.amount)::text, '0') as amount"),
    )
    .first();
  return {
    count: Number(row && row.count) || 0,
    amount: Math.round((parseFloat(row && row.amount) || 0) * 100) / 100,
  };
}

module.exports = { PAY_RUN_CATEGORY_NAME, payRunTotals, leaveOutPayRunCategory, bankLinesLeftOut };
