exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('service_requests'))) return;
  if (!(await knex.schema.hasColumn('service_requests', 'status_version'))) {
    await knex.schema.alterTable('service_requests', (t) => t.integer('status_version').notNullable().defaultTo(0));
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('service_requests'))) return;
  if (await knex.schema.hasColumn('service_requests', 'status_version')) {
    await knex.schema.alterTable('service_requests', (t) => t.dropColumn('status_version'));
  }
};
