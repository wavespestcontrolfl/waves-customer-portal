/**
 * service_photo_marks — treated-point marks a technician places on a photo
 * of the area they actually treated (scope: docs/design/treatment-animation-scope.md).
 *
 * Keyed on (scheduled_service_id, s3_key), NOT on service_photos.id, and that
 * is load-bearing rather than a shortcut: a photo taken before completion is
 * written to `scheduled_service_photo_staging`, and promoteStagedServicePhotos
 * later INSERTs a fresh `service_photos` row and DELETEs the staging row. A
 * service_photo_id FK would therefore be destroyed mid-visit for exactly the
 * photos techs mark most often. The S3 key is carried across that promotion
 * verbatim (`insert.s3_key = photo.s3_key`) and is unique per upload
 * (prefix + Date.now() + 4 random bytes + filename), so marks placed on a
 * staged photo survive completion with no remap step and no change to the
 * promotion transaction.
 *
 * Marks are metadata ONLY. They are never composited into the stored image:
 * service_photos carries a tamper-evident hash chain (hash_sha256 /
 * prev_hash_sha256) that re-encoding the bytes would break.
 *
 * Dark by construction: nothing reads this table unless GATE_PHOTO_MARKS is
 * exactly 'true'.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_photo_marks')) return;
  await knex.schema.createTable('service_photo_marks', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    // Stable photo identity across the staging → service_photos promotion.
    t.text('s3_key').notNullable();
    // Display number, 1-based, assigned in placement order.
    t.integer('mark_number').notNullable();
    // Normalized 0..1 against the stored image — never pixels. Phone photos
    // vary by device and orientation, and the report renders marks as
    // percentage offsets so the card holds up at any width.
    t.decimal('x', 8, 6).notNullable();
    t.decimal('y', 8, 6).notNullable();
    // Closed per-lane vocabulary, validated in service-report/photo-marks.js
    // against values the completion form can actually record.
    t.string('kind', 40).notNullable();
    t.uuid('technician_id').references('id').inTable('technicians');
    t.timestamps(true, true);
    t.unique(['scheduled_service_id', 's3_key', 'mark_number']);
    t.index(['scheduled_service_id'], 'service_photo_marks_service_idx');
    t.index(['s3_key'], 'service_photo_marks_s3_key_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_photo_marks'))) return;
  await knex.schema.dropTable('service_photo_marks');
};
