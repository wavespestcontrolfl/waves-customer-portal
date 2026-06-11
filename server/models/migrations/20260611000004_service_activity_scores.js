/**
 * service_activity_scores
 *
 * Per-visit activity scores for typed specialty completions (rodent trapping,
 * bed bug, cockroach, flea, wildlife, termite). Deliberately a SEPARATE table
 * from pest_pressure_scores: the Pest Pressure rows carry engine-specific
 * columns (component scores, confidence, overrides, review windows) and every
 * pressure consumer (store/customer-view/admin overrides) interprets rows
 * through that engine model. Specialty activity is a simple tech-set 0-5 with
 * an optional findings-derived prefill — keeping it here guarantees recurring
 * Pest Pressure history can never be polluted by specialty visits.
 *
 * UNIQUE (service_record_id, indicator_key) is the idempotency guarantee for
 * completion retries/resumes, and intentionally NOT a bare unique on
 * service_record_id so a future visit can carry more than one indicator
 * (bundled/multi-module reports).
 *
 * History is keyed (customer_id, indicator_key, service_date DESC). There is
 * no per-customer property/location entity in the schema today; if one is
 * added, extend the history key rather than rewriting the table.
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('service_activity_scores');
  if (exists) return;

  await knex.schema.createTable('service_activity_scores', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('service_record_id').notNullable()
      .references('id').inTable('service_records').onDelete('CASCADE');
    t.string('indicator_key', 40).notNullable();
    t.date('service_date').notNullable();
    t.smallint('score').notNullable();
    t.string('source', 20).notNullable().defaultTo('technician');
    t.jsonb('derived_from');
    t.timestamps(true, true);

    t.unique(['service_record_id', 'indicator_key'], {
      indexName: 'uq_service_activity_scores_record_indicator',
    });
    t.index(['customer_id', 'indicator_key', 'service_date'],
      'idx_service_activity_scores_customer_indicator_date');
  });

  await knex.raw(`
    ALTER TABLE service_activity_scores
    ADD CONSTRAINT chk_service_activity_scores_score CHECK (score >= 0 AND score <= 5)
  `);
  await knex.raw(`
    ALTER TABLE service_activity_scores
    ADD CONSTRAINT chk_service_activity_scores_source CHECK (source IN ('technician', 'derived'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_activity_scores');
};
