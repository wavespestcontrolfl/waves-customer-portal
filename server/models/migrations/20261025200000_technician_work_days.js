'use strict';

/**
 * technicians.work_days — the weekdays this technician works (owner 2026-10-25:
 * a second technician starts early 2027 on a fixed 4x10 week, Monday to
 * Thursday; the owner covers Friday to Sunday and every gap).
 *
 * smallint[] of JS day-of-week ints, 0 = Sunday ... 6 = Saturday (the same
 * encoding as the system_settings key `schedule_weekly_days_off`). NULL means
 * "works every day", which is today's behavior for everyone, so the column
 * adds no behavior by itself.
 *
 * Read only behind GATE_TECH_WORK_DAYS (technician-eligibility.js
 * techWorkDaysLive): with the gate on, slot offers and automatic placement
 * skip the technician on a day they do not work; office paths only warn.
 * The Team tab edits it (PUT/POST /admin/timetracking/technicians `workDays`).
 *
 * CHECK: NULL, or a one-dimensional array of 1 to 7 elements that are each a
 * day 0..6. Duplicates are not expressible in a CHECK without a subquery, so
 * the API refuses them. Additive and idempotent (hasColumn guard).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'work_days')) return;
  await knex.raw('ALTER TABLE technicians ADD COLUMN work_days smallint[] NULL');
  await knex.raw(`
    ALTER TABLE technicians
    ADD CONSTRAINT technicians_work_days_check
    CHECK (
      work_days IS NULL
      OR (
        array_ndims(work_days) = 1
        AND cardinality(work_days) BETWEEN 1 AND 7
        AND work_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
      )
    )
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'work_days'))) return;
  await knex.raw('ALTER TABLE technicians DROP CONSTRAINT IF EXISTS technicians_work_days_check');
  await knex.raw('ALTER TABLE technicians DROP COLUMN work_days');
};
