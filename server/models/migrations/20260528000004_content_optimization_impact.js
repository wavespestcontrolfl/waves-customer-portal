/**
 * content_optimization_impact — measures whether an optimization actually
 * helped, using difference-in-differences against unoptimized control pages.
 *
 * One row per published optimization. baseline_* is snapshotted when the page
 * goes live; the daily sweep fills the 14- and 21-day windows and computes a
 * control-adjusted verdict (improved / neutral / regressed / insufficient_data).
 * GSC has lag and deploy != recrawl, so the measurement clock starts at
 * max(deployed_at + 3d, first GSC date with data after deploy).
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_optimization_impact');
  if (exists) return;
  await knex.schema.createTable('content_optimization_impact', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('run_id').references('id').inTable('autonomous_runs').onDelete('SET NULL');
    t.text('page_url').notNullable();
    t.string('bucket', 40);

    // Deploy / measurement clock
    t.timestamp('deployed_at');
    t.string('cloudflare_build_id', 120);
    t.date('first_gsc_change_detected_at');
    t.date('measurement_start');

    // Baseline (28d window ending at deploy)
    t.date('baseline_start_date');
    t.date('baseline_end_date');
    t.integer('baseline_impressions');
    t.integer('baseline_clicks');
    t.decimal('baseline_position', 5, 1);
    t.decimal('baseline_ctr', 6, 4);
    t.integer('baseline_word_count');

    // Frozen query cohort + control pages
    t.jsonb('query_cohort').notNullable().defaultTo('[]');
    t.specificType('control_page_urls', 'text[]');
    t.jsonb('control_selection_reason').notNullable().defaultTo('{}');

    // Measurement windows
    t.jsonb('metrics_14d').notNullable().defaultTo('{}');
    t.jsonb('metrics_21d').notNullable().defaultTo('{}');
    t.jsonb('control_delta_14d').notNullable().defaultTo('{}');
    t.jsonb('control_delta_21d').notNullable().defaultTo('{}');
    t.timestamp('checked_14d_at');
    t.timestamp('checked_21d_at');

    // Verdict
    t.decimal('estimated_lift_position', 5, 2);
    t.decimal('estimated_lift_clicks_pct', 6, 2);
    t.string('verdict', 20); // improved | neutral | regressed | insufficient_data
    t.decimal('verdict_confidence', 3, 2);

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['page_url'], 'content_opt_impact_page_idx');
    t.index(['verdict', 'bucket'], 'content_opt_impact_verdict_bucket_idx');
  });

  // One impact row per run.
  await knex.schema.alterTable('content_optimization_impact', (t) => {
    t.unique(['run_id'], 'content_opt_impact_run_unique');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_optimization_impact');
};
