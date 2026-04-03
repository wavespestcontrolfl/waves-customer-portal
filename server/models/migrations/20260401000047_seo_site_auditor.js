/**
 * Migration 047 — SEO Site-Wide Technical Audit
 *
 * Tables:
 *  - seo_page_audits      (per-page technical audit results)
 *  - seo_site_audit_runs  (site-wide audit summaries)
 *  - seo_audit_issue_trends (issue trends over time)
 */
exports.up = async function (knex) {
  await knex.schema.createTable('seo_page_audits', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('url').notNullable();
    t.date('audit_date').notNullable();

    // HTTP & Crawl
    t.integer('status_code');
    t.text('redirect_target');
    t.jsonb('redirect_chain');
    t.integer('redirect_chain_length').defaultTo(0);
    t.integer('response_time_ms');
    t.string('robots_meta');
    t.text('canonical_url');
    t.boolean('canonical_self_referencing');
    t.boolean('canonical_mismatch').defaultTo(false);

    // Meta Tags
    t.text('meta_title');
    t.integer('meta_title_length');
    t.boolean('meta_title_has_keyword');
    t.boolean('meta_title_has_city');
    t.text('meta_description');
    t.integer('meta_description_length');
    t.boolean('meta_description_has_keyword');
    t.boolean('meta_description_has_cta');
    t.text('og_image');

    // Headings
    t.text('h1_text');
    t.integer('h1_count');
    t.boolean('h1_has_keyword');
    t.jsonb('h2_texts');
    t.integer('h2_count');
    t.boolean('heading_hierarchy_valid');

    // Content
    t.integer('word_count');
    t.decimal('reading_level_grade', 4, 1);
    t.boolean('keyword_in_first_100_words');
    t.string('content_hash', 32);
    t.boolean('thin_content_flag').defaultTo(false);

    // Images
    t.integer('total_images');
    t.integer('images_missing_alt');
    t.integer('images_over_200kb');

    // Links
    t.integer('internal_links_count');
    t.integer('external_links_count');
    t.jsonb('broken_links');
    t.integer('broken_links_count').defaultTo(0);

    // Schema
    t.jsonb('schema_types_found');
    t.boolean('schema_valid');
    t.jsonb('schema_missing');
    t.boolean('has_local_business_schema');
    t.boolean('has_faq_schema');
    t.boolean('has_service_schema');

    // Performance
    t.integer('pagespeed_mobile_score');
    t.integer('lcp_ms');
    t.integer('inp_ms');
    t.decimal('cls_numeric', 6, 4);
    t.boolean('cwv_pass');

    // Local
    t.boolean('nap_present');
    t.boolean('nap_consistent');
    t.jsonb('city_mentions');
    t.boolean('florida_specific_content');

    // Score
    t.integer('technical_health_score');
    t.jsonb('issues');
    t.integer('issue_count_critical').defaultTo(0);
    t.integer('issue_count_warning').defaultTo(0);
    t.integer('issue_count_info').defaultTo(0);

    t.timestamps(true, true);
    t.unique(['url', 'audit_date']);
    t.index('technical_health_score');
  });

  await knex.schema.createTable('seo_site_audit_runs', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('run_date').defaultTo(knex.fn.now());
    t.integer('pages_crawled');
    t.integer('pages_healthy');
    t.integer('pages_warning');
    t.integer('pages_critical');
    t.integer('total_critical_issues');
    t.integer('total_warning_issues');
    t.decimal('avg_health_score', 5, 1);
    t.integer('pages_with_broken_links');
    t.integer('pages_missing_schema');
    t.integer('pages_thin_content');
    t.integer('pages_missing_meta_description');
    t.integer('pages_with_duplicate_titles');
    t.integer('pages_failing_cwv');
    t.jsonb('duplicate_title_groups');
    t.jsonb('duplicate_content_groups');
    t.decimal('score_delta', 5, 1);
    t.integer('new_issues');
    t.integer('resolved_issues');
    t.string('status').defaultTo('completed');
    t.integer('duration_seconds');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('seo_audit_issue_trends', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('audit_run_id').references('id').inTable('seo_site_audit_runs').onDelete('CASCADE');
    t.string('issue_category');
    t.string('issue_type');
    t.string('severity');
    t.jsonb('affected_urls');
    t.integer('affected_count');
    t.text('recommendation');
    t.date('first_detected');
    t.timestamps(true, true);
    t.index('issue_category');
    t.index('severity');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_audit_issue_trends');
  await knex.schema.dropTableIfExists('seo_site_audit_runs');
  await knex.schema.dropTableIfExists('seo_page_audits');
};
