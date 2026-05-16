async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_photos'))) return;
  await addColumnIfMissing(knex, 'service_photos', 'sort_order', (t) => t.integer('sort_order').notNullable().defaultTo(0));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_photos'))) return;
  await dropColumnIfPresent(knex, 'service_photos', 'sort_order');
};
