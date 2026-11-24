/**
 * Time-off bank (owner 2026-11-21, "lets do these now"; handbook draft, section
 * "Paid time off"). No gate of its own: a W-2 technician has a bank when
 * technicians.pto_hours_per_year is set, and GATE_PAYROLL_TIME_OFF still gates
 * every time-off path. Additive.
 *
 * payroll_checks.pto_earned_minutes: the time-off minutes this check added to the
 * technician's bank. NULL on a check of a technician with no bank (every check
 * made before this migration too). The bank is not a table: it is the sum over a
 * technician's finalized checks of (pto_earned_minutes - pto_minutes), so a
 * voided run leaves the sum by its status alone. A NULL column with no default
 * rewrites no row and fires no trigger; protect_payroll_checks compares whole
 * rows with to_jsonb, so a finalized check cannot change the new column either.
 *
 * payroll_checks.pto_early_illness_minutes: the part of this check's paid time off
 * that was an illness day up to day 90 of the job. The handbook pays at most 16
 * such hours in all, so each check keeps its own count; summing all paid time off
 * instead would count a later vacation day against that limit when pay dates are
 * out of week order. NULL on a check with no bank.
 *
 * payroll_runs.unpaid_time_off: the time off this run did not pay, with the reason
 * of each, written when the run is finalized (NULL when there was none). A
 * technician whose time off was all unpaid gets no check, so without this the
 * finalized run would keep no record of that decision. protect_payroll_runs lets
 * a draft row change and freezes a finalized one, so it is evidence from then on.
 *
 * payroll_time_off.illness: this paid-time-off day is for illness. Before day 90
 * of the job the bank pays illness only (services/payroll-time-off-bank.js). A
 * holiday is never an illness day.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN pto_earned_minutes numeric(10,2) NULL
      CONSTRAINT payroll_checks_pto_earned_check CHECK (pto_earned_minutes IS NULL OR pto_earned_minutes >= 0),
    ADD COLUMN pto_early_illness_minutes numeric(10,2) NULL
      CONSTRAINT payroll_checks_pto_early_illness_check CHECK (
        pto_early_illness_minutes IS NULL
        OR (pto_earned_minutes IS NOT NULL AND pto_early_illness_minutes >= 0 AND pto_early_illness_minutes <= pto_minutes)
      )`);
  await knex.raw(`ALTER TABLE payroll_runs
    ADD COLUMN unpaid_time_off jsonb NULL
      CONSTRAINT payroll_runs_unpaid_time_off_check CHECK (unpaid_time_off IS NULL OR jsonb_typeof(unpaid_time_off) = 'array')`);
  await knex.raw(`ALTER TABLE payroll_time_off
    ADD COLUMN illness boolean NOT NULL DEFAULT false
      CONSTRAINT payroll_time_off_illness_check CHECK (illness = false OR kind = 'pto')`);
};

exports.down = async function down(knex) {
  // Lock the three tables before the checks. A finalize or a time-off save that commits between a check
  // and the DROP below would lose what it wrote. ALTER TABLE takes this lock anyway; taking it first makes
  // the checks hold until the columns are gone.
  await knex.raw('LOCK TABLE payroll_checks, payroll_runs, payroll_time_off IN ACCESS EXCLUSIVE MODE');
  // Hours a check earned and the illness mark of a paid day are payroll evidence: preserve them and roll forward.
  if (await knex.schema.hasColumn('payroll_checks', 'pto_earned_minutes')
    && await knex('payroll_checks').whereNotNull('pto_earned_minutes').first('id')) {
    throw new Error('payroll_checks holds time-off bank hours. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_time_off', 'illness')
    && await knex('payroll_time_off').where({ illness: true }).first('id')) {
    throw new Error('payroll_time_off holds illness days. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_runs', 'unpaid_time_off')
    && await knex('payroll_runs').whereNotNull('unpaid_time_off').first('id')) {
    throw new Error('payroll_runs holds time off that was not paid. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE payroll_time_off DROP COLUMN IF EXISTS illness');
  await knex.raw('ALTER TABLE payroll_runs DROP COLUMN IF EXISTS unpaid_time_off');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS pto_early_illness_minutes');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS pto_earned_minutes');
};
