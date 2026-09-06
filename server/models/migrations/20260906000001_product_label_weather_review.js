// Weather evidence is scoped separately from label_verified_at, which also
// authorizes mixing rates. This migration certifies no products or rates.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'label_weather_review'))) {
    await knex.schema.alterTable('products_catalog', (t) => t.jsonb('label_weather_review'));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (await knex.schema.hasColumn('products_catalog', 'label_weather_review')) {
    await knex.schema.alterTable('products_catalog', (t) => t.dropColumn('label_weather_review'));
  }
};
