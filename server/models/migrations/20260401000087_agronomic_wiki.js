/**
 * Agronomic Intelligence Wiki — Foundation Tables
 *
 * treatment_outcomes — pairs treatments with before/after assessment scores
 * knowledge_entries — wiki pages (AI-maintained, compounding knowledge)
 * knowledge_update_log — change history for wiki operations
 */

exports.up = async function (knex) {
  // ── treatment_outcomes ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('treatment_outcomes'))) {
    await knex.schema.createTable('treatment_outcomes', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();

      // The treatment
      t.uuid('service_record_id').notNullable().unique();
      t.date('treatment_date').notNullable();
      t.string('service_type', 100).nullable();
      t.string('grass_track', 20).nullable();
      t.integer('visit_number').nullable();

      // Products applied (denormalized for query performance)
      t.jsonb('products_applied').nullable();

      // Pre-treatment assessment
      t.uuid('pre_assessment_id').nullable();
      t.date('pre_assessment_date').nullable();
      t.integer('pre_turf_density').nullable();
      t.integer('pre_weed_suppression').nullable();
      t.integer('pre_color_health').nullable();
      t.integer('pre_fungus_control').nullable();
      t.integer('pre_thatch_level').nullable();

      // Post-treatment assessment
      t.uuid('post_assessment_id').nullable();
      t.date('post_assessment_date').nullable();
      t.integer('post_turf_density').nullable();
      t.integer('post_weed_suppression').nullable();
      t.integer('post_color_health').nullable();
      t.integer('post_fungus_control').nullable();
      t.integer('post_thatch_level').nullable();

      // Deltas (computed)
      t.integer('delta_turf_density').nullable();
      t.integer('delta_weed_suppression').nullable();
      t.integer('delta_color_health').nullable();
      t.integer('delta_fungus_control').nullable();
      t.integer('delta_thatch_level').nullable();

      // Context
      t.integer('days_between_assessments').nullable();
      t.string('season', 20).nullable();

      // Environmental conditions during treatment window
      t.decimal('avg_temperature', 5, 1).nullable();
      t.decimal('total_rainfall', 5, 2).nullable();
      t.decimal('avg_humidity', 5, 1).nullable();

      // Property context (denormalized)
      t.string('grass_type', 50).nullable();
      t.integer('property_sqft').nullable();
      t.string('sun_exposure', 20).nullable();
      t.boolean('near_water').nullable();
      t.boolean('irrigation_system').nullable();

      // Customer satisfaction for this visit
      t.integer('satisfaction_rating').nullable();

      t.timestamps(true, true);

      // Indexes
      t.index(['customer_id']);
      t.index(['grass_track', 'visit_number']);
      t.index(['season']);
      t.index(['treatment_date']);
    });
  }

  // ── knowledge_entries ───────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('knowledge_entries'))) {
    await knex.schema.createTable('knowledge_entries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // Identity
      t.string('slug', 200).unique().notNullable();
      t.string('category', 50).notNullable();
      t.string('title', 300).notNullable();

      // Content
      t.text('content').notNullable().defaultTo('');
      t.text('summary').nullable();

      // Metadata
      t.integer('data_point_count').defaultTo(0);
      t.string('confidence', 20).defaultTo('low');

      // Cross-references
      t.jsonb('related_entries').nullable();
      t.jsonb('tags').nullable();

      // Freshness
      t.timestamp('last_data_update').nullable();
      t.boolean('stale_flag').defaultTo(false);

      // Provenance
      t.jsonb('source_assessment_ids').nullable();
      t.jsonb('source_treatment_ids').nullable();

      // Human review
      t.timestamp('last_human_review').nullable();
      t.string('reviewed_by', 100).nullable();
      t.text('human_notes').nullable();

      t.timestamps(true, true);

      // Indexes
      t.index(['category']);
      t.index(['stale_flag']);
    });

    // GIN index on tags for fast JSONB array containment queries
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_entries_tags ON knowledge_entries USING GIN (tags)'
    );
  }

  // ── knowledge_update_log ────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('knowledge_update_log'))) {
    await knex.schema.createTable('knowledge_update_log', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      t.string('action', 50).notNullable();
      t.string('entry_slug', 200).nullable();
      t.text('description').notNullable();

      // What triggered this update
      t.string('trigger_type', 50).nullable();
      t.uuid('trigger_id').nullable();

      // AI generation metadata
      t.string('model_used', 50).nullable();
      t.integer('tokens_used').nullable();

      t.timestamps(true, true);

      // Indexes
      t.index(['created_at']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('knowledge_update_log');
  await knex.schema.dropTableIfExists('knowledge_entries');
  await knex.schema.dropTableIfExists('treatment_outcomes');
};
