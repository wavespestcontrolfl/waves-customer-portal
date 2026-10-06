/**
 * Who set a turf profile's grass type (owner 2026-10-06). A photo AI read that
 * names one known grass may replace a Mixed or Unknown grass, but never a grass
 * staff set in the turf-profile editor; this column is how the write tells them
 * apart. Values: 'staff' | 'estimate' | 'photo_ai' (GRASS_SOURCE in
 * lawn-grass-context.js). NULL = set before this column existed.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('customer_turf_profiles', (t) => {
    t.string('grass_type_source', 20).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('customer_turf_profiles', (t) => {
    t.dropColumn('grass_type_source');
  });
};
