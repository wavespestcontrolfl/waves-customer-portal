async function hasColumn(knex, table, column) {
  return knex.schema.hasTable(table).then((exists) => (exists ? knex.schema.hasColumn(table, column) : false));
}

exports.up = async function up(knex) {
  if (!(await hasColumn(knex, 'service_records', 'conditions'))) return;
  await knex.raw(`
    UPDATE service_records
    SET conditions = NULL
    WHERE conditions IS NOT NULL
      AND conditions->>'source' = 'FAWN'
      AND conditions->>'temp_f' = '0'
      AND conditions->>'humidity_pct' = '0'
      AND conditions->>'wind_mph' = '0'
  `).catch(() => {});
};

exports.down = async function down() {
};
