/**
 * LLM Mentions Tracker — answer-engine visibility (AEO).
 *
 * The `seo_llm_mentions` table was originally created by
 * 20260401000052_backlink_management.js with only Google AI Overview ever
 * populated. This migration:
 *   1. Extends it to hold real answer-engine probe results (full response,
 *      cited URLs, rank position, model version, batch grouping).
 *   2. Adds `seo_llm_mention_queries` — a managed list of city × service
 *      prompts to probe, replacing the 5 hardcoded queries in backlink-monitor.
 */

exports.up = async function up(knex) {
  const hasMentions = await knex.schema.hasTable('seo_llm_mentions');
  if (hasMentions) {
    await knex.schema.alterTable('seo_llm_mentions', (t) => {
      t.uuid('query_id').nullable();           // FK → seo_llm_mention_queries (null for legacy rows)
      t.uuid('batch_id').nullable();           // groups one runDaily() pass
      t.text('response_raw');                  // full answer text from the engine
      t.jsonb('cited_urls');                   // [url, ...] every source the engine linked
      t.jsonb('waves_cited_urls');             // subset that point to a Waves domain
      t.integer('rank_position');              // order Waves appeared among brands (1 = first); null if absent
      t.string('model_version', 120);          // exact model/endpoint used for the probe
      t.boolean('grounded').defaultTo(false);  // true when the probe used live web grounding
    });

    // Composite/lookup indexes (guarded — alterTable index() throws if it exists)
    const addIndex = async (cols, name) => {
      const exists = await knex.schema.hasColumn('seo_llm_mentions', Array.isArray(cols) ? cols[0] : cols);
      if (!exists) return;
      try { await knex.schema.alterTable('seo_llm_mentions', (t) => t.index(cols, name)); } catch { /* exists */ }
    };
    await addIndex(['llm_platform', 'check_date'], 'idx_llm_mentions_platform_date');
    await addIndex('waves_mentioned', 'idx_llm_mentions_waves');
    await addIndex('query_id', 'idx_llm_mentions_query');
    await addIndex('batch_id', 'idx_llm_mentions_batch');

    // The legacy button-driven path had no idempotency, so collapse any
    // pre-existing same-day duplicates (keep the earliest) before enforcing
    // uniqueness — the constraint is what makes overlapping runDaily() passes
    // (multi-pod scheduler + admin scan) safe via onConflict().ignore().
    await knex.raw(`
      DELETE FROM seo_llm_mentions
      WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (
            PARTITION BY query, llm_platform, check_date ORDER BY created_at
          ) AS rn
          FROM seo_llm_mentions
          WHERE query IS NOT NULL AND llm_platform IS NOT NULL AND check_date IS NOT NULL
        ) t WHERE t.rn > 1
      )
    `);
    try {
      await knex.schema.alterTable('seo_llm_mentions', (t) =>
        t.unique(['query', 'llm_platform', 'check_date'], { indexName: 'uq_llm_mentions_query_platform_date' }));
    } catch { /* already exists */ }
  }

  const hasQueries = await knex.schema.hasTable('seo_llm_mention_queries');
  if (!hasQueries) {
    await knex.schema.createTable('seo_llm_mention_queries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('query').notNullable();
      t.string('city', 80);
      t.string('service', 80);
      t.boolean('active').defaultTo(true);
      t.timestamps(true, true);
      t.index('active');
      t.unique(['query']);
    });

    // Seed: city × service prompts a real prospect would type into an answer
    // engine. Bounded set (~22) to keep daily probe cost in check.
    const cities = ['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Parrish', 'Venice'];
    const services = [
      { key: 'pest control', q: (c) => `best pest control company in ${c}, Florida` },
      { key: 'termite', q: (c) => `who does termite inspections in ${c} FL` },
      { key: 'mosquito', q: (c) => `best mosquito control service near ${c} Florida` },
      { key: 'lawn care', q: (c) => `best lawn care service in ${c} FL` },
    ];
    const rows = [];
    for (const city of cities) {
      for (const svc of services) {
        // Skip lawn for spoke-only cities to stay bounded; keep pest everywhere.
        if (svc.key === 'lawn care' && !['Bradenton', 'Lakewood Ranch', 'Sarasota'].includes(city)) continue;
        rows.push({ query: svc.q(city), city, service: svc.key, active: true });
      }
    }
    // A couple of region-wide intent queries (no specific city).
    rows.push({ query: 'best pest control in Southwest Florida', city: null, service: 'pest control', active: true });
    rows.push({ query: 'affordable quarterly pest control Manatee County FL', city: null, service: 'pest control', active: true });

    await knex('seo_llm_mention_queries').insert(rows);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('seo_llm_mention_queries');
  const hasMentions = await knex.schema.hasTable('seo_llm_mentions');
  if (hasMentions) {
    try {
      await knex.schema.alterTable('seo_llm_mentions', (t) =>
        t.dropUnique(['query', 'llm_platform', 'check_date'], 'uq_llm_mentions_query_platform_date'));
    } catch { /* not present */ }
    await knex.schema.alterTable('seo_llm_mentions', (t) => {
      t.dropColumn('query_id');
      t.dropColumn('batch_id');
      t.dropColumn('response_raw');
      t.dropColumn('cited_urls');
      t.dropColumn('waves_cited_urls');
      t.dropColumn('rank_position');
      t.dropColumn('model_version');
      t.dropColumn('grounded');
    });
  }
};
