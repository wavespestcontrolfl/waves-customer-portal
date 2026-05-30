/**
 * AEO visibility feedback loop (Tier 2b).
 *
 * Extends content_optimization_impact so that, after an aeo_gap page publishes,
 * we record whether Waves subsequently started appearing in answer-engine
 * responses for that city×service. No new probes are fired — the daily LLM
 * mention prober already re-probes every managed query, so this just watches
 * the relevant query_ids after the deploy date and writes a verdict.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('content_optimization_impact');
  if (!has) return;
  await knex.schema.alterTable('content_optimization_impact', (t) => {
    t.jsonb('aeo_query_ids');          // managed seo_llm_mention_queries ids to watch (null = not an aeo_gap row)
    t.timestamp('aeo_checked_at');     // when the post-publish visibility check ran
    t.boolean('aeo_now_cited');        // did Waves appear in answers after the deploy?
    t.string('aeo_verdict', 40);       // now_cited | still_absent | insufficient_data
  });
  try { await knex.schema.alterTable('content_optimization_impact', (t) => t.index(['bucket', 'aeo_checked_at'], 'idx_coi_aeo_pending')); }
  catch { /* exists */ }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('content_optimization_impact');
  if (!has) return;
  try { await knex.schema.alterTable('content_optimization_impact', (t) => t.dropIndex(['bucket', 'aeo_checked_at'], 'idx_coi_aeo_pending')); }
  catch { /* not present */ }
  await knex.schema.alterTable('content_optimization_impact', (t) => {
    t.dropColumn('aeo_query_ids');
    t.dropColumn('aeo_checked_at');
    t.dropColumn('aeo_now_cited');
    t.dropColumn('aeo_verdict');
  });
};
