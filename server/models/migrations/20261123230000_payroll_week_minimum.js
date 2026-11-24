/**
 * Minimum paid week (offer letter draft, "40 paid hours in each full workweek"; owner 2026-11-21
 * "lets do these now", rule owner 2026-11-23 *a*: in a week with unpaid time, the minimum is the
 * weekly minimum less the unpaid hours). No gate: the per-technician setting is the switch.
 *
 * technicians.paid_week_minimum_hours: the minimum paid hours of a full workweek as it stands now (what the settings
 * page shows). NULL = none.
 * payroll_week_minimum_changes: each change of it, by the pay week it applies from (the week it was saved in). A pay
 * run reads the newest change on or before its own week, so a week paid late, voided and made again, or reopened
 * keeps the minimum of its own week. No row on or before a week = no minimum. Rows are only added.
 * technicians.paid_week_minimum_last_day: the employee's last day, typed by the owner when they leave (owner
 * 2026-11-23 *a*, "you type the last day"). Its week pays the scheduled days up to it; later weeks pay no minimum.
 *
 * payroll_checks.minimum_week_minutes / minimum_week_pay_cents: the hours the minimum added to the
 * check (not hours worked) and their pay at the straight rate. NULL on a check of a technician with
 * no minimum, so every other check keeps exactly its earlier figures. protect_payroll_checks
 * compares whole rows with to_jsonb, so a finalized check cannot change them either.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE technicians
    ADD COLUMN paid_week_minimum_hours numeric(5,2) NULL
      CONSTRAINT technicians_paid_week_minimum_hours_check
      CHECK (paid_week_minimum_hours IS NULL OR (paid_week_minimum_hours > 0 AND paid_week_minimum_hours <= 40)),
    ADD COLUMN paid_week_minimum_last_day date NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN minimum_week_minutes numeric(10,2) NULL,
    ADD COLUMN minimum_week_pay_cents bigint NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_minimum_week_check CHECK (
      (minimum_week_minutes IS NULL) = (minimum_week_pay_cents IS NULL)
      AND (minimum_week_minutes IS NULL OR (minimum_week_minutes >= 0 AND minimum_week_pay_cents >= 0)))`);
  await knex.raw(`CREATE TABLE payroll_week_minimum_changes (
    id bigserial PRIMARY KEY,
    technician_id uuid NOT NULL REFERENCES technicians(id),
    from_week date NOT NULL CONSTRAINT payroll_week_minimum_changes_monday_check CHECK (EXTRACT(ISODOW FROM from_week) = 1),
    hours numeric(5,2) NULL CONSTRAINT payroll_week_minimum_changes_hours_check CHECK (hours IS NULL OR (hours > 0 AND hours <= 40)),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payroll_week_minimum_changes_week_unique UNIQUE (technician_id, from_week)
  )`);
};

exports.down = async function down(knex) {
  // A check that paid a minimum is payroll evidence: preserve it and roll forward.
  if (await knex('payroll_checks').whereNotNull('minimum_week_minutes').first('id')) {
    throw new Error('payroll_checks holds minimum week pay. Preserve the schema and roll forward; do not drop it.');
  }
  // A minimum the owner set is a pay promise on file: rolling back would lose it without a word.
  if (await knex('technicians').whereNotNull('paid_week_minimum_hours').orWhereNotNull('paid_week_minimum_last_day').first('id')) {
    throw new Error('technicians holds a minimum paid week setting. Clear it first, or roll forward; do not drop it.');
  }
  if (await knex('payroll_week_minimum_changes').first('id')) {
    throw new Error('payroll_week_minimum_changes holds the minimum by pay week. Roll forward; do not drop it.');
  }
  await knex.raw('DROP TABLE IF EXISTS payroll_week_minimum_changes');
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_minimum_week_check');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS minimum_week_pay_cents, DROP COLUMN IF EXISTS minimum_week_minutes');
  await knex.raw('ALTER TABLE technicians DROP COLUMN IF EXISTS paid_week_minimum_last_day, DROP COLUMN IF EXISTS paid_week_minimum_hours');
};
