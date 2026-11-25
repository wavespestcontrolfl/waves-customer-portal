'use strict';

/**
 * Undo 20261124195000: call_log may use parallel workers again.
 *
 * call_log_v1_phone(text) is PARALLEL UNSAFE since 20261124210000, so the planner never puts it in a parallel worker, and the
 * table no longer needs the parallel_workers = 0 guard that kept the index builds of 20261124200000 serial.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER TABLE call_log RESET (parallel_workers)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER TABLE call_log SET (parallel_workers = 0)');
};
