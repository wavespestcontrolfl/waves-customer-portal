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
  await addColumnIfMissing(knex, 'service_photos', 'image_sha256', (t) => t.string('image_sha256', 64));
  const hasCapturedAt = await knex.schema.hasColumn('service_photos', 'captured_at');
  await knex.raw(hasCapturedAt
    ? 'CREATE INDEX IF NOT EXISTS idx_service_photos_hash_chain ON service_photos(service_record_id, captured_at, created_at)'
    : 'CREATE INDEX IF NOT EXISTS idx_service_photos_hash_chain ON service_photos(service_record_id, created_at)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_photos'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_service_photos_hash_chain');
  await dropColumnIfPresent(knex, 'service_photos', 'image_sha256');
};
