/**
 * Lawn Photos & Knowledge Bridge
 *
 * 1. lawn_assessment_photos — per-photo S3 keys + AI scores
 * 2. Add before/after photo S3 keys to treatment_outcomes
 * 3. knowledge_bridge — cross-links Claudeopedia ↔ Agronomic Wiki
 */
exports.up = async function (knex) {
  // ── lawn_assessment_photos ────────────────────────────────────────────
  if (!(await knex.schema.hasTable('lawn_assessment_photos'))) {
    await knex.schema.createTable('lawn_assessment_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('assessment_id').notNullable()
        .references('id').inTable('lawn_assessments').onDelete('CASCADE');
      t.integer('photo_index').notNullable().defaultTo(0);
      t.string('s3_key', 500).nullable();
      t.string('mime_type', 50).defaultTo('image/jpeg');

      // Per-photo AI scores (0-100)
      t.integer('turf_density').nullable();
      t.integer('weed_coverage').nullable();
      t.decimal('color_health', 4, 1).nullable();
      t.string('fungal_activity', 20).nullable();
      t.string('thatch_visibility', 20).nullable();
      t.text('observations').nullable();

      // Quality score for picking "best" representative photo
      // density 40% + low weeds 30% + color 30%
      t.decimal('quality_score', 5, 2).nullable();
      t.boolean('is_best').defaultTo(false);

      t.timestamps(true, true);
      t.index(['assessment_id']);
    });
  }

  // ── Add photo S3 keys to treatment_outcomes ───────────────────────────
  if (await knex.schema.hasTable('treatment_outcomes')) {
    const hasBefore = await knex.schema.hasColumn('treatment_outcomes', 'before_photo_key');
    if (!hasBefore) {
      await knex.schema.alterTable('treatment_outcomes', (t) => {
        t.string('before_photo_key', 500).nullable();
        t.string('after_photo_key', 500).nullable();
      });
    }
  }

  // ── knowledge_bridge ──────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('knowledge_bridge'))) {
    await knex.schema.createTable('knowledge_bridge', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // Source: claudeopedia (knowledge_base) or wiki (knowledge_entries)
      t.string('source_type', 30).notNullable(); // 'claudeopedia' | 'wiki'
      t.uuid('source_id').notNullable();
      t.string('source_title', 300).nullable();

      // Target
      t.string('target_type', 30).notNullable(); // 'claudeopedia' | 'wiki'
      t.uuid('target_id').notNullable();
      t.string('target_title', 300).nullable();

      // Link type
      t.string('link_type', 30).notNullable();
      // product_reference, condition_treatment, seasonal_guide, data_enrichment

      t.decimal('confidence', 3, 2).defaultTo(0.5);
      t.boolean('auto_linked').defaultTo(true);
      t.timestamps(true, true);

      t.unique(['source_type', 'source_id', 'target_type', 'target_id']);
      t.index(['source_type', 'source_id']);
      t.index(['target_type', 'target_id']);
      t.index(['link_type']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('knowledge_bridge');
  await knex.schema.dropTableIfExists('lawn_assessment_photos');
  if (await knex.schema.hasTable('treatment_outcomes')) {
    const hasBefore = await knex.schema.hasColumn('treatment_outcomes', 'before_photo_key');
    if (hasBefore) {
      await knex.schema.alterTable('treatment_outcomes', (t) => {
        t.dropColumn('before_photo_key');
        t.dropColumn('after_photo_key');
      });
    }
  }
};
