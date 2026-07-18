/**
 * Photos captured before a visit is completed cannot reference service_records
 * yet. Stage them against the scheduled visit, then promote them into the
 * immutable service_photos chain inside the completion transaction.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('scheduled_service_photo_staging')) return;
  await knex.schema.createTable('scheduled_service_photo_staging', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.uuid('technician_id').notNullable()
      .references('id').inTable('technicians').onDelete('CASCADE');
    t.string('photo_type', 20).notNullable();
    t.string('s3_key', 500).notNullable().unique();
    t.string('caption', 200);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.decimal('gps_lat', 9, 6);
    t.decimal('gps_lng', 9, 6);
    t.timestamp('captured_at').notNullable().defaultTo(knex.fn.now());
    t.string('image_sha256', 64).notNullable();
    t.timestamps(true, true);
    t.unique(['scheduled_service_id', 'image_sha256'], {
      indexName: 'scheduled_service_photo_staging_visit_image_unique',
    });
    t.index(['scheduled_service_id', 'captured_at'], 'scheduled_service_photo_staging_visit_idx');
  });
  await knex.raw(`
    ALTER TABLE scheduled_service_photo_staging
    ADD CONSTRAINT scheduled_service_photo_staging_type_check
    CHECK (photo_type IN ('before', 'after', 'issue', 'progress'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('scheduled_service_photo_staging');
};
