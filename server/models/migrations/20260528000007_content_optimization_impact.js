exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('content_optimization_impact');
  if (!exists) {
    await knex.schema.createTable('content_optimization_impact', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').references('id').inTable('autonomous_runs').onDelete('SET NULL');
      t.text('page_url').notNullable();
      t.string('bucket');
      t.timestamp('deployed_at', { useTz: true });
      t.string('cloudflare_build_id');
      t.date('first_gsc_change_detected_at');
      t.date('measurement_start');
      t.date('baseline_start_date');
      t.date('baseline_end_date');
      t.integer('baseline_impressions');
      t.integer('baseline_clicks');
      t.decimal('baseline_position', 10, 4);
      t.decimal('baseline_ctr', 10, 6);
      t.integer('baseline_word_count');
      t.jsonb('query_cohort').notNullable().defaultTo('[]');
      t.specificType('control_page_urls', 'text[]');
      t.jsonb('control_selection_reason').notNullable().defaultTo('{}');
      t.jsonb('metrics_14d').notNullable().defaultTo('{}');
      t.jsonb('metrics_21d').notNullable().defaultTo('{}');
      t.jsonb('control_delta_14d').notNullable().defaultTo('{}');
      t.jsonb('control_delta_21d').notNullable().defaultTo('{}');
      t.timestamp('checked_14d_at', { useTz: true });
      t.timestamp('checked_21d_at', { useTz: true });
      t.decimal('estimated_lift_position', 10, 4);
      t.decimal('estimated_lift_clicks_pct', 10, 6);
      t.string('verdict');
      t.decimal('verdict_confidence', 10, 6);
      t.timestamps(true, true);
    });
  }

  await knex.schema.raw('CREATE UNIQUE INDEX IF NOT EXISTS content_opt_impact_run_unique ON content_optimization_impact (run_id)');
  await knex.schema.raw('CREATE INDEX IF NOT EXISTS content_opt_impact_page_idx ON content_optimization_impact (page_url)');
  await knex.schema.raw('CREATE INDEX IF NOT EXISTS content_opt_impact_verdict_bucket_idx ON content_optimization_impact (verdict, bucket)');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('content_optimization_impact');
};
