/**
 * Seed event sources round 3 — corridor gap-fill.
 *
 * Adds 10 scrape sources across three categories:
 *
 *   City/County official calendars (tier 1):
 *     - City of North Port — Events
 *     - City of Venice — Events
 *     - City of Sarasota — Events
 *     - City of Bradenton — Events
 *
 *   Major venue calendars (tier 2):
 *     - Van Wezel Performing Arts Hall
 *     - Marie Selby Botanical Gardens
 *     - Ringling Museum
 *     - Clearwater Marine Aquarium — Events
 *
 *   Regional aggregators (tier 2):
 *     - Sarasota Chamber — Events
 *     - Venice Area Chamber — Events
 *
 * All are JS-rendered or hybrid pages with no RSS/iCal exposure,
 * so they use feed_type: 'scrape' with conservative defaults
 * (contentSelector/waitForSelector null, handler falls back to
 * body + networkidle). Operator can tune via UPDATE after first
 * cron run.
 */

const NEW_SOURCES = [
  // City/County official calendars
  {
    name: 'City of North Port — Events',
    url: 'https://www.northportfl.gov/Community-Recreation/Events',
    feed_url: 'https://www.northportfl.gov/Community-Recreation/Events',
    feed_type: 'scrape',
    coverage_geo: '{north-port}',
    priority_tier: 1,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
  {
    name: 'City of Venice — Events',
    url: 'https://www.venicegov.com/things-to-do/events',
    feed_url: 'https://www.venicegov.com/things-to-do/events',
    feed_type: 'scrape',
    coverage_geo: '{venice,nokomis}',
    priority_tier: 1,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
  {
    name: 'City of Sarasota — Events',
    url: 'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events',
    feed_url: 'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events',
    feed_type: 'scrape',
    coverage_geo: '{sarasota}',
    priority_tier: 1,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
  {
    name: 'City of Bradenton — Events',
    url: 'https://www.bradentonfl.gov/events',
    feed_url: 'https://www.bradentonfl.gov/events',
    feed_type: 'scrape',
    coverage_geo: '{bradenton,manatee}',
    priority_tier: 1,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
  // Major venue calendars
  {
    name: 'Van Wezel Performing Arts Hall',
    url: 'https://www.vanwezel.org/events',
    feed_url: 'https://www.vanwezel.org/events',
    feed_type: 'scrape',
    coverage_geo: '{sarasota}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 20 }),
  },
  {
    name: 'Marie Selby Botanical Gardens',
    url: 'https://selby.org/events',
    feed_url: 'https://selby.org/events',
    feed_type: 'scrape',
    coverage_geo: '{sarasota}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 10 }),
  },
  {
    name: 'Ringling Museum',
    url: 'https://www.ringling.org/events',
    feed_url: 'https://www.ringling.org/events',
    feed_type: 'scrape',
    coverage_geo: '{sarasota}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 10 }),
  },
  {
    name: 'Clearwater Marine Aquarium — Events',
    url: 'https://www.cmaquarium.org/events',
    feed_url: 'https://www.cmaquarium.org/events',
    feed_type: 'scrape',
    coverage_geo: '{clearwater,pinellas}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 10 }),
  },
  // Regional aggregators
  {
    name: 'Sarasota Chamber — Events',
    url: 'https://www.sarasotachamber.com/events',
    feed_url: 'https://www.sarasotachamber.com/events',
    feed_type: 'scrape',
    coverage_geo: '{sarasota,siesta-key,longboat-key}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
  {
    name: 'Venice Area Chamber — Events',
    url: 'https://www.venicechamber.com/events',
    feed_url: 'https://www.venicechamber.com/events',
    feed_type: 'scrape',
    coverage_geo: '{venice,nokomis,osprey,englewood}',
    priority_tier: 2,
    scrape_config: JSON.stringify({ contentSelector: null, waitForSelector: null, maxEvents: 15 }),
  },
];

exports.up = async function (knex) {
  await knex('event_sources').insert(NEW_SOURCES).onConflict('feed_url').ignore();
  console.log(
    `[20260525000002] Seeded ${NEW_SOURCES.length} event sources (city calendars, venue feeds, chamber aggregators)`
  );
};

exports.down = async function (knex) {
  const feedUrls = NEW_SOURCES.map((s) => s.feed_url);
  await knex('event_sources').whereIn('feed_url', feedUrls).del();
};
