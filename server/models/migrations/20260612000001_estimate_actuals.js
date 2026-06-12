// Estimate actuals ledger: one row per completed service that traces back to
// an accepted estimate (scheduled_services.source_estimate_id), capturing the
// PRICED inputs (from estimates.estimate_data) next to the OBSERVED ground
// truth (treated sqft, time on site, products applied). Append-only with
// service_record_id uniqueness so the nightly reconcile cron can re-scan a
// window idempotently. Aggregates (systematic bias per service line) are
// computed on read — no rollup table.
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('estimate_actuals');
  if (exists) return;

  await knex.schema.createTable('estimate_actuals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('service_record_id').notNullable().unique()
      .references('id').inTable('service_records').onDelete('CASCADE');
    t.uuid('scheduled_service_id');
    t.string('service_line', 50);
    t.date('service_date');
    // Priced inputs snapshot: { homeSqFt, lotSqFt, turfSqFt, stories,
    // durationMinutes } — whatever the estimate carried; absent = null.
    t.jsonb('estimated').notNullable().defaultTo('{}');
    // Observed: { treatedSqft, durationMinutes, productCount, totalCarrierGal }
    t.jsonb('actual').notNullable().defaultTo('{}');
    // Scalar deltas for fast aggregation; null when either side is missing.
    // Positive = actual ran OVER the estimate.
    t.decimal('turf_delta_pct', 8, 2);
    t.decimal('duration_delta_pct', 8, 2);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['estimate_id'], 'idx_estimate_actuals_estimate');
    t.index(['customer_id'], 'idx_estimate_actuals_customer');
    t.index(['service_line', 'service_date'], 'idx_estimate_actuals_line_date');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_actuals');
};
