/** Preserve the combined reservation's capacity policy across deploys and gate changes. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'reservation_service_mix'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.jsonb('reservation_service_mix').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'reservation_service_mix')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('reservation_service_mix');
    });
  }
};
