'use strict';

/**
 * call_log_v1_phone(text) (migration 20261124200000) is PARALLEL UNSAFE.
 *
 * A function with an EXCEPTION block opens a subtransaction, and Postgres refuses to run a subtransaction inside a
 * parallel worker, so declaring it PARALLEL SAFE could fail a parallel plan at run time. It stays IMMUTABLE (its result
 * depends on nothing but the argument, which the expression index needs). The earlier migration is frozen, so this one
 * corrects the marking in place; the function body is untouched.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER FUNCTION call_log_v1_phone(text) PARALLEL UNSAFE');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw('ALTER FUNCTION call_log_v1_phone(text) PARALLEL SAFE');
};
