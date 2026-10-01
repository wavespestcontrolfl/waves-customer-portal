/**
 * Visit prep photos — dark server foundation (GATE_VISIT_PREP_PHOTOS).
 *
 * Customers will attach photos + a short note to a SPECIFIC upcoming visit
 * from the public tokened appointment page (/appointment/:token) so the
 * technician sees them before the visit. This migration only creates the
 * storage: a submission row (note/topic/location) plus its photo rows.
 *
 * `visit_prep_photos.scheduled_service_id` is deliberately denormalized off
 * the parent submission (also `scheduled_service_id`-scoped) so the dedupe
 * unique index and the per-visit photo cap can both query the photos table
 * directly without a join back to submissions.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_prep_submissions'))) {
    await knex.schema.createTable('visit_prep_submissions', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('visit_id').references('id').inTable('service_visits').onDelete('SET NULL');
      t.uuid('customer_id').notNullable().references('id').inTable('customers');
      t.uuid('property_id').references('id').inTable('customer_properties').onDelete('SET NULL');
      // Validated in code (visit-prep.js TOPICS) — no CHECK constraint per
      // the brief; keeps the allowed set changeable without a migration.
      t.string('topic', 20);
      t.string('location_on_property', 50);
      t.text('note');
      t.string('entry', 30).notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['scheduled_service_id']);
      t.index(['visit_id']);
    });
  }

  if (!(await knex.schema.hasTable('visit_prep_photos'))) {
    await knex.schema.createTable('visit_prep_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('submission_id').notNullable().references('id').inTable('visit_prep_submissions').onDelete('CASCADE');
      // Denormalized for dedupe + cap counting (see header comment).
      t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.text('s3_key').notNullable();
      t.string('mime_type', 50).notNullable();
      t.integer('byte_size').notNullable();
      t.string('image_sha256', 64).notNullable();
      t.smallint('photo_index').notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['scheduled_service_id', 'image_sha256'], { indexName: 'visit_prep_photos_service_hash_uniq' });
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_prep_photos');
  await knex.schema.dropTableIfExists('visit_prep_submissions');
};
