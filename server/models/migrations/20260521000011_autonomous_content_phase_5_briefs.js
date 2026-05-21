/**
 * Autonomous Content Engine — Phase 5 schema (content briefs).
 *
 * One table: content_briefs — the full SEO brief composed by
 * brief-builder.js for each accepted opportunity. The writer agents
 * (later phases) consume this verbatim as the source of truth for
 * what to produce.
 *
 * Keyed by opportunity_id so we can re-look-up the brief from the
 * queue row. Unique on (opportunity_id, version) so re-runs against
 * the same opportunity create new versions instead of overwriting
 * (audit trail for drift if the engine changes its mind).
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_briefs');
  if (exists) return;

  await knex.schema.createTable('content_briefs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('opportunity_id').notNullable().references('id').inTable('opportunity_queue').onDelete('CASCADE');
    t.integer('version').notNullable().defaultTo(1);

    // Final decision after the router applies SERP + customer +
    // conversion signals (may differ from opportunity.action_type
    // because of cannibalization risk, serp mismatch, etc.).
    t.string('action_type', 60).notNullable();
    t.text('target_url');          // resolved (or null for new-page actions)
    t.string('target_keyword', 500);
    t.string('city', 40);
    t.string('service', 40);
    t.string('page_type', 40);     // city-service | customer-question | supporting-blog | refresh | metadata

    // Scoring after the router's penalties applied (may be lower
    // than opportunity.score if SERP/customer signals downgraded it).
    t.integer('final_score').notNullable();
    t.jsonb('score_breakdown').notNullable().defaultTo('{}');

    // The signals the writer agents read.
    t.jsonb('serp_signal').notNullable().defaultTo('{}');
    t.jsonb('gsc_signal').notNullable().defaultTo('{}');
    t.jsonb('customer_signal');     // null when no qualifying cluster
    t.jsonb('conversion_signal');   // null when no rollup available

    // Production constraints.
    t.jsonb('required_sections').notNullable().defaultTo('[]');
    t.jsonb('schema_types').notNullable().defaultTo('[]');
    t.jsonb('internal_links_to_add').notNullable().defaultTo('[]');
    t.string('word_count_target', 30); // e.g. "900-1500" or "intent-complete"

    // Voice + scheduling.
    t.jsonb('voice_constraints').notNullable().defaultTo('{}');
    t.timestamp('publish_window');

    // Gating.
    t.boolean('human_review_required').notNullable().defaultTo(true);
    t.text('human_review_reason');

    // Free-text notes from the router for the human reviewer.
    t.text('router_notes');

    t.timestamp('composed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['opportunity_id', 'version']);
    t.index('opportunity_id');
    t.index('action_type');
    t.index(['city', 'service']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_briefs');
};
