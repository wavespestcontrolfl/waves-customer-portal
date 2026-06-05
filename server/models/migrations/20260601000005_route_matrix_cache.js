exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('route_matrix_cache');
  if (exists) return;

  await knex.schema.createTable('route_matrix_cache', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('origin_key', 40).notNullable();
    t.decimal('origin_lat', 10, 6).notNullable();
    t.decimal('origin_lng', 10, 6).notNullable();
    t.string('destination_key', 40).notNullable();
    t.decimal('destination_lat', 10, 6).notNullable();
    t.decimal('destination_lng', 10, 6).notNullable();
    t.integer('distance_meters').notNullable().defaultTo(0);
    t.integer('duration_minutes').notNullable().defaultTo(0);
    t.string('source', 40).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['origin_key', 'destination_key'], 'uq_route_matrix_cache_pair');
    t.index(['expires_at'], 'idx_route_matrix_cache_expires_at');
    t.index(['source'], 'idx_route_matrix_cache_source');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('route_matrix_cache');
};
