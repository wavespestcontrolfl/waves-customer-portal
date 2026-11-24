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
 * protect_payroll_pay_lines compares the whole row, so a paid line's list cannot change. `down` takes the payroll lock and
 * refuses while any line, open or paid, holds a list. A pushed migration is frozen: a fix is another file.
 */
const { lockPayrollMutations } = require('../../services/payroll-lock');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  if (!(await knex.schema.hasColumn('payroll_pay_lines', 'counted_check_ids'))) {
    await knex.raw('ALTER TABLE payroll_pay_lines ADD COLUMN counted_check_ids uuid[] NULL');
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  if (!(await knex.schema.hasColumn('payroll_pay_lines', 'counted_check_ids'))) return;
  // The payroll lock first, held to the end of this migration's transaction (knex runs a migration in one): every pay run
  // write that sets a list or pays its line holds it, so none can slip in between the read below and the DROP.
  await lockPayrollMutations(knex);
  // Refused while ANY pay line holds a list. A paid line's list is payroll evidence: it is what keeps a counted pay run from
  // being voided under a paid bonus, and running `up` again would leave it empty. An open line with a list is a stay bonus
  // the pay run wrote: the release before this column does not know that line as its own and would carry it forward and pay
  // its old amount. DDL fires no row trigger, so nothing else would stop either.
  const held = await knex('payroll_pay_lines').whereNotNull('counted_check_ids').first('id');
  if (held) {
    throw new Error('payroll_pay_lines.counted_check_ids is in use: a stay bonus line holds the paychecks it was worked out from. '
      + 'This migration is not rolled back while one does. Turn GATE_TECH_REWARDS_STAY_BONUS off and recompute the draft pay runs '
      + '(the open lines come off). A paid stay bonus stays as payroll evidence: fix forward.');
  }
  await knex.raw('ALTER TABLE payroll_pay_lines DROP COLUMN counted_check_ids');
};
