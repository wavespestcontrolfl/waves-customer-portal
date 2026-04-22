/**
 * Field Content Module — Phase 1 schema (content_prompts, dispatches, media,
 * queue).
 *
 * See docs spec §4. Phase 1 delivers: the four tables, an admin CRUD surface
 * for content_prompts, and 12 seeded rows keyed to the SWFL pest-pressure
 * calendar. SMS dispatch, agent assembly, and publish fan-out are gated off
 * at the feature-flag level until later phases.
 *
 * Spec deviation notes:
 *   - Spec references `jobs(id)` and `users(id)` FK targets; this codebase
 *     canonical tables are `scheduled_services` and `technicians`. Spec §4
 *     explicitly defers to existing naming conventions, so we wire FKs to
 *     those instead.
 *   - Spec status enum on content_queue is expressed as a CHECK constraint
 *     so it can evolve without an ALTER TYPE (Knex enum type mutations are
 *     painful on PostgreSQL).
 *   - `scheduled_services` PK is UUID, `technicians` PK is UUID — matches
 *     the spec's UUID FK columns.
 */
exports.up = async function (knex) {
  // ── content_prompts — manually authored capture briefs, seasonal. ────
  await knex.schema.createTable('content_prompts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('slug').notNullable().unique();
    t.text('title').notNullable();
    t.text('capture_brief').notNullable();
    t.date('season_start').notNullable();
    t.date('season_end').notNullable();
    t.specificType('service_types', 'text[]').notNullable();
    t.text('pest_pressure'); // 'chinch_bug', 'termite_swarm', etc.
    t.jsonb('fawn_trigger'); // { station, metric, op, value }
    t.specificType('target_platforms', 'text[]').notNullable()
      .defaultTo(knex.raw("ARRAY['reels','shorts','tiktok']::text[]"));
    t.text('companion_blog_vertical'); // 'lawn' | 'pest' | 'termite' | null
    t.integer('priority').notNullable().defaultTo(5); // 1 highest
    t.integer('monthly_cap').notNullable().defaultTo(2);
    t.timestamp('archived_at');
    t.timestamps(true, true);
  });
  await knex.raw(
    'CREATE INDEX idx_content_prompts_active ON content_prompts (priority) WHERE archived_at IS NULL'
  );

  // ── content_prompt_dispatches — one row per SMS push to a tech. ──────
  await knex.schema.createTable('content_prompt_dispatches', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('prompt_id').notNullable().references('id').inTable('content_prompts');
    // Spec `jobs(id)` → canonical scheduled_services(id)
    t.uuid('scheduled_service_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    // Spec `users(id)` → canonical technicians(id)
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.text('sms_sid'); // Twilio message SID
    t.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('fulfilled_at');
    t.timestamp('declined_at');
    t.timestamp('expired_at');
  });
  await knex.raw(
    'CREATE INDEX idx_dispatches_tech_open ON content_prompt_dispatches (technician_id) ' +
    'WHERE fulfilled_at IS NULL AND declined_at IS NULL AND expired_at IS NULL'
  );

  // ── media_uploads — raw tech-captured assets, immutable. ─────────────
  await knex.schema.createTable('media_uploads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('dispatch_id').references('id').inTable('content_prompt_dispatches');
    t.uuid('scheduled_service_id').references('id').inTable('scheduled_services');
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.text('media_type').notNullable();
    t.text('storage_url').notNullable();
    t.integer('duration_seconds');
    t.timestamp('captured_at').notNullable();
    t.decimal('gps_lat', 9, 6);
    t.decimal('gps_lng', 9, 6);
    t.text('transcription');
    t.text('transcription_status').notNullable().defaultTo('pending');
    t.text('tech_note'); // optional "anything Virginia should know?"
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE media_uploads ADD CONSTRAINT media_uploads_media_type_check " +
    "CHECK (media_type IN ('video','audio','photo'))"
  );
  await knex.schema.alterTable('media_uploads', (t) => {
    t.index('dispatch_id', 'idx_media_dispatch');
    t.index('scheduled_service_id', 'idx_media_job');
  });

  // ── content_queue — assembled content awaiting Virginia. ─────────────
  await knex.schema.createTable('content_queue', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('parent_queue_id').references('id').inTable('content_queue');
    t.uuid('prompt_id').references('id').inTable('content_prompts');
    t.specificType('source_media_ids', 'uuid[]').notNullable();
    t.text('platform').notNullable(); // 'reels' | 'tiktok' | 'shorts' | 'blog'
    t.text('target_domain'); // blog only
    t.text('status').notNullable().defaultTo('draft');
    t.jsonb('hook_variants');
    t.text('selected_hook');
    t.text('caption');
    t.jsonb('cut_points');
    t.text('blog_draft_md');
    t.text('reviewer_notes');
    t.uuid('reviewed_by').references('id').inTable('technicians');
    t.timestamp('reviewed_at');
    t.timestamp('scheduled_for');
    t.timestamp('published_at');
    t.text('published_url');
    t.timestamps(true, true);
  });
  await knex.raw(
    "ALTER TABLE content_queue ADD CONSTRAINT content_queue_status_check " +
    "CHECK (status IN ('draft','ready_for_review','approved','scheduled','published','rejected','failed'))"
  );
  await knex.schema.alterTable('content_queue', (t) => {
    t.index(['status', 'platform'], 'idx_queue_status');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_queue');
  await knex.schema.dropTableIfExists('media_uploads');
  await knex.schema.dropTableIfExists('content_prompt_dispatches');
  await knex.schema.dropTableIfExists('content_prompts');
};
