'use strict';

/**
 * Tech Rewards Plan D5-5: what a pay run's Tech Rewards sync left waiting (owner rulings 2026-11-20). Additive, dark behind
 * GATE_TECH_REWARDS_PAY_LINES.
 *
 *   payroll_runs.tech_rewards_waits   the lines that waited at the run's latest sync, as
 *                                     [{ technician_id, kind, source_id, reason, week }] (ids, reason codes and dates, never an
 *                                     amount). Nullable, null on every existing run. The sync replaces it while the run is a
 *                                     draft (server/services/tech-rewards-pay-lines.js); the run view turns it into plain notes.
 *
 * protect_payroll_runs lets a draft run row change and refuses a change to a finalized or voided one; that trigger is not
 * touched. A pushed migration is frozen: a fix is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_runs'))) return;
  if (!(await knex.schema.hasColumn('payroll_runs', 'tech_rewards_waits'))) {
    await knex.raw('ALTER TABLE payroll_runs ADD COLUMN tech_rewards_waits jsonb NULL');
  }
};

exports.down = async function down(knex) {
  // The waits are notes, not payroll evidence. DDL fires no row trigger, so the column goes from finalized runs too.
  if (await knex.schema.hasTable('payroll_runs')) await knex.raw('ALTER TABLE payroll_runs DROP COLUMN IF EXISTS tech_rewards_waits');
};
