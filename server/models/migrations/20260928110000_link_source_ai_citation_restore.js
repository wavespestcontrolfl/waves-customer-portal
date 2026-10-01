/**
 * Third rollback-safety follow-up to 20260928050000_link_source_ai_citation.js
 * — a NEW migration because 20260928060000_link_source_ai_citation_
 * rollback_safety.js and 20260928080000_link_source_ai_citation_rollback_
 * marker.js are both already pushed and FROZEN (supersede, never edit).
 *
 * The bug (Codex P2, 2026-09-28, round 7): 20260928060000's down() relabels
 * every `source = 'ai_citation'` row in seo_link_domains and
 * seo_link_domain_sources to `legacy_unknown` so 20260928050000's
 * CHECK-narrowing down() can run, but its up() is a no-op, so a later
 * reapply never restores the label. ensureDomain never rewrites a domain's
 * first-touch `source`, and an existing `ai_citation:*` touch_key stops the
 * feeder from writing a fresh touch, so registry provenance (and every
 * source-based investigation / report) would stay wrong for good. The
 * authority guard itself already survives via source_detail
 * (link-authority-policy.js isDiscoveryOnlyDomain) — this restores the
 * PROVENANCE label.
 *
 * up() restores `source = 'ai_citation'` on exactly the rows that down()
 * relabels, identified by what 060000's down() never touches:
 *   - seo_link_domains: `source = 'legacy_unknown'` AND a first-touch
 *     source_detail only the feeder ever writes — the current
 *     `ai_citation:<category>…` prefix, or the feeder's earlier
 *     `ai_citation_feeder · <listing|editorial> · <n>x · …` label.
 *   - seo_link_domain_sources: `source = 'legacy_unknown'` AND a touch_key
 *     starting `ai_citation:` (link-registry.js touchKey() is
 *     `${source}:${ref|detail|digest}`, so only a touch written with source
 *     ai_citation carries that key; a genuine legacy_unknown touch's key
 *     starts `legacy_unknown:`).
 * Knex applies this file after 20260928050000, so the widened CHECK that
 * admits 'ai_citation' is always in place when it runs. On an ordinary
 * forward deploy no row matches (nothing was ever relabeled) — both
 * UPDATEs change zero rows. A rollback that reaches 20260928060000 reverts
 * this file first (last-applied-first), and a reapply re-runs it after
 * 050000 / 060000 / 080000, which is exactly when the restore is needed.
 *
 * down() is a documented no-op: 20260928060000's own down() already
 * relabels whatever this restored, in the same rollback.
 *
 * The patterns are FROZEN literals (no service require):
 * link-source-ai-citation-restore-migration.test.js pins them equal to
 * link-authority-policy.js's AI_CITATION_SOURCE_DETAIL_PREFIX and
 * LEGACY_AI_CITATION_SOURCE_DETAIL_RE. Postgres `~` (POSIX) is used, never
 * LIKE, whose `_` wildcard would also match "aiXcitation:".
 */

const DETAIL_PREFIX_RE = '^ai_citation:';
const LEGACY_DETAIL_RE = '^ai_citation_feeder · (listing|editorial) · [0-9]+x · ';
const TOUCH_KEY_RE = '^ai_citation:';

exports.up = async function up(knex) {
  await knex.raw(
    "UPDATE seo_link_domains SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND (source_detail ~ ? OR source_detail ~ ?)",
    [DETAIL_PREFIX_RE, LEGACY_DETAIL_RE],
  );
  await knex.raw(
    "UPDATE seo_link_domain_sources SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND touch_key ~ ?",
    [TOUCH_KEY_RE],
  );
};

exports.down = async function down() {
  // Intentionally nothing — see header.
};
