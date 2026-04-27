/**
 * Seed initial scrape event source (P3b leg 2). The scrape handler in
 * server/services/event-ingestion.js (added in the same PR) launches
 * Playwright headless Chromium against feed_url, takes the rendered
 * HTML, and asks Claude to extract structured events. For SPA event
 * aggregators that don't expose RSS or iCal.
 *
 * Seeds 1 source as a CANARY:
 *
 *   Visit Sarasota County (visitsarasota.com/events) — the primary
 *   tourism-board event aggregator for Sarasota / Siesta Key /
 *   Venice / Englewood / North Port. Probed in P3a's source survey;
 *   confirmed JS-rendered SPA with no RSS / iCal exposure.
 *
 * Why one canary instead of seeding all 5-6 SPA aggregators from the
 * source-research doc: the scrape handler runs Claude extraction
 * against arbitrary rendered HTML — its quality on a never-tested
 * source is unverifiable in this sandbox. Shipping one source first
 * lets us inspect the first prod cron run + tune the prompt or
 * scrape_config (contentSelector / waitForSelector) before scaling
 * up. Once Visit Sarasota proves out, follow-up PRs can add Visit
 * Tampa Bay, Visit Venice, Visit St. Pete-Clearwater, Pure Florida,
 * Bradenton CVB via direct INSERT or another seed migration.
 *
 * scrape_config defaults (handler will use body if not present):
 *   - contentSelector: optional CSS for the listing container — left
 *     null here so the handler grabs <body>. Tune after observing
 *     the first run.
 *   - waitForSelector: optional CSS to await before extraction —
 *     left null; networkidle wait should suffice for Simpleview.
 *   - maxEvents: capped at 15 by default (handler ceiling 30).
 */

const SCRAPE_SOURCES = [
  {
    name: 'Visit Sarasota County — Events',
    url: 'https://www.visitsarasota.com/events-festivals',
    feed_url: 'https://www.visitsarasota.com/events-festivals',
    feed_type: 'scrape',
    coverage_geo: '{sarasota,siesta-key,venice,englewood,north-port}',
    priority_tier: 1,
    scrape_config: JSON.stringify({
      // Conservative defaults — handler falls back to body if these miss.
      // Operator can tune via UPDATE event_sources after first run.
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 15,
    }),
  },
];

exports.up = async function (knex) {
  await knex('event_sources').insert(SCRAPE_SOURCES);
  console.log(
    `[20260427000005] Seeded ${SCRAPE_SOURCES.length} scrape event_source (Visit Sarasota County canary)`
  );
};

exports.down = async function (knex) {
  // Idempotent rollback by feed_url — safe even if operator added
  // unrelated scrape sources after this migration ran.
  const feedUrls = SCRAPE_SOURCES.map((s) => s.feed_url);
  await knex('event_sources').whereIn('feed_url', feedUrls).del();
};
