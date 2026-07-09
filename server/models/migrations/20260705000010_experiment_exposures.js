/**
 * experiment_exposures — assignment log for GrowthBook A/B experiments
 * (GrowthBook experimentation initiative, Phase 0).
 *
 * GrowthBook is warehouse-native: it does NOT store event data. It computes
 * experiment results by querying this table (the "assignment query" / exposure
 * source) joined to the existing conversion tables — estimates.accepted_at,
 * estimate_deposits, invoices.paid_at, scheduled_services, customers.pipeline_stage.
 * See docs/experimentation/growthbook-setup.md for the exact queries.
 *
 * One row per (experiment_key, unit_id): the unique index makes FIRST exposure
 * the retained assignment (repeat views insert with onConflict().ignore()),
 * which matches GrowthBook's "first exposure wins" analysis semantics and keeps
 * the table one-row-per-participant instead of one-row-per-view.
 *
 *   unit_id      the hashing unit GrowthBook assigned on (e.g. estimate token).
 *   unit_type    identifier type ('estimate' | 'customer' | 'anon') so one
 *                table can serve experiments scoped to different units.
 *   variation_id 0-based index GrowthBook returns; variation_key = its label.
 *   exposed_at   timestamptz (UTC storage). The ET behavior layer builds any
 *                windows via datetime-et.js — never compared to naive ISO here.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('experiment_exposures')) return;
  await knex.schema.createTable('experiment_exposures', (t) => {
    t.bigIncrements('id').primary();
    t.string('experiment_key', 100).notNullable();
    t.integer('variation_id').notNullable();
    t.string('variation_key', 100).nullable();
    t.string('unit_id', 200).notNullable();
    t.string('unit_type', 40).notNullable().defaultTo('estimate');
    t.timestamp('exposed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('metadata').nullable();
    // First exposure per unit wins; repeat views are ignored on conflict.
    t.unique(['experiment_key', 'unit_id'], { indexName: 'experiment_exposures_key_unit_uniq' });
    // GrowthBook's assignment query scans by experiment + time window.
    t.index(['experiment_key', 'exposed_at'], 'experiment_exposures_key_time_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('experiment_exposures');
};
