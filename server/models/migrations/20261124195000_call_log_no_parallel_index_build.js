'use strict';

/**
 * Keep the call_log index builds of migration 20261124200000 out of parallel workers.
 *
 * That migration builds an expression index over call_log_v1_phone(text), a function with an EXCEPTION block (a subtransaction),
 * which a parallel worker cannot run. The function's PARALLEL UNSAFE marking (20261124210000) arrives AFTER those builds, so until
 * then it is still marked SAFE. This migration sorts BEFORE 20261124200000 and sets the table storage parameter
 * parallel_workers = 0, which also disables parallel workers for CREATE INDEX on the table. 20261124220000 resets it once the
 * function is marked UNSAFE. Neither earlier migration is edited.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER TABLE call_log SET (parallel_workers = 0)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER TABLE call_log RESET (parallel_workers)');
};
