'use strict';

/**
 * Production share, PR 2: the PAY LINE (Technician Terms v3, "Production share"; owner 2026-11-24). Additive.
 *
 *   payroll_checks.production_share_cents   the production share a check paid for its own pay week, in cents. NULL on every
 *                                           existing check and on any check drafted with GATE_PAYROLL_PRODUCTION_SHARE off or for a
 *                                           technician with no production share settings that week. 0 = settings were in force
 *                                           and the week earned nothing above the bar. It is in gross pay (taxable wages).
 *   payroll_checks.calc_snapshot            (existing jsonb) also holds productionShare: the credit the share was worked out
 *                                           from (credited, bar, above bar, rate, bar type, shifts and one row per stop). A
 *                                           finalized check's snapshot is frozen with the row.
 *
 * protect_payroll_checks compares whole rows with to_jsonb, so a finalized check cannot change the new column either; that
 * trigger is not touched. A pushed migration is frozen: a fix is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('payroll_checks', 'production_share_cents'))) {
    await knex.raw('ALTER TABLE payroll_checks ADD COLUMN production_share_cents bigint NULL');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check');
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_production_share_check CHECK (production_share_cents IS NULL OR production_share_cents >= 0)`);
};

exports.down = async function down(knex) {
  // Lock first, hold to the end of the migration transaction: a pay run that finalizes a check with a share between the check
  // below and the drop would otherwise lose the figure without a word.
  await knex.raw('LOCK TABLE payroll_checks IN ACCESS EXCLUSIVE MODE');
  // A check that paid a production share is payroll evidence: preserve it and roll forward.
  if (await knex.schema.hasColumn('payroll_checks', 'production_share_cents')
    && await knex('payroll_checks').whereNotNull('production_share_cents').first('id')) {
    throw new Error('payroll_checks holds production share figures. Preserve the schema and roll forward; do not drop it.');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS production_share_cents');
};
