'use strict';

/**
 * A post-commit resolution broadcast must prove which UPDATE survived. A
 * savepoint rollback and a later parent UPDATE share PostgreSQL's transaction-
 * stable now(), so resolved_at cannot distinguish their callbacks.
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasColumn('dispatch_alerts', 'resolution_attempt_id');
  if (!exists) {
    await knex.schema.alterTable('dispatch_alerts', (table) => {
      table.uuid('resolution_attempt_id').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasColumn('dispatch_alerts', 'resolution_attempt_id');
  if (exists) {
    await knex.schema.alterTable('dispatch_alerts', (table) => {
      table.dropColumn('resolution_attempt_id');
    });
  }
};
