exports.up = async function up(knex) {
  if (await knex.schema.hasTable('property_basemap_assets')) return;

  await knex.schema.createTable('property_basemap_assets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    t.text('provider').notNullable();
    t.text('map_type').notNullable();
    t.decimal('center_lat', 10, 7);
    t.decimal('center_lng', 10, 7);
    t.integer('zoom');
    t.jsonb('bounds').notNullable();
    t.integer('width').notNullable();
    t.integer('height').notNullable();
    t.text('storage_key');
    t.text('public_url');
    t.text('content_type');
    t.text('attribution_text');
    t.text('attribution_html');
    t.jsonb('license_capabilities').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('expires_at', { useTz: true });
    t.text('status').notNullable().defaultTo('active');
    t.timestamps(true, true);
    t.index(['customer_id', 'provider', 'status'], 'idx_property_basemap_assets_customer_provider');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('property_basemap_assets');
};
