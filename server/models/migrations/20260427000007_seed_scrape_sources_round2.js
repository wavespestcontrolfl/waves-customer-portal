/**
 * Round-2 scrape source expansion (P3b leg 2 follow-up). Builds on
 * the canary seeded in 20260427000005_seed_scrape_event_sources.js
 * (Visit Sarasota County) by adding 5 more SPA event aggregators
 * from the source-research doc. All probed live during P3a's source
 * survey (HTTP 200, JS-rendered, no RSS/iCal exposure → scrape-only).
 *
 * IMPORTANT: shipped while the Visit Sarasota canary itself is still
 * un-verified in prod (the 4am ET ingestion cron hasn't run yet at
 * the time this migration was written). If the scrape handler turns
 * out to misbehave on Simpleview-style SPAs, ALL of these will need
 * scrape_config tuning together. Operator can disable any failing
 * source via:
 *   UPDATE event_sources SET enabled = false
 *    WHERE name = 'Visit Tampa Bay — Events';
 *
 * Cost model: ~$0.05 / scrape / day per source = ~$0.25/day across
 * these 5 + ~$0.05/day for the canary = ~$0.30/day total. Bounded
 * by event-ingestion.js's per-source 15s timeout + 25k char input
 * cap to Claude.
 *
 * Coverage spread:
 *   - Visit Tampa Bay        Tampa, Hillsborough
 *   - Visit Venice FL        Venice, South Sarasota County
 *   - Visit St. Pete-Clearwater  Pinellas, beach communities
 *   - Pure Florida           Charlotte County (Punta Gorda, Englewood)
 *   - Bradenton Area CVB     Manatee, Anna Maria, Lakewood Ranch
 *
 * Tier 2 priority — Sarasota canary is Tier 1 (covers core service
 * area); these expand reach into adjacent markets.
 */

const SCRAPE_SOURCES = [
  {
    name: 'Visit Tampa Bay — Events',
    url: 'https://www.visittampabay.com/tampa-events/all-events/',
    feed_url: 'https://www.visittampabay.com/tampa-events/all-events/',
    feed_type: 'scrape',
    coverage_geo: '{tampa,hillsborough}',
    priority_tier: 2,
    scrape_config: JSON.stringify({
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 15,
    }),
  },
  {
    name: 'Visit Venice FL — Calendar',
    url: 'https://www.visitvenicefl.org/calendar/',
    feed_url: 'https://www.visitvenicefl.org/calendar/',
    feed_type: 'scrape',
    coverage_geo: '{venice,nokomis,osprey}',
    priority_tier: 2,
    scrape_config: JSON.stringify({
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 12,
    }),
  },
  {
    name: 'Visit St. Pete-Clearwater — Events',
    url: 'https://www.visitstpeteclearwater.com/events',
    feed_url: 'https://www.visitstpeteclearwater.com/events',
    feed_type: 'scrape',
    coverage_geo: '{st-petersburg,clearwater,pinellas}',
    priority_tier: 2,
    scrape_config: JSON.stringify({
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 15,
    }),
  },
  {
    name: 'Pure Florida — Events (Charlotte County)',
    url: 'https://www.pureflorida.com/events/',
    feed_url: 'https://www.pureflorida.com/events/',
    feed_type: 'scrape',
    coverage_geo: '{punta-gorda,port-charlotte,englewood,charlotte}',
    priority_tier: 2,
    scrape_config: JSON.stringify({
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 15,
    }),
  },
  {
    name: 'Bradenton Area CVB — Events',
    url: 'https://www.bradentongulfislands.com/events/',
    feed_url: 'https://www.bradentongulfislands.com/events/',
    feed_type: 'scrape',
    coverage_geo: '{bradenton,anna-maria,lakewood-ranch,manatee}',
    priority_tier: 2,
    scrape_config: JSON.stringify({
      contentSelector: null,
      waitForSelector: null,
      maxEvents: 15,
    }),
  },
];

exports.up = async function (knex) {
  await knex('event_sources').insert(SCRAPE_SOURCES);
  console.log(
    `[20260427000007] Seeded ${SCRAPE_SOURCES.length} scrape event_sources (round 2: Visit Tampa Bay, Visit Venice, Visit St. Pete-Clearwater, Pure Florida, Bradenton CVB)`
  );
};

exports.down = async function (knex) {
  // Idempotent rollback by feed_url — won't disturb operator-added
  // scrape sources that may have landed after this migration ran.
  const feedUrls = SCRAPE_SOURCES.map((s) => s.feed_url);
  await knex('event_sources').whereIn('feed_url', feedUrls).del();
};
