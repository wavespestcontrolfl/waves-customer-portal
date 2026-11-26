'use strict';

/**
 * Truck sets the shift start (GATE_TRUCK_CLOCK_IN = start, owner 2026-11-26). The follow-up job
 * services/truck-start-apply.js reads each truck_clock_in_shadow row of the current Eastern work
 * day once and records what it did on that row:
 *
 *   applied_at      when the job finished with the row. NULL = not processed yet. A row with a
 *                   value is never processed again (the job locks the row, writes the shift and
 *                   this stamp in one transaction, so a crash before commit leaves it NULL).
 *   applied_action  clocked_in | moved_earlier | ok_within_tolerance | flag_early_tap |
 *                   needs_review | skipped:<reason>. Free text on purpose.
 *   applied_detail  jsonb: the numbers behind the action (minutes, the shift id, the original
 *                   start) and whether the owner bell went out (notified).
 *   event_time_known  true when event_at is the GPS sample's own time; false when the receiver
 *                   had none and used its own clock. The job writes pay only from a known time.
 *
 * Additive and idempotent. Nothing reads these columns except the job.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('truck_clock_in_shadow'))) return;
  const add = async (name, build) => {
    if (!(await knex.schema.hasColumn('truck_clock_in_shadow', name))) {
      await knex.schema.alterTable('truck_clock_in_shadow', build);
    }
  };
  await add('applied_at', (t) => t.timestamp('applied_at', { useTz: true }));
  await add('applied_action', (t) => t.string('applied_action', 60));
  await add('applied_detail', (t) => t.jsonb('applied_detail'));
  await add('event_time_known', (t) => t.boolean('event_time_known'));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('truck_clock_in_shadow'))) return;
  for (const column of ['event_time_known', 'applied_detail', 'applied_action', 'applied_at']) {
    if (await knex.schema.hasColumn('truck_clock_in_shadow', column)) {
      await knex.schema.alterTable('truck_clock_in_shadow', (t) => t.dropColumn(column));
    }
  }
};
