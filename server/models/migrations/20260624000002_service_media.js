/**
 * Tech-captured recap media — the iPhone clips/photos that feed "Your Visit, in
 * Motion" (Pest Report V2 lane). Uploaded direct browser→S3 (presigned PUT), one
 * row per clip, tagged with the action `role` the tech tapped (perimeter/eaves/
 * pest/…). recap-payload reads the ready rows → the composition's media[] slots;
 * the friendly customer caption is derived server-side from `role` (never trusted
 * from the client). Gated behind the same flags as the recap; inert otherwise.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_media')) return;
  await knex.schema.createTable('service_media', (t) => {
    t.bigIncrements('id').primary();
    t.integer('service_record_id').notNullable();
    t.string('media_type', 10).notNullable().defaultTo('video'); // video | image
    t.string('role', 40); // tech chip id (perimeter, eaves, pest, before, after, …)
    t.string('caption'); // friendly customer caption, derived from role server-side
    t.string('s3_key').notNullable();
    t.string('content_type');
    t.string('status', 15).notNullable().defaultTo('uploading'); // uploading | ready | failed
    t.integer('bytes');
    t.integer('duration_ms');
    t.string('captured_by');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.index(['service_record_id', 'status'], 'service_media_record_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_media');
};
