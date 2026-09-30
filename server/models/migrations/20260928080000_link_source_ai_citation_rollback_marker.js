/**
 * Second rollback-safety follow-up to 20260928050000_link_source_ai_citation.js
 * — a THIRD migration because 20260928060000_link_source_ai_citation_
 * rollback_safety.js is ALSO already pushed and frozen now (same "supersede,
 * never edit in place" convention as 20260928050000's own header explains).
 *
 * The bug (Codex P1, 2026-09-28, SECOND round): 20260928060000's down()
 * relabels every `source = 'ai_citation'` row to `legacy_unknown` so
 * 20260928050000's CHECK-narrowing down() doesn't abort on real data — but
 * `source` is the ONLY signal link-authority-policy.js's isDiscoveryOnlyDomain
 * reads (the owner-queue safety guard: DISCOVERY NEVER GRANTS AUTHORITY). A
 * relabeled domain silently stops being discovery-only, and neither that
 * migration's up() nor 20260928050000's restores it on a later reapply — so
 * a rollback-then-reapply would let a domain the feeder ONLY ever saw cited
 * by an AI answer engine start earning AUTO_FREE / AUTO_ACCOUNT again,
 * exactly what the owner ruling forbids.
 *
 * The fix: an INDEPENDENT, durable guard rather than trying to restore
 * `source` (which a later migration can't reliably do once it's been
 * overwritten). Every `seo_link_domains` row still carrying `source =
 * 'ai_citation'` gets `enrichment.ai_citation_discovered = true` stamped in
 * THIS migration's down() — which knex runs BEFORE 20260928060000's down()
 * (last-applied-first within a batch), so the marker lands while `source`
 * still reads 'ai_citation', capturing exactly the right row set. `enrichment`
 * is an ordinary jsonb column neither this file's up(), 20260928060000's, nor
 * 20260928050000's touches, so the marker survives the relabel and any
 * number of later down()/up() cycles of these three migrations.
 * isDiscoveryOnlyDomain (link-authority-policy.js) now checks EITHER
 * `domain.source === 'ai_citation'` OR this marker — so the guard holds
 * whichever one is currently true.
 *
 * (Known residual limitation, documented rather than chased further: the
 * weekly DataForSEO enrich job, link-registry-enrich.js, REPLACES the whole
 * `enrichment` column rather than merging into it, so a normal enrich run
 * AFTER a rollback would still clear this marker. That compounds a rare
 * manual rollback with an unrelated routine job overwrite — a materially
 * different, separate risk from the one this migration closes, which is
 * "rollback, then reapply the migration pair, with no other writes in
 * between." Merging every `enrichment` writer's semantics is out of scope
 * here — it would touch a shared writer used by every registry domain, not
 * a change bounded to the ai_citation lane.)
 */

const ENRICHMENT_MARKER_SQL = "UPDATE seo_link_domains SET enrichment = COALESCE(enrichment, '{}'::jsonb) || '{\"ai_citation_discovered\": true}'::jsonb WHERE source = 'ai_citation'";

exports.up = async function up() {
  // Intentionally nothing — see header. This migration exists only to make
  // 20260928060000's down() safe for the owner-authority guard.
};

exports.down = async function down(knex) {
  await knex.raw(ENRICHMENT_MARKER_SQL);
};
