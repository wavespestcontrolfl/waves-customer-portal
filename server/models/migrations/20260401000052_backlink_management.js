/**
 * Migration 052 — Backlink Management Extensions
 */
exports.up = async function (knex) {
  // Extend seo_backlinks
  const blCols = await knex('seo_backlinks').columnInfo();
  await knex.schema.alterTable('seo_backlinks', t => {
    if (!blCols.reviewed_at) t.timestamp('reviewed_at');
    if (!blCols.reviewed_by) t.string('reviewed_by');
    if (!blCols.notes) t.text('notes');
    if (!blCols.link_type) t.string('link_type'); // editorial, directory, forum, citation, social, etc.
    if (!blCols.is_dofollow) t.boolean('is_dofollow').defaultTo(true);
    if (!blCols.source_language) t.string('source_language');
    if (!blCols.source_organic_traffic) t.integer('source_organic_traffic');
    if (!blCols.target_page_type) t.string('target_page_type');
    if (!blCols.discovered_date) t.date('discovered_date');
  });

  // Backlink profile snapshots for trends
  await knex.schema.createTable('seo_backlink_snapshots', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('snapshot_date').notNullable().unique();
    t.integer('total_backlinks');
    t.integer('total_referring_domains');
    t.integer('new_backlinks_since_last');
    t.integer('lost_backlinks_since_last');
    t.decimal('avg_domain_rating', 5, 1);
    t.integer('dofollow_count');
    t.integer('nofollow_count');
    t.integer('critical_count');
    t.integer('warning_count');
    t.integer('watch_count');
    t.integer('clean_count');
    t.decimal('anchor_branded_pct', 5, 1);
    t.decimal('anchor_keyword_pct', 5, 1);
    t.decimal('anchor_naked_url_pct', 5, 1);
    t.decimal('anchor_generic_pct', 5, 1);
    t.timestamps(true, true);
  });

  // Competitor backlink intelligence
  await knex.schema.createTable('seo_competitor_backlinks', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('competitor_domain').notNullable();
    t.text('source_url').notNullable();
    t.text('source_domain').notNullable();
    t.integer('source_domain_rating');
    t.text('anchor_text');
    t.text('target_url');
    t.string('link_type');
    t.boolean('is_dofollow').defaultTo(true);
    t.date('first_seen');
    t.date('last_checked');
    t.boolean('waves_has_link').defaultTo(false);
    t.string('prospect_status').defaultTo('unreviewed');
    t.string('prospect_priority');
    t.text('prospect_notes');
    t.timestamp('outreach_sent_at');
    t.timestamps(true, true);
    t.unique(['competitor_domain', 'source_domain']);
  });

  // LLM Mentions tracking
  await knex.schema.createTable('seo_llm_mentions', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('llm_platform'); // chatgpt, gemini, claude, perplexity
    t.text('query');
    t.text('mention_context'); // snippet of the LLM response mentioning Waves
    t.boolean('waves_mentioned').defaultTo(false);
    t.jsonb('competitors_mentioned'); // [{name, context}]
    t.string('sentiment'); // positive, neutral, negative
    t.date('check_date');
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_llm_mentions');
  await knex.schema.dropTableIfExists('seo_competitor_backlinks');
  await knex.schema.dropTableIfExists('seo_backlink_snapshots');

  const blCols = await knex('seo_backlinks').columnInfo();
  await knex.schema.alterTable('seo_backlinks', t => {
    ['reviewed_at','reviewed_by','notes','link_type','is_dofollow','source_language','source_organic_traffic','target_page_type','discovered_date']
      .forEach(col => { if (blCols[col]) t.dropColumn(col); });
  });
};
