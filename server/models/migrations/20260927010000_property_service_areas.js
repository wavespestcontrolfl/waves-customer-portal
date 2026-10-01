exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'service_area_measurements'))) {
    await knex.schema.alterTable('customer_properties', (table) => {
      table.jsonb('service_area_measurements').notNullable().defaultTo('{}');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (await knex.schema.hasColumn('customer_properties', 'service_area_measurements')) {
    await knex.schema.alterTable('customer_properties', (table) => table.dropColumn('service_area_measurements'));
  }
};
