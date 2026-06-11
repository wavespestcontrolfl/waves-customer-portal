/**
 * Stamp rssMode: 'news' explicitly on existing RSS event sources.
 *
 * The ingestion default for RSS is now news mode (articles → Claude
 * extraction); this migration codifies that intent in data so existing
 * deploys and fresh seeds behave identically and the per-source mode is
 * visible/editable in scrape_config rather than implied by code.
 *
 * Evidence basis (prod, 2026-06-11): every RSS source that produces
 * events writes item pubDate as start_at ≈ pull time (City of Tampa
 * council agendas, Bay News 9 articles, Sarasota Magazine articles) —
 * news-style, not calendar-style. The remaining RSS sources (The
 * Gabber 403, Manatee Chamber XML parse error, Lakewood Ranch zero
 * yield) have produced nothing; they get probed in the source-repair
 * pass and flipped to rssMode: 'calendar' there if warranted.
 *
 * Rows where an operator already set rssMode are left untouched.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  await knex.raw(`
    UPDATE event_sources
    SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || '{"rssMode": "news"}'::jsonb,
        updated_at = now()
    WHERE feed_type = 'rss'
      AND (scrape_config IS NULL OR scrape_config->>'rssMode' IS NULL)
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  // Best-effort: remove only the value this migration set. An
  // operator-set 'calendar' survives the rollback.
  await knex.raw(`
    UPDATE event_sources
    SET scrape_config = scrape_config - 'rssMode',
        updated_at = now()
    WHERE feed_type = 'rss'
      AND scrape_config->>'rssMode' = 'news'
  `);
};
