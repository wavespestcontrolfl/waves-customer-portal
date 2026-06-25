/**
 * Migration — Tree & Shrub Assessments (AI dual-vision plant-health scoring)
 *
 * Mirrors lawn_assessments (migration 072) for the customer-facing Tree & Shrub
 * Health Report. The vision scorer (tree-shrub-assessment.js) analyzes the visit's
 * tree/shrub photos and stores the five customer-facing diagnosis categories as
 * 0-100 "health" scores (higher = healthier / fewer problem signals):
 *   foliage_fullness · leaf_color_vigor · pest_activity · disease_leaf_spot ·
 *   water_heat_stress  (+ a weighted overall_score).
 *
 * Linked to a visit by service_record_id / service_id (same as lawn), tech-confirmed
 * before it surfaces on a report, and never requires a full plant inventory to exist.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('tree_shrub_assessments'))) {
    await knex.schema.createTable('tree_shrub_assessments', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('service_id').nullable();          // linked scheduled service
      t.uuid('service_record_id').nullable();   // linked completed service record
      t.date('service_date').notNullable();
      t.string('season', 10);                    // peak | shoulder | dormant

      t.jsonb('photos').defaultTo('[]');         // [{ url, s3_key, uploadedAt }]
      t.jsonb('claude_raw');                     // raw Claude vision response
      t.jsonb('gemini_raw');                     // raw Gemini vision response
      t.jsonb('composite_scores');               // averaged scores after merge
      t.jsonb('divergence_flags').defaultTo('[]');
      t.jsonb('plant_groups').defaultTo('[]');   // [{ key, label, status, finding }] (Phase 2)

      // Five customer-facing categories — 0-100 health (higher = healthier).
      t.integer('foliage_fullness');
      t.integer('leaf_color_vigor');
      t.integer('pest_activity');                // higher = fewer pest-pressure signals
      t.integer('disease_leaf_spot');            // higher = fewer leaf-spot signals
      t.integer('water_heat_stress');            // higher = less water/heat/pruning stress
      t.integer('overall_score');                // weighted composite 0-100

      t.text('observations');
      t.text('ai_summary');                      // one concise customer-safe paragraph

      // SIGNALS vs CONFIRMED: photo AI flags signals; a tech confirms before we
      // assert a pest/disease. These raise the report's confidence wording.
      t.boolean('tech_confirmed_pest').defaultTo(false);
      t.boolean('tech_confirmed_disease').defaultTo(false);

      t.boolean('is_baseline').defaultTo(false);
      t.boolean('confirmed_by_tech').defaultTo(false);
      t.timestamp('confirmed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.index(['customer_id', 'service_date']);
      t.index(['service_record_id']);
      t.index(['service_id']);
    });
  }

  if (!(await knex.schema.hasTable('tree_shrub_assessment_photos'))) {
    await knex.schema.createTable('tree_shrub_assessment_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('assessment_id').notNullable().references('id').inTable('tree_shrub_assessments').onDelete('CASCADE');
      t.uuid('customer_id').notNullable();

      t.string('s3_key', 500);
      t.string('url', 1000);                     // direct URL when not S3-backed
      t.string('filename', 300);
      t.string('mime_type', 50).defaultTo('image/jpeg');
      t.integer('file_size_bytes');

      t.string('photo_type', 30).defaultTo('general'); // general | trouble_spot | overview
      t.string('zone', 80);                      // plant group / area label
      t.text('caption');                         // customer-facing AI/tech caption
      t.integer('photo_order').defaultTo(0);

      // Per-photo category reads (the merge rolls these up to the assessment).
      t.integer('foliage_fullness');
      t.integer('leaf_color_vigor');
      t.integer('pest_activity');
      t.integer('disease_leaf_spot');
      t.integer('water_heat_stress');
      t.text('observations');

      t.integer('quality_score').defaultTo(50);
      t.boolean('customer_visible').defaultTo(true);
      t.boolean('is_best_photo').defaultTo(false);

      t.timestamp('taken_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['assessment_id', 'customer_visible']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('tree_shrub_assessment_photos');
  await knex.schema.dropTableIfExists('tree_shrub_assessments');
};
