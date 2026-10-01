/**
 * Backlink Manager v2 — widen the THIRD registry source CHECK with
 * `ai_citation`: seo_link_intake_items.source
 * (seo_link_intake_items_source_check, created by
 * 20260830000021_backlink_intake_step2.js with the 13-value step-1 set).
 *
 * The bug (Codex P2, 2026-09-28, round 9): 20260928050000 widened only
 * seo_link_domains and seo_link_domain_sources. link-registry-intake.js
 * accepts `source: 'ai_citation'` (it validates against the service
 * LINK_SOURCES) and parks an unresolved reference (a shortener, a post URL)
 * in seo_link_intake_items, whose CHECK still rejects the value, so the
 * insert fails at runtime instead of parking. 20260928050000 is pushed and
 * FROZEN, so this is a NEW migration that swaps the CHECK the same way it did
 * (supersede, never edit in place). The only other `source` CHECK in the
 * schema, link_library_source_check, is an unrelated content-library enum
 * the registry never writes.
 *
 * up(): swap the CHECK to the current LINK_SOURCES set, then restore
 * `source = 'ai_citation'` on any intake row this file's own down() relabeled
 * in an earlier rollback. Those rows are identified by their item_key, which
 * link-registry.js intakeItemKey() builds as `${source}:${normalized url}`
 * (or `${source}:sha256:…`) and never re-derives. So only an item parked with
 * source ai_citation carries the `ai_citation:` prefix; a genuine
 * legacy_unknown item's key starts `legacy_unknown:`. On an ordinary forward
 * deploy that UPDATE matches zero rows.
 *
 * down(): relabel `ai_citation` intake rows to `legacy_unknown` (the same
 * relabel 20260928060000's down() applies to the other two tables) BEFORE
 * narrowing the CHECK back to the step-1 set, so the narrow never aborts on
 * real data. item_key is left as-is, which is what lets a later up() find and
 * restore those rows.
 *
 * Enum literals are FROZEN copies: LINK_SOURCES of
 * services/seo/link-registry.js, LINK_SOURCES_STEP1 of
 * 20260830000021_backlink_intake_step2.js.
 * server/tests/link-intake-source-ai-citation-migration.test.js pins both.
 */

const LINK_SOURCES_STEP1 = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown'];
const LINK_SOURCES = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown', 'ai_citation'];
const ITEM_KEY_RE = '^ai_citation:';

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const INTAKE_SOURCE_CHECK = 'seo_link_intake_items_source_check';
const swapCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE seo_link_intake_items DROP CONSTRAINT IF EXISTS ${INTAKE_SOURCE_CHECK}`);
  await knex.raw(`ALTER TABLE seo_link_intake_items ADD CONSTRAINT ${INTAKE_SOURCE_CHECK} CHECK (source IN (${quoted(values)}))`);
};

exports.up = async function up(knex) {
  await swapCheck(knex, LINK_SOURCES);
  await knex.raw(
    "UPDATE seo_link_intake_items SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND item_key ~ ?",
    [ITEM_KEY_RE],
  );
};

exports.down = async function down(knex) {
  await knex('seo_link_intake_items').where({ source: 'ai_citation' }).update({ source: 'legacy_unknown' });
  await swapCheck(knex, LINK_SOURCES_STEP1);
};
