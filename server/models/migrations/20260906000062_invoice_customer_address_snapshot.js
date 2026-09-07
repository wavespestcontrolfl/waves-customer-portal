exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'customer_address_snapshot'))) {
    await knex.schema.alterTable('invoices', table => table.jsonb('customer_address_snapshot').nullable());
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'customer_address_snapshot')) {
    await knex.schema.alterTable('invoices', table => table.dropColumn('customer_address_snapshot'));
  }
};
