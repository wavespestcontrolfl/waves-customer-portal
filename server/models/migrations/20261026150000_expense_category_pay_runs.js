/**
 * Census M11 (owner 2026-10-26, choice B "from the payroll the portal already runs"):
 * a place for the bank's payroll payments that the P&L and the Schedule C draft leave
 * out when GATE_PNL_PAY_RUN_WAGES is on, because wages and employer payroll taxes
 * come from finalized pay runs (payroll_checks) instead.
 *
 *   1. expense_categories.counted_from_pay_runs boolean NOT NULL DEFAULT false.
 *   2. One category row named exactly "Payroll (counted from pay runs)": an existing
 *      row of that name gets the flag; otherwise it is inserted with no Schedule C
 *      line (irs_line NULL), sort_order = current max + 1.
 *
 * is_deductible = false on the seeded row. Nothing in the server reads is_deductible
 * to compute a figure (the categories list only echoes it); false is the honest value:
 * this category itself is not deducted, the deduction comes from the pay runs.
 *
 * Nothing reads the new column or the new row while the gate is off, so this is safe
 * to run ahead of the flip. Idempotent: every step checks first.
 */

const CATEGORY_NAME = 'Payroll (counted from pay runs)';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('expense_categories'))) return;

  if (!(await knex.schema.hasColumn('expense_categories', 'counted_from_pay_runs'))) {
    await knex.schema.alterTable('expense_categories', (t) => {
      t.boolean('counted_from_pay_runs').notNullable().defaultTo(false);
    });
  }

  const existing = await knex('expense_categories').where({ name: CATEGORY_NAME }).first('id');
  if (existing) {
    await knex('expense_categories').where({ name: CATEGORY_NAME }).update({ counted_from_pay_runs: true });
    return;
  }

  const maxRow = await knex('expense_categories').max('sort_order as max').first();
  await knex('expense_categories').insert({
    name: CATEGORY_NAME,
    irs_line: null,
    irs_description: 'Not deducted here: wages and employer payroll taxes come from finalized pay runs',
    is_deductible: false,
    notes: 'Book the bank payroll payments here: net pay, the federal deposit (EFTPS: withheld '
      + 'employee taxes plus the employer Social Security and Medicare), FUTA, and the Florida '
      + 'RT-6 reemployment tax payment. The P&L and the Schedule C draft leave this category out '
      + 'when GATE_PNL_PAY_RUN_WAGES is on and count the same wages and taxes from finalized pay '
      + 'runs, so nothing counts twice.',
    sort_order: (Number(maxRow && maxRow.max) || 0) + 1,
    counted_from_pay_runs: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('expense_categories'))) return;
  if (!(await knex.schema.hasColumn('expense_categories', 'counted_from_pay_runs'))) return;

  // Drop the row only when no expense uses it (expenses.category_id is ON DELETE SET NULL,
  // so deleting a used row would silently uncategorize real expenses).
  const row = await knex('expense_categories').where({ name: CATEGORY_NAME }).first('id');
  if (row) {
    const used = await knex('expenses').where({ category_id: row.id }).first('id');
    if (!used) await knex('expense_categories').where({ id: row.id }).del();
  }
  await knex.schema.alterTable('expense_categories', (t) => {
    t.dropColumn('counted_from_pay_runs');
  });
};
