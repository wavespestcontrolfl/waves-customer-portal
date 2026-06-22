/**
 * Event-source health repairs — 2026-06-22 "Event sources unhealthy" alert.
 *
 * The weekly-digest feed had four sources stuck at zero yield and one
 * hard-failing. The hard failure (The Gabber) was a code-side fix
 * (max_tokens truncation in event-ingestion.js). The four zero-yield
 * sources split into two classes, addressed here:
 *
 * REPAIRED (config — pin the listing container):
 *   - Lakewood Ranch: server-rendered events sit ~84KB into a 2.2MB page;
 *     the default <body> grab truncates at 25KB and never reaches them.
 *     contentSelector pins extraction to the verified events row
 *     (.row.default-pad[style*="margin-top: 5rem"] — the unique container
 *     wrapping all .event-line items, confirmed against the live page).
 *   - Sarasota Chamber: GrowthZone list view; the 42 schema.org Event
 *     cards start ~211KB into the page. contentSelector pins extraction
 *     to the unique .gz-events-cards list container.
 *   Both also get a maxHtmlChars bump (60KB, matching Selby/Ringling) so
 *     the pinned container has room for the soonest ~15 events.
 *
 * DISABLED (no automated path — token-gated SPAs):
 *   - Visit Tampa Bay, Pure Florida (Charlotte County): Simpleview JS
 *     shells whose events load from a token-gated XHR API after hydration;
 *     the rendered DOM never contains the listing, so the LLM extracts
 *     zero events on a "successful" pull. Flagged "LEFT AS-IS (known
 *     degraded)" in the 2026-06-11 repair; fixing properly needs in-browser
 *     XHR interception. Disable so they stop nagging the digest health
 *     check until that work is scheduled.
 */

const MAX_HTML_CHARS = 60000;

async function mergeScrapeConfig(knex, feedUrl, patch) {
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb,
         updated_at = now()
     WHERE feed_url = ?`,
    [JSON.stringify(patch), feedUrl],
  );
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  // ── Config-only repairs: pin the listing container ──────────────
  await mergeScrapeConfig(knex, 'https://lakewoodranch.com/connect/events-list/', {
    contentSelector: '.row.default-pad[style*="margin-top: 5rem"]',
    maxHtmlChars: MAX_HTML_CHARS,
  });
  await mergeScrapeConfig(knex, 'https://business.sarasotachamber.com/community-calendar', {
    contentSelector: '.gz-events-cards',
    maxHtmlChars: MAX_HTML_CHARS,
  });

  // ── Disable the token-gated SPAs (zero-yield, no scrape path) ────
  await knex('event_sources')
    .whereIn('feed_url', [
      'https://www.visittampabay.com/tampa-events/all-events/',
      'https://www.pureflorida.com/events/',
    ])
    .update({ enabled: false, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources')
    .whereIn('feed_url', [
      'https://www.visittampabay.com/tampa-events/all-events/',
      'https://www.pureflorida.com/events/',
    ])
    .update({ enabled: true, updated_at: knex.fn.now() });

  // scrape_config keys added in up() are left in place — harmless without
  // a behavior change and indistinguishable from operator edits (same
  // convention as 20260611000015_event_source_repairs).
};
