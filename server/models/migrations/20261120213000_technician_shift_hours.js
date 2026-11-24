'use strict';

/**
 * technicians.shift_start / technicians.shift_end — the hours this technician
 * works on a work day (owner 2026-11-19, ad budget rule v2 page item D4, "shift
 * with hire": "each tech's 10-hour day on every booking path, ready before
 * Jan 1"; "Today Adam is the only tech and works 8 AM to 6 PM every day").
 *
 * Eastern wall-clock `time` values, the same type as booking_config.day_start
 * and day_end. Both NULL means "no set hours", which is today's behavior for
 * everyone, so the columns add no behavior by themselves. The work days stay
 * in technicians.work_days; these are the hours of each of those days.
 *
 * Read only behind GATE_TECH_SHIFT_HOURS (technician-eligibility.js
 * loadTechShifts). The Team tab edits them (PUT/POST
 * /admin/timetracking/technicians `shiftHours`).
 *
 * CHECK: both NULL, or both set with the end after the start (one day; no
 * overnight shift). Additive and idempotent (hasColumn guard).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'shift_start')) return;
  await knex.raw('ALTER TABLE technicians ADD COLUMN shift_start time NULL, ADD COLUMN shift_end time NULL');
  await knex.raw(`
    ALTER TABLE technicians
    ADD CONSTRAINT technicians_shift_hours_check
    CHECK (
      (shift_start IS NULL AND shift_end IS NULL)
      OR (shift_start IS NOT NULL AND shift_end IS NOT NULL AND shift_end > shift_start)
    )
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'shift_start'))) return;
  await knex.raw('ALTER TABLE technicians DROP CONSTRAINT IF EXISTS technicians_shift_hours_check');
  await knex.raw('ALTER TABLE technicians DROP COLUMN shift_start, DROP COLUMN shift_end');
};
