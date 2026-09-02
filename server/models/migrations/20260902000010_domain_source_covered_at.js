/**
 * Step-3 investigator (Codex PR r28): provenance-hint coverage cursor.
 *
 * `seo_link_domain_sources.covered_at` — when every host-bound URL embedded
 * in a touch's source_detail was fully observed by an investigation pass.
 * Uncovered touches queue first (rotated) in the candidate order, and a
 * terminal not_reproducible close waits until every hint has been offered
 * a fetch — the same discipline the fixed probe list already has via
 * probe_coverage_mask, persisted per touch because hints are unbounded.
 * Reopen / long-term parks do not clear it: a hint, once read, was read.
 */
exports.up = async function up(knex) {
  const cols = await knex('seo_link_domain_sources').columnInfo();
  if (!cols.covered_at) {
    await knex.schema.alterTable('seo_link_domain_sources', (t) => {
      t.timestamp('covered_at');
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE seo_link_domain_sources DROP COLUMN IF EXISTS covered_at');
};
