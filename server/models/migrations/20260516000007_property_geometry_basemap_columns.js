async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'property_geometries', 'coordinate_system', (t) => (
    t.text('coordinate_system').notNullable().defaultTo('local_svg')
  ));
  await addColumnIfMissing(knex, 'property_geometries', 'basemap_asset_id', (t) => (
    t.uuid('basemap_asset_id').references('id').inTable('property_basemap_assets').onDelete('SET NULL')
  ));
  await addColumnIfMissing(knex, 'property_geometries', 'bounds', (t) => t.jsonb('bounds'));
  await addColumnIfMissing(knex, 'property_zones', 'geometry_geojson', (t) => t.jsonb('geometry_geojson'));
  await addColumnIfMissing(knex, 'property_zones', 'geometry_image', (t) => t.jsonb('geometry_image'));
};

exports.down = async function down(knex) {
  await dropColumnIfPresent(knex, 'property_zones', 'geometry_image');
  await dropColumnIfPresent(knex, 'property_zones', 'geometry_geojson');
  await dropColumnIfPresent(knex, 'property_geometries', 'bounds');
  await dropColumnIfPresent(knex, 'property_geometries', 'basemap_asset_id');
  await dropColumnIfPresent(knex, 'property_geometries', 'coordinate_system');
};
