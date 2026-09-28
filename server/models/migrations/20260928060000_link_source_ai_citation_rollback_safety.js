/**
 * Rollback-safety follow-up to 20260928050000_link_source_ai_citation.js —
 * a SEPARATE migration because that one is already pushed and FROZEN (a
 * preview database ran it on push; editing it in place is a silent no-op
 * there per this repo's migration convention — supersede, never edit).
 *
 * The bug (Codex P1, 2026-09-28): 20260928050000's down() narrows both
 * source CHECKs back to the step-1 13-value set without touching any row
 * that already carries `source = 'ai_citation'` — if the weekly feeder
 * (link-registry-ai-citation-ingest.js) had run for real by the time anyone
 * rolled back, that down() would abort on a constraint violation.
 *
 * The fix rides on ordinary knex batch-rollback ordering: `knex migrate:
 * rollback` reverts a batch's migrations LAST-APPLIED-FIRST, so THIS file's
 * down() runs BEFORE 20260928050000's down() in any rollback that reaches
 * back that far. This migration's up() is a documented no-op — it changes
 * nothing at forward-migration time (the same "down() is a documented
 * no-op" convention this repo already uses in the other direction, e.g.
 * 20260924030100_new_lead_consultation_placeholder_reinsert.js) — its ENTIRE
 * purpose is to make the earlier migration's down() safe against real data:
 * relabel any `ai_citation` row to `legacy_unknown` (the enum's existing
 * fallback for a source no longer recognized) in both provenance columns
 * BEFORE the earlier file's down() narrows the CHECK that would reject it.
 * source_detail is left untouched — the feeder's own label already reads
 * literally "ai_citation_feeder · …" (link-registry-ai-citation-ingest.js's
 * SOURCE_DETAIL), which IS the provenance-preservation record; nothing here
 * erases evidence, only the CHECKed `source` column moves.
 *
 * (A `seo_link_domain_sources.touch_key` for such a row still reads
 * literally "ai_citation:…" even though its `source` column now says
 * legacy_unknown — touch_key is an idempotency key, not re-derived from
 * source, so this is cosmetic; a later re-up + re-run of the feeder
 * computing the identical touch_key finds that row already present and
 * correctly treats it as an existing touch rather than writing a
 * duplicate.)
 */

exports.up = async function up() {
  // Intentionally nothing — see header. Schema and CHECKs are already
  // correct after 20260928050000; this migration exists only to make ITS
  // down() safe.
};

exports.down = async function down(knex) {
  const relabel = (table) => knex(table).where({ source: 'ai_citation' }).update({ source: 'legacy_unknown' });
  await relabel('seo_link_domains');
  await relabel('seo_link_domain_sources');
};
