'use strict';

/**
 * Production share, PR 2: a race-free DOWN for payroll_checks.production_share_cents. up makes sure the column and its
 * constraint exist (the same idempotent statements as 20261124070000 up).
 *
 * 20261124070000_payroll_production_share (pushed, so frozen) adds the column; its down looks for a stored share and drops the
 * column in separate statements without a table lock, so a pay run that finalizes a check with a share between the look and the
 * drop would lose the figure without a word. A pushed migration is never edited, so this file carries the safe down:
 *   LOCK TABLE payroll_checks IN ACCESS EXCLUSIVE MODE (held to the end of the migration transaction), then refuse when any
 *   production_share_cents is not null, else drop the constraint and the column (IF EXISTS).
 *
 * Both files ship in one PR and so in one batch. A rollback runs the newest migration's down first: THIS down runs, locks, and
 * either refuses (the batch stops, nothing is dropped) or drops the column and its constraint. The down of 070000 then finds no
 * column (its hasColumn guard is false) and its IF EXISTS drops do nothing, so it ends without an error.
 */
exports.up = async function up(knex) {
  // On a normal run the column is already there (20261124070000 ran first) and this changes nothing. It matters after a
  // single-step rollback of THIS migration alone: its down drops the column while 20261124070000 stays recorded as applied, so
  // the next migrate:latest runs only this up, and without these statements the column would stay missing.
  if (!(await knex.schema.hasColumn('payroll_checks', 'production_share_cents'))) {
    await knex.raw('ALTER TABLE payroll_checks ADD COLUMN production_share_cents bigint NULL');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check');
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_production_share_check CHECK (production_share_cents IS NULL OR production_share_cents >= 0)`);
};

exports.down = async function down(knex) {
  await knex.raw('LOCK TABLE payroll_checks IN ACCESS EXCLUSIVE MODE');
  // A check that paid a production share is payroll evidence: preserve it and roll forward.
  if (await knex.schema.hasColumn('payroll_checks', 'production_share_cents')
    && await knex('payroll_checks').whereNotNull('production_share_cents').first('id')) {
    throw new Error('payroll_checks holds production share figures. Preserve the schema and roll forward; do not drop it.');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS production_share_cents');
};
