/**
 * Autonomous Content Engine — Phase 2 schema (SERP snapshots).
 *
 * One table: serp_snapshots — caches DataForSEO SERP profile output so
 * the engine doesn't re-spend on the same query+city more than once
 * per 14 days unless explicitly forced.
 *
 * Unique on (query, city, device, fetched_at_day). The day bucket lets
 * us tolerate multiple captures on the same day (debugging / re-runs)
 * while still pinning the dedupe to date granularity.
 *
 * `city` is NOT NULL with a sentinel default of '_global' for cityless
 * (no-local-intent) queries. PostgreSQL treats NULL values as distinct
 * inside unique constraints, so a nullable city column would let
 * cityless reruns silently bypass ON CONFLICT and create duplicate
 * cache rows per day — undermining the cache and inflating spend.
 */

const CITY_SENTINEL = '_global';

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('serp_snapshots');
  if (exists) return;

  await knex.schema.createTable('serp_snapshots', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('query', 500).notNullable();
    t.string('city', 40).notNullable().defaultTo(CITY_SENTINEL); // '_global' sentinel for cityless queries (NULL would break unique)
    t.string('device', 20).notNullable().defaultTo('mobile');
    t.string('location_used', 200);       // exact DataForSEO location string

    // Classification — the fields the decision-router consumes.
    t.string('dominant_intent', 40);      // transactional-local|informational|comparison|emergency|public-health|navigational
    t.string('dominant_page_type', 40);   // city-service|service|blog|directory|public-health|faq|home
    t.string('recommended_asset_type', 60);
    t.decimal('confidence', 4, 3);        // 0.000–1.000

    // Counts + booleans for quick filtering.
    t.boolean('local_pack_present').notNullable().defaultTo(false);
    t.boolean('ai_overview_present').notNullable().defaultTo(false);
    t.boolean('public_resource_present').notNullable().defaultTo(false);
    t.decimal('directory_saturation', 4, 3).notNullable().defaultTo(0);

    // Rich payload — kept in jsonb so we can add fields without migrations.
    // Shape (see serp-profiler.js for canonical structure):
    //   {
    //     top_organic: [{url, domain, title, description, type}, ...],
    //     local_pack_businesses: [{name, rating, review_count, categories}],
    //     paa_questions: [...],
    //     ai_overview_sources: [...],
    //     competitor_cta_patterns: [...],
    //     competitor_review_patterns: {...},
    //     competitor_proof_patterns: [...],
    //     serp_gap: 'free text'
    //   }
    t.jsonb('payload').notNullable().defaultTo('{}');

    t.timestamp('fetched_at').notNullable().defaultTo(knex.fn.now());
    t.date('fetched_at_day').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
    t.timestamps(true, true);

    t.unique(['query', 'city', 'device', 'fetched_at_day']);
    t.index(['query', 'fetched_at']);
    t.index('dominant_page_type');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('serp_snapshots');
};
