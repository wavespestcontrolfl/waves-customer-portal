async function hasColumn(knex, table, column) {
  return knex.schema.hasTable(table).then((exists) => (exists ? knex.schema.hasColumn(table, column) : false));
}

exports.up = async function up(knex) {
  if (await hasColumn(knex, 'products_catalog', 'active_ingredient')) {
    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN active_ingredient DROP NOT NULL').catch(() => {});
  }
  if (await hasColumn(knex, 'products_catalog', 'epa_reg_number')) {
    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN epa_reg_number DROP NOT NULL').catch(() => {});
  }
};

exports.down = async function down() {
  // Intentionally left empty. Re-applying NOT NULL here can break product inserts
  // in environments where existing writers still omit these optional label fields.
};
