/**
 * Backfill expenses.tax_year / quarter for rows written without them
 * (job expenses via POST /api/admin/job-expenses never set the period, so the
 * rows were invisible to every tax_year-filtered reader) and repair the
 * 'NaN' / 'QNaN' rows the manual expense POST produced on a bad date.
 *
 * Derived in SQL from the DATE column, so no timezone shift is possible.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('expenses'))) return;
  await knex.raw(`
    UPDATE expenses
       SET tax_year = to_char(expense_date, 'YYYY'),
           quarter  = 'Q' || extract(quarter from expense_date)::int
     WHERE expense_date IS NOT NULL
       AND (tax_year IS NULL OR quarter IS NULL
            OR tax_year !~ '^[0-9]{4}$' OR quarter !~ '^Q[1-4]$')
  `);
};

// Data backfill only — the derived values are correct for every row, so
// there is nothing meaningful to revert.
exports.down = async function down() {};
