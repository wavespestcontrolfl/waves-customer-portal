'use strict';

/**
 * Tech Rewards Plan D5-5, the stay bonus (owner rulings 2026-11-20). Additive, dark behind GATE_TECH_REWARDS_STAY_BONUS.
 *
 *   payroll_pay_lines.counted_check_ids   the finalized paychecks the amount of a line was worked out from, for a line the pay
 *                                         run works out from pay (the stay bonus: the checks that hold pay of its 12 months).
 *                                         Nullable, null on every existing line and on every other kind. The pay run's Tech
 *                                         Rewards sync writes it with the amount, every time it works an open line out
 *                                         (server/services/tech-rewards-pay-lines.js); finalize pays the line as its own sync
 *                                         left it. voidRun (payroll-runs.js) refuses to void a pay run that holds one of these
 *                                         checks while the line is paid on another run.
 *
 * protect_payroll_pay_lines compares the whole row, so a paid line's list cannot change. A pushed migration is frozen: a fix
 * is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  if (!(await knex.schema.hasColumn('payroll_pay_lines', 'counted_check_ids'))) {
    await knex.raw('ALTER TABLE payroll_pay_lines ADD COLUMN counted_check_ids uuid[] NULL');
  }
};

exports.down = async function down(knex) {
  // DDL fires no row trigger, so the column goes from paid lines too.
  if (await knex.schema.hasTable('payroll_pay_lines')) await knex.raw('ALTER TABLE payroll_pay_lines DROP COLUMN IF EXISTS counted_check_ids');
};
