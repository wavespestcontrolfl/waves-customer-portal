/**
 * "Your Visit, in Motion" — per-visit recap video tracking (Pest Report V2 lane).
 *
 * One row per service_record. Doubles as the render JOB (status / attempts /
 * locked_at / next_attempt_at, claimed SKIP-LOCKED by the recap-pipeline queue,
 * mirroring service_report_pdf_jobs) AND the ASSET record (s3_key / duration /
 * the tech media used). The MP4 itself lives in S3 (recap-storage.js); it's
 * streamed to the client through an authed endpoint, never a public URL.
 *
 * Gated behind PEST_RECAP (server) + the `pest-recap-v1` client flag; inert until
 * both are on. Sending always requires the tech's approval (approved_at).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_recaps')) return;
  await knex.schema.createTable('service_recaps', (t) => {
    t.bigIncrements('id').primary();
    // Keyed on the SCHEDULED service id (uuid) — stable across capture (pre-
    // completion) and the rendered report; service_records.id doesn't exist yet
    // when the tech captures clips in the closeout.
    t.uuid('scheduled_service_id').notNullable().unique(); // 1:1 per visit
    // pending -> rendering -> ready -> approved (or failed). Queue claims pending.
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('s3_key');
    t.integer('duration_ms');
    t.jsonb('media'); // the tagged tech clips/photos used (role + caption + key)
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(3);
    t.timestamp('next_attempt_at').defaultTo(knex.fn.now());
    t.timestamp('locked_at');
    t.timestamp('rendered_at');
    t.timestamp('approved_at');
    t.string('approved_by');
    t.timestamp('sent_at');
    t.text('last_error');
    t.timestamps(true, true);
    t.index(['status', 'next_attempt_at'], 'service_recaps_due_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_recaps');
};
