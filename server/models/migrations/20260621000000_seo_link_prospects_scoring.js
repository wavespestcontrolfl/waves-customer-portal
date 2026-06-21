/**
 * seo_link_prospects — scoring + contactability columns.
 *
 * Adds the fields the prospect scorer (server/services/seo/prospect-scorer.js)
 * writes: a captured contact path (so a no-contact outreach prospect is killed
 * at intake), and a composite score + tier so the board ranks on relevance +
 * lead-value + contactability instead of raw domain rating. The per-signal
 * breakdown (relevance, lead_value, is_local, reason) lives in the existing
 * quality_signals jsonb — no extra columns for it.
 *
 * Applies on Railway DEPLOY, not at merge.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.text('contact_email');
    t.text('contact_url');
    t.timestamp('contact_checked_at');
    t.decimal('score');        // composite 0–100 (relevance·lead·contact·DR)
    t.smallint('tier');        // 1 = local partner … 5 = citation baseline
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_link_prospects_score ON seo_link_prospects (score DESC NULLS LAST)');
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS idx_link_prospects_score');
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.dropColumns('contact_email', 'contact_url', 'contact_checked_at', 'score', 'tier');
  });
};
