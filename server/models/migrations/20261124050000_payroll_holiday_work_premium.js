/**
 * Holiday work premium (owner-approved Technician Terms, Holidays: "A paid holiday is 10 hours at your straight rate.
 * Hours you work on the day a holiday is taken are paid at 1.5 times, on top of the holiday pay."; owner *go*
 * 2026-11-23). No gate of its own: it runs where holiday time off already runs (GATE_PAYROLL_TIME_OFF).
 *
 * The hours worked on a holiday are already paid at the straight rate and count as hours worked. The check adds the
 * extra half, round(rate x 0.5 x minutes), as a line of its own ("Holiday work premium").
 *
 * payroll_checks.holiday_work_minutes / holiday_work_premium_cents: the worked minutes of the check that fell on a
 * holiday taken (a payroll_time_off row of kind holiday on that work date) and the extra half they earn. NULL on a
 * check with no such minutes, so every other check keeps exactly its earlier figures. protect_payroll_checks
 * compares whole rows with to_jsonb, so a finalized check cannot change them either.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_checks
    ADD COLUMN holiday_work_minutes numeric(10,2) NULL,
    ADD COLUMN holiday_work_premium_cents bigint NULL`);
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_holiday_work_check CHECK (
      (holiday_work_minutes IS NULL) = (holiday_work_premium_cents IS NULL)
      AND (holiday_work_minutes IS NULL OR (holiday_work_minutes >= 0 AND holiday_work_premium_cents >= 0)))`);
};

exports.down = async function down(knex) {
  // A check that paid the premium is payroll evidence: preserve it and roll forward.
  if (await knex('payroll_checks').whereNotNull('holiday_work_minutes').first('id')) {
    throw new Error('payroll_checks holds holiday work premium. Preserve the schema and roll forward; do not drop it.');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_holiday_work_check');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS holiday_work_premium_cents, DROP COLUMN IF EXISTS holiday_work_minutes');
};
