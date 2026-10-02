/**
 * Index half of the neighborhood_access schema repair. 20261001190100 adds a
 * missing customer_properties.neighborhood_id column but not its index (that
 * file has run on preview databases and cannot be edited). Recreate the index
 * under knex's default name for t.index(['neighborhood_id']) — the name
 * 20261001190000's down() drops — so a repaired schema can still roll back.
 *
 * down() is a documented no-op: the index belongs to 20261001190000.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('customer_properties', 'neighborhood_id'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS customer_properties_neighborhood_id_index ON customer_properties (neighborhood_id)');
};

exports.down = async function down() {
  // No-op by design — see the header.
};
