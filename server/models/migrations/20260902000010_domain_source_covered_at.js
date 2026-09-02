/**
 * Step-3 investigator (Codex PR r28): provenance-hint coverage cursor.
 *
 * `seo_link_domain_sources.covered_at` — when every host-bound URL embedded
 * in a touch's source_detail was fully observed by an investigation pass.
 * Uncovered touches queue first (rotated) in the candidate order, and a
 * terminal not_reproducible close waits until every hint has been offered
 * a fetch — the same discipline the fixed probe list already has via
 * probe_coverage_mask, persisted per touch because hints are unbounded.
 * Like the mask, it is a GENERATION cursor: a concluded verdict, a
 * long-term park, an owner Watch or Reopen clears it, so the next
 * generation re-reads hints uncovered-first (a route can appear on a hint
 * page during the 90 days between rechecks).
 *
 * `covered_urls` (jsonb array of normalized URL keys) — the per-URL half of
 * the same cursor: a composite touch can embed more host-bound URLs than
 * one pass can fetch, so coverage accrues URL by URL across passes and
 * covered_at is stamped once every URL has been observed. Cleared with it.
 */
exports.up = async function up(knex) {
  const cols = await knex('seo_link_domain_sources').columnInfo();
  if (!cols.covered_at) {
    await knex.schema.alterTable('seo_link_domain_sources', (t) => {
      t.timestamp('covered_at');
    });
  }
  if (!cols.covered_urls) {
    await knex.schema.alterTable('seo_link_domain_sources', (t) => {
      t.jsonb('covered_urls');
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE seo_link_domain_sources DROP COLUMN IF EXISTS covered_urls');
  await knex.raw('ALTER TABLE seo_link_domain_sources DROP COLUMN IF EXISTS covered_at');
};
