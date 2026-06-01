/**
 * Migration — seo_link_prospects (Backlink Manager M1)
 *
 * Outbound link-building pipeline. One row per (target site, money page) we want
 * a link from, tracked through its lifecycle:
 *   prospect → contacted → negotiating → placed → live → indexed → lost | rejected
 *
 * This is the OUTBOUND counterpart to seo_backlinks (the inbound profile monitor).
 * The verifier/indexer reconcile this table against seo_backlinks (live/follow),
 * a crawl fallback (fresh links), DataForSEO SERP (linking-page indexation), and
 * GSC URL Inspection (our own target-page indexation).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('seo_link_prospects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Target (where the link will live)
    t.text('target_domain').notNullable();
    t.text('target_url');
    t.integer('domain_rating');

    // Our side
    t.text('target_page').notNullable(); // the Waves money page being linked to
    t.string('anchor_planned');
    t.text('anchor_text'); // anchor actually found live

    // Classification
    t.string('link_type'); // editorial|resource|guest_post|haro|directory|citation|social
    t.string('source').notNullable().defaultTo('manual'); // strategy_agent|competitor_gap|signup_agent|manual
    t.uuid('source_ref'); // back-pointer (gap id / queue id), nullable

    // Lifecycle
    t.string('status').notNullable().defaultTo('prospect');
    t.string('priority'); // high|medium|low
    t.date('placement_date');
    t.timestamp('first_live_at');

    // Verified attributes (NEVER trusted from a worker self-report)
    t.text('live_url');
    t.boolean('is_dofollow'); // null until verified
    t.string('indexing_status').defaultTo('not_checked'); // not_checked|indexed|crawled_not_indexed|not_indexed
    t.timestamp('last_live_check');
    t.timestamp('last_index_check');

    // Intelligence
    t.jsonb('quality_signals'); // {rank, referring_domains, spam_score, page_relevance, target_indexed}
    t.uuid('backlink_id').references('id').inTable('seo_backlinks'); // promoted link once it appears inbound

    // Ops
    t.string('owner');
    t.text('outreach_thread_ref');
    t.timestamp('outreach_sent_at');
    t.timestamp('claimed_at');
    t.string('claimed_by');
    t.text('evidence_url');
    t.integer('attempts').defaultTo(0);
    t.text('notes');
    t.decimal('cost', 10, 2);

    t.timestamps(true, true);
    t.unique(['target_domain', 'target_page']);
    t.index('status');
    t.index('indexing_status');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('seo_link_prospects');
};
