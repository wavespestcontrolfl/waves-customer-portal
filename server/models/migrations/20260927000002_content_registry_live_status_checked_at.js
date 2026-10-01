/**
 * Durable rotation watermark for the bounded content-registry live sweep.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('content_registry', 'live_status_checked_at'))) {
    await knex.schema.alterTable('content_registry', (table) => {
      table.timestamp('live_status_checked_at', { useTz: true }).nullable();
      table.index(['live_status_checked_at'], 'idx_content_registry_live_checked_at');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('content_registry', 'live_status_checked_at')) {
    await knex.schema.alterTable('content_registry', (table) => {
      table.dropIndex(['live_status_checked_at'], 'idx_content_registry_live_checked_at');
      table.dropColumn('live_status_checked_at');
    });
  }
};
