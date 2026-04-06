/**
 * Migration 072 — Lawn Assessments (AI-powered dual-vision scoring)
 *
 * Creates tables for photo-based lawn health assessments using
 * Claude + Gemini vision, with seasonal normalization and baseline tracking.
 */
exports.up = async function (knex) {

  // ── Lawn Assessments ──────────────────────────────────────────
  if (!(await knex.schema.hasTable('lawn_assessments'))) {
    await knex.schema.createTable('lawn_assessments', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.date('service_date').notNullable();
      t.string('season', 10);                          // peak | shoulder | dormant
      t.jsonb('photos').defaultTo('[]');                // [{ url, filename, uploadedAt }]
      t.jsonb('claude_raw');                            // raw Claude API response
      t.jsonb('gemini_raw');                            // raw Gemini API response
      t.jsonb('composite_scores');                      // averaged scores after tech review
      t.jsonb('adjusted_scores');                       // seasonally adjusted scores
      t.jsonb('divergence_flags').defaultTo('[]');      // metrics with >20 point gap
      t.integer('turf_density');                        // final composite 0-100
      t.integer('weed_suppression');                    // 100 - weed_coverage
      t.integer('color_health');                        // normalized to 0-100
      t.integer('fungus_control');                      // mapped from category
      t.integer('thatch_level');                        // mapped from category
      t.text('observations');                           // combined observations
      t.boolean('is_baseline').defaultTo(false);
      t.boolean('confirmed_by_tech').defaultTo(false);
      t.timestamp('confirmed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.index(['customer_id', 'service_date']);
    });
  }

  // ── Baseline Resets ───────────────────────────────────────────
  if (!(await knex.schema.hasTable('lawn_baseline_resets'))) {
    await knex.schema.createTable('lawn_baseline_resets', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.string('reset_by', 100);
      t.text('reason');
      t.uuid('old_baseline_id');
      t.uuid('new_baseline_id');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lawn_baseline_resets');
  await knex.schema.dropTableIfExists('lawn_assessments');
};
