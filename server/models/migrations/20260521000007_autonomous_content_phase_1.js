/**
 * Autonomous Content Engine — Phase 1 schema.
 *
 * Tables:
 *  - opportunity_queue       persisted, ranked queue of every action the
 *                            engine considers. One row per (bucket, target,
 *                            mined-on) — dedupe_key prevents re-insert
 *                            churn when the miner reruns.
 *  - gsc_query_snapshots     weekly rollup of gsc_queries so trend math
 *                            (decay, seasonality, growth) doesn't recompute
 *                            from raw rows every mine. unique on
 *                            (week_start, query, city, service, device).
 *
 * Later phases add: serp_snapshots, customer_insight_clusters,
 * content_briefs, content_internal_link_tasks, content_index_status,
 * autonomous_runs.
 */

exports.up = async function (knex) {
  const hasQueue = await knex.schema.hasTable('opportunity_queue');
  if (!hasQueue) {
    await knex.schema.createTable('opportunity_queue', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // What kind of opportunity this is.
      t.string('bucket', 40).notNullable();
      //  striking_distance | ctr_rewrite | decay_refresh | cannibalization |
      //  page_type_mismatch | local_gap | seasonal_rising | no_content_yet

      // What the decision router proposes the engine do about it.
      t.string('action_type', 60).notNullable();
      //  refresh_existing_page | create_or_refresh_city_service_page |
      //  create_customer_question_page | rewrite_title_meta |
      //  add_internal_links | gbp_post | new_supporting_blog | do_not_publish

      // Target — at least one of these is set.
      t.text('query');         // GSC query string for query-driven buckets
      t.text('page_url');      // for page-driven buckets (decay, page_type_mismatch, ctr_rewrite if URL known)
      t.string('service', 40); // pest|lawn|mosquito|termite|rodent|tree-shrub|specialty
      t.string('city', 40);

      // Score + provenance.
      t.integer('score').notNullable();
      t.jsonb('score_breakdown').notNullable().defaultTo('{}');
      t.jsonb('signal_metadata').notNullable().defaultTo('{}');
      //  raw GSC numbers, cluster sizes, etc. — kept for auditability of
      //  why this opportunity scored where it did

      // State machine.
      t.string('status', 20).notNullable().defaultTo('pending');
      //  pending | claimed | done | skipped | expired
      t.text('skip_reason');

      // Lifecycle timestamps.
      t.timestamp('mined_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('claimed_at');
      t.timestamp('completed_at');
      t.timestamp('expires_at');

      // Dedupe — same opportunity from the same mining window collapses
      // into one row. Pattern: `<bucket>:<service>:<city>:<query|url|topic>`.
      t.string('dedupe_key', 200).notNullable().unique();

      t.timestamps(true, true);

      t.index('bucket');
      t.index('status');
      t.index(['status', 'score']);
      t.index('mined_at');
    });
  }

  const hasSnapshots = await knex.schema.hasTable('gsc_query_snapshots');
  if (!hasSnapshots) {
    await knex.schema.createTable('gsc_query_snapshots', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('week_start_date').notNullable();
      t.string('query', 500).notNullable();
      t.string('city_target', 40);
      t.string('service_category', 40);
      t.string('device', 20).defaultTo('all');
      t.integer('clicks_total').notNullable().defaultTo(0);
      t.integer('impressions_total').notNullable().defaultTo(0);
      t.decimal('ctr_avg', 8, 4);
      t.decimal('position_avg', 8, 2);
      t.timestamps(true, true);

      t.unique(['week_start_date', 'query', 'city_target', 'service_category', 'device']);
      t.index(['query', 'week_start_date']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('gsc_query_snapshots');
  await knex.schema.dropTableIfExists('opportunity_queue');
};
