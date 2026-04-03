/**
 * Migration 033 — SEO / Google Search Console / GBP Performance
 *
 * Tables:
 *  - gsc_performance_daily  (sitewide GSC metrics per day)
 *  - gsc_queries            (query-level performance, branded vs non-branded)
 *  - gsc_pages              (page-level performance)
 *  - gsc_core_web_vitals    (CWV snapshots per page)
 *  - gbp_performance_daily  (per-location GBP actions: calls, clicks, directions)
 *  - seo_advisor_reports    (weekly AI SEO advisor output)
 *  - gsc_indexing_issues    (pages with indexing problems)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Sitewide GSC daily metrics ────────────────────────────────
    .createTable('gsc_performance_daily', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('date').notNullable();
      t.string('device'); // mobile, desktop, tablet, all
      t.integer('clicks').defaultTo(0);
      t.integer('impressions').defaultTo(0);
      t.decimal('ctr', 8, 4);
      t.decimal('avg_position', 8, 2);
      // Branded vs non-branded splits
      t.integer('branded_clicks').defaultTo(0);
      t.integer('branded_impressions').defaultTo(0);
      t.integer('nonbrand_clicks').defaultTo(0);
      t.integer('nonbrand_impressions').defaultTo(0);
      t.jsonb('metadata');
      t.timestamps(true, true);

      t.unique(['date', 'device']);
    })

    // ── Query-level performance ───────────────────────────────────
    .createTable('gsc_queries', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('query').notNullable();
      t.date('date').notNullable();
      t.string('device'); // mobile, desktop, tablet
      t.integer('clicks').defaultTo(0);
      t.integer('impressions').defaultTo(0);
      t.decimal('ctr', 8, 4);
      t.decimal('position', 8, 2);
      // Classification
      t.boolean('is_branded').defaultTo(false);
      t.string('service_category'); // pest, lawn, mosquito, termite, rodent, tree_shrub, specialty
      t.string('city_target');      // bradenton, sarasota, venice, parrish, lakewood_ranch
      t.string('intent_type');      // service, emergency, informational, navigational
      t.timestamps(true, true);

      t.index(['query', 'date']);
    })

    // ── Page-level performance ────────────────────────────────────
    .createTable('gsc_pages', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('page_url').notNullable();
      t.date('date').notNullable();
      t.string('device');
      t.integer('clicks').defaultTo(0);
      t.integer('impressions').defaultTo(0);
      t.decimal('ctr', 8, 4);
      t.decimal('position', 8, 2);
      // Classification
      t.string('page_type'); // homepage, city, service, blog, landing
      t.string('service_category');
      t.string('city_target');
      t.timestamps(true, true);

      t.index(['page_url', 'date']);
    })

    // ── Core Web Vitals snapshots ─────────────────────────────────
    .createTable('gsc_core_web_vitals', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('page_url');
      t.string('device'); // mobile, desktop
      t.date('date').notNullable();
      // LCP — Largest Contentful Paint (ms)
      t.decimal('lcp_p75', 10, 2);
      t.string('lcp_status'); // good, needs_improvement, poor
      // FID / INP — Interaction to Next Paint (ms)
      t.decimal('inp_p75', 10, 2);
      t.string('inp_status');
      // CLS — Cumulative Layout Shift
      t.decimal('cls_p75', 10, 4);
      t.string('cls_status');
      // Overall
      t.string('overall_status'); // good, needs_improvement, poor
      t.jsonb('metadata');
      t.timestamps(true, true);
    })

    // ── GBP Performance (per location, per day) ───────────────────
    .createTable('gbp_performance_daily', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('location_id').notNullable(); // GBP location resource name
      t.string('location_name'); // Lakewood Ranch, Parrish, Sarasota, Venice
      t.date('date').notNullable();
      t.integer('calls').defaultTo(0);
      t.integer('website_clicks').defaultTo(0);
      t.integer('direction_requests').defaultTo(0);
      t.integer('bookings').defaultTo(0);
      t.integer('photo_views').defaultTo(0);
      t.integer('search_views').defaultTo(0);     // how often seen in search
      t.integer('maps_views').defaultTo(0);        // how often seen in maps
      t.integer('reviews_count').defaultTo(0);     // total reviews at that date
      t.decimal('reviews_avg_rating', 3, 2);
      t.jsonb('metadata');
      t.timestamps(true, true);

      t.unique(['location_id', 'date']);
    })

    // ── SEO Advisor Reports (weekly AI analysis) ──────────────────
    .createTable('seo_advisor_reports', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('date');
      t.string('period_type').defaultTo('weekly'); // weekly, monthly
      t.jsonb('report_data');
      t.string('grade');
      t.integer('recommendation_count').defaultTo(0);
      t.integer('opportunity_count').defaultTo(0);
      t.integer('alert_count').defaultTo(0);
      t.timestamps(true, true);
    })

    // ── Indexing Issues ───────────────────────────────────────────
    .createTable('gsc_indexing_issues', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('page_url').notNullable();
      t.string('issue_type'); // not_indexed, crawl_error, redirect, noindex, soft_404, server_error
      t.string('status'); // active, resolved
      t.date('first_seen');
      t.date('last_seen');
      t.string('details');
      t.timestamps(true, true);
    });
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('gsc_indexing_issues')
    .dropTableIfExists('seo_advisor_reports')
    .dropTableIfExists('gbp_performance_daily')
    .dropTableIfExists('gsc_core_web_vitals')
    .dropTableIfExists('gsc_pages')
    .dropTableIfExists('gsc_queries')
    .dropTableIfExists('gsc_performance_daily');
};
