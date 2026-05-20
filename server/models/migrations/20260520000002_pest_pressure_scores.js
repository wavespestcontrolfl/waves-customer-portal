/**
 * Pest Pressure scores.
 *
 * One row per (service_record_id) — the historical record of a calculated
 * Pest Pressure score for a completed service report. Stores both the
 * calculated and displayed (possibly overridden) score, the component
 * inputs, and a snapshot of the config used so historical reports remain
 * explainable even if admin settings change later.
 *
 * Customer/property scoping mirrors the existing service_records schema:
 * Waves models "property" as the customer profile, so we carry customer_id
 * rather than a separate property_id.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pest_pressure_scores'))) {
    await knex.schema.createTable('pest_pressure_scores', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.string('service_line', 40);
      t.date('service_date').notNullable();
      t.date('review_period_start');
      t.date('review_period_end');

      // Engine output
      t.decimal('calculated_score', 3, 1);
      t.decimal('displayed_score', 3, 1);
      t.string('label_key', 40);
      t.string('label_name', 40);
      t.string('trend', 30).notNullable().defaultTo('first_marker');
      t.decimal('trend_delta', 3, 1);
      t.string('data_completeness', 20).notNullable().defaultTo('insufficient');

      // Component inputs and the weights actually applied (after renormalization).
      t.jsonb('component_scores').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('component_weights').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('missing_components').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.text('explanation');

      // Config snapshot — full config at calculation time, so historical reports
      // remain explainable even if admin settings change later.
      t.jsonb('config_snapshot').notNullable();
      t.string('calculation_version', 20).notNullable();

      // Override fields. is_overridden is the source-of-truth for displayed_score
      // resolution; original_calculated_score lets "remove override" restore it.
      t.boolean('is_overridden').notNullable().defaultTo(false);
      t.decimal('original_calculated_score', 3, 1);
      t.text('override_reason');
      t.uuid('overridden_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('overridden_at');

      t.timestamp('calculated_at').notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.unique(['service_record_id']);
    });

    await knex.raw('CREATE INDEX IF NOT EXISTS idx_pest_pressure_scores_customer_line_date ON pest_pressure_scores(customer_id, service_line, service_date DESC)');
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_pest_pressure_scores_completeness ON pest_pressure_scores(data_completeness) WHERE data_completeness <> \'insufficient\'');

    await knex.raw(`
      ALTER TABLE pest_pressure_scores
        ADD CONSTRAINT pest_pressure_scores_score_range
        CHECK (
          (calculated_score IS NULL OR (calculated_score BETWEEN 0 AND 5)) AND
          (displayed_score IS NULL OR (displayed_score BETWEEN 0 AND 5)) AND
          (original_calculated_score IS NULL OR (original_calculated_score BETWEEN 0 AND 5))
        )
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_pest_pressure_scores_completeness');
  await knex.raw('DROP INDEX IF EXISTS idx_pest_pressure_scores_customer_line_date');
  await knex.schema.dropTableIfExists('pest_pressure_scores');
};
