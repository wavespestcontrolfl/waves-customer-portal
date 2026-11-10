/**
 * Pay rate steps: the portal may cancel a step itself.
 *
 * A step is for a W-2 employee. When the technician was made a contractor after the step was scheduled,
 * applyDueSteps() (services/payroll-rate-steps.js) cancels the step on the day it is due instead of
 * changing the profile rate. No admin did that, so cancelled_by stays empty.
 *
 * 20261109120000 required cancelled_by on every cancelled step. This file relaxes that one CHECK: an
 * admin's name still needs a cancel beside it; a cancel with no name is the portal's own.
 * (A new file, not an edit of the first: the first has already run on the PR's preview database.)
 */
const TABLE = 'payroll_rate_steps';
const CHECK = 'payroll_rate_steps_cancelled_by_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE}
    DROP CONSTRAINT IF EXISTS ${CHECK},
    ADD CONSTRAINT ${CHECK} CHECK (cancelled_by IS NULL OR cancelled_at IS NOT NULL)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex(TABLE).whereNotNull('cancelled_at').whereNull('cancelled_by').first('id')) {
    throw new Error('payroll_rate_steps holds steps the portal cancelled itself (no cancelled_by). Preserve the schema and roll forward.');
  }
  await knex.raw(`ALTER TABLE ${TABLE}
    DROP CONSTRAINT IF EXISTS ${CHECK},
    ADD CONSTRAINT ${CHECK} CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))`);
};
