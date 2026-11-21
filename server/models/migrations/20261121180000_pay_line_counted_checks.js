'use strict';

/**
 * Tech Rewards Plan D5-5, the stay bonus (owner rulings 2026-11-20). Additive, dark behind GATE_TECH_REWARDS_STAY_BONUS.
 *
 *   payroll_pay_lines.counted_check_ids   the finalized paychecks the amount of a line was worked out from, for a line the pay
 *                                         run works out from pay (the stay bonus: the checks of the pay weeks of its 12 months).
 *                                         Nullable, null on every existing line and on every other kind. The pay run's Tech
 *                                         Rewards sync writes it with the amount, every time it works an open line out
 *                                         (server/services/tech-rewards-pay-lines.js); finalize pays the line as its own sync
 *                                         left it. voidRun (payroll-runs.js) refuses to void a pay run that holds one of these
 *                                         checks while the line is paid on another run.
 *
 * protect_payroll_pay_lines compares the whole row, so a paid line's list cannot change. `down` refuses while a paid line holds
 * a list. A pushed migration is frozen: a fix is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  if (!(await knex.schema.hasColumn('payroll_pay_lines', 'counted_check_ids'))) {
    await knex.raw('ALTER TABLE payroll_pay_lines ADD COLUMN counted_check_ids uuid[] NULL');
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  if (!(await knex.schema.hasColumn('payroll_pay_lines', 'counted_check_ids'))) return;
  // A paid line's list is payroll evidence: it is what keeps a counted pay run from being voided under a paid bonus. Dropping
  // it would lose that for good (running `up` again leaves the paid lines with no list), so the rollback is refused while a
  // paid line holds one. DDL fires no row trigger, so nothing else would stop it.
  const paid = await knex('payroll_pay_lines').where({ status: 'paid' }).whereNotNull('counted_check_ids').first('id');
  if (paid) {
    throw new Error('payroll_pay_lines.counted_check_ids holds the paychecks a paid bonus was worked out from. '
      + 'Void the pay runs that paid those bonuses before this migration is rolled back.');
  }
  await knex.raw('ALTER TABLE payroll_pay_lines DROP COLUMN counted_check_ids');
};
