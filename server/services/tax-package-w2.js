/**
 * Tax package W-2 labor (GATE_TAX_PACKAGE_W2_LABOR, census A8): the reads the
 * CPA package makes when the gate is on. The route owns the gate; these
 * functions only run behind it.
 *
 * W-2 predicate: technicians.employment_type = 'w2' (the same test payroll-runs.js
 * uses to pick who gets a pay check). Pay checks counted: payroll_checks.status
 * = 'finalized' (the predicate payroll-runs.js and payroll-tax-calendar.js use;
 * drafts and voided checks never count), windowed on pay_date (Pub 15: wages
 * count in the year they are paid).
 */

const W2_CHECK_COLUMNS = [
  'employee_name', 'regular_minutes', 'overtime_minutes',
  'gross_cents', 'federal_income_tax_cents', 'social_security_cents', 'medicare_cents',
  'additional_medicare_cents', 'employer_social_security_cents', 'employer_medicare_cents',
  'futa_cents', 'fl_reemployment_cents', 'net_cents',
];

// Narrows a time_entry_daily_summary query (joined as `t` to technicians) to
// technicians who are NOT W-2 employees. A summary row with no technician row,
// or a technician with no employment_type, stays: neither is a W-2 hire.
function whereNotW2(query, alias = 't') {
  return query.where(function notW2() {
    this.whereNull(`${alias}.employment_type`).orWhereNot(`${alias}.employment_type`, 'w2');
  });
}

// Finalized pay checks with a pay date in [sd, ed] ('YYYY-MM-DD'), oldest first.
// timeOff (GATE_PAYROLL_TIME_OFF) also selects the paid time off and holiday
// minutes; gate off, the new columns are never read.
async function loadFinalizedW2Checks(conn, sd, ed, { timeOff = false } = {}) {
  return conn('payroll_checks')
    .where('status', 'finalized')
    .where('pay_date', '>=', sd)
    .where('pay_date', '<=', ed)
    .orderBy([{ column: 'pay_date' }, { column: 'week_start' }, { column: 'employee_name' }, { column: 'id' }])
    .select(
      ...W2_CHECK_COLUMNS,
      ...(timeOff ? ['pto_minutes', 'holiday_minutes'] : []),
      conn.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"),
      conn.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date"),
    );
}

module.exports = { whereNotW2, loadFinalizedW2Checks, W2_CHECK_COLUMNS };
