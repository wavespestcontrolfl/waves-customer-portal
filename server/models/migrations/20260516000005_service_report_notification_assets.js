exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_report_notification_assets')) return;

  await knex.schema.createTable('service_report_notification_assets', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('service_record_id')
      .notNullable()
      .references('id')
      .inTable('service_records')
      .onDelete('CASCADE');
    t.text('asset_type').notNullable();
    t.text('storage_key').notNullable();
    t.text('public_url');
    t.text('content_type').notNullable();
    t.integer('width').notNullable();
    t.integer('height').notNullable();
    t.integer('byte_size').notNullable();
    t.text('input_hash').notNullable();
    t.text('render_version').notNullable();
    t.timestamps(true, true);
    t.unique(['service_record_id', 'asset_type', 'input_hash', 'render_version'], 'uniq_service_report_notification_asset');
  });

  await knex.raw(`
    CREATE INDEX idx_service_report_notification_assets_record
    ON service_report_notification_assets (service_record_id, asset_type)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_service_report_notification_assets_record');
  await knex.schema.dropTableIfExists('service_report_notification_assets');
};
