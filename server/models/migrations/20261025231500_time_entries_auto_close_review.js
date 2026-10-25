'use strict';

/**
 * time_entries auto-close review (census H8, owner 2026-10-25): a shift the
 * 11 PM job or the 14-hour check closes for a technician who forgot to clock
 * out is marked here so an admin must look at it before payroll pays it.
 *
 *   auto_closed_at          when the system closed the shift (NULL = a person did)
 *   auto_close_reason       'cron_11pm' or 'over_14_hours'
 *   auto_close_reviewed_at  when an admin cleared it (edit of the clock-out, or Confirm)
 *   auto_close_reviewed_by  the admin technician row that cleared it
 *
 * Written only behind GATE_SHIFT_CLOSE_REVIEW (services/time-tracking.js);
 * with the gate off every column stays NULL and nothing reads differently.
 * Additive and idempotent (hasColumn guards). The partial index serves the
 * payroll "unreviewed automatic clock-out" check and holds no rows today.
 */
const COLUMNS = ['auto_closed_at', 'auto_close_reason', 'auto_close_reviewed_at', 'auto_close_reviewed_by'];

exports.up = async function up(knex) {
  const has = (column) => knex.schema.hasColumn('time_entries', column);
  if (!(await has('auto_closed_at'))) {
    await knex.schema.alterTable('time_entries', (t) => t.timestamp('auto_closed_at', { useTz: true }).nullable());
  }
  if (!(await has('auto_close_reason'))) {
    await knex.schema.alterTable('time_entries', (t) => t.text('auto_close_reason').nullable());
  }
  if (!(await has('auto_close_reviewed_at'))) {
    await knex.schema.alterTable('time_entries', (t) => t.timestamp('auto_close_reviewed_at', { useTz: true }).nullable());
  }
  if (!(await has('auto_close_reviewed_by'))) {
    await knex.schema.alterTable('time_entries', (t) => t.uuid('auto_close_reviewed_by').nullable());
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS time_entries_auto_close_unreviewed_idx
    ON time_entries (technician_id, clock_in)
    WHERE auto_closed_at IS NOT NULL AND auto_close_reviewed_at IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS time_entries_auto_close_unreviewed_idx');
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('time_entries', column)) {
      await knex.schema.alterTable('time_entries', (t) => t.dropColumn(column));
    }
  }
};
