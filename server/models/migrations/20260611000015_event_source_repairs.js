/**
 * Event-source fleet repair — 2026-06-11 live probe results.
 *
 * 20 of 25 enabled sources were either hard-failing (5) or had never
 * produced a single event (15). Every change below was verified against
 * the live endpoint on 2026-06-11 (HTTP status + sample event with a
 * real future date) unless marked otherwise.
 *
 * DISABLED (7) — no automated path to content exists:
 *   - Charlotte PAC: charlottepac.com has no NS records (registration
 *     lapsed); venue's replacement site is a suspended host; ticketing
 *     page is hard bot-walled.
 *   - Visit St. Pete-Clearwater, Visit Sarasota County: site-wide
 *     Cloudflare Managed Challenge — instant 403 to all automation,
 *     UA-independent. (This was the "Playwright timeout" — the
 *     challenge page polls forever, networkidle never fires.)
 *   - City of North Port / Sarasota / Venice: domain-wide Akamai edge
 *     403 for datacenter traffic.
 *   - City of Bradenton: redirected to a permit page; the city
 *     publishes no event calendar at all.
 *
 * REPAIRED:
 *   - Manatee Chamber: chambermaster.com feeds moved behind a login
 *     wall (the RSS "parse error" was the Login HTML page); the public
 *     GrowthZone host serves the same feed openly.
 *   - The Gabber: WP Engine host UA-filters non-browser agents →
 *     per-source browser UA (code support in event-ingestion.js).
 *   - Lakewood Ranch: old feed was the WordPress COMMENTS feed for the
 *     events page (always empty); real listing is server-rendered.
 *   - Sarasota Chamber / Venice Chamber: URLs were 404s; the GrowthZone
 *     calendars are server-rendered with schema.org microdata.
 *   - Bradenton Area CVB: events grid is JS-hydrated (empty static
 *     HTML); the WP REST event endpoint returns full JSON incl. dates.
 *   - Visit Venice FL / Clearwater Marine Aquarium: The Events Calendar
 *     iCal feeds verified (26 / 6 VEVENTs) — strictly better than
 *     scraping 1.35MB Elementor pages. Visit Venice's WAF needs the
 *     browser UA.
 *   - Selby Gardens / Ringling: events ARE server-rendered but buried
 *     in 796KB/376KB of page-builder markup past the extraction
 *     budget → contentSelector pins extraction to the verified listing
 *     container (.mec-skin-list-events-container / .events-list).
 *
 * LEFT AS-IS (known degraded): Visit Tampa Bay, Pure Florida —
 * Simpleview JS shells with token-gated event APIs; need in-browser
 * XHR interception to fix properly. Zero-yield health tracking keeps
 * them visible.
 */

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

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

  // ── Disable the unreachable ─────────────────────────────────────
  await knex('event_sources')
    .whereIn('feed_url', [
      'https://charlottepac.com/events/?ical=1',
      'https://www.visitstpeteclearwater.com/events',
      'https://www.visitsarasota.com/events-festivals',
      'https://www.northportfl.gov/Community-Recreation/Events',
      'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events',
      'https://www.venicegov.com/things-to-do/events',
      'https://www.bradentonfl.gov/events',
    ])
    .update({ enabled: false, updated_at: knex.fn.now() });

  // ── Repair feed URLs / types ────────────────────────────────────
  await knex('event_sources')
    .where({ feed_url: 'https://manateechamber.chambermaster.com/feed/rss/UpcomingEvents.rss' })
    .update({
      feed_url: 'https://business.manateechamber.com/feed/rss/UpcomingEvents.rss',
      updated_at: knex.fn.now(),
    });

  await knex('event_sources')
    .where({ feed_url: 'https://www.lakewoodranch.com/events/feed/' })
    .update({
      feed_url: 'https://lakewoodranch.com/connect/events-list/',
      feed_type: 'scrape',
      updated_at: knex.fn.now(),
    });

  await knex('event_sources')
    .where({ feed_url: 'https://www.sarasotachamber.com/events' })
    .update({
      feed_url: 'https://business.sarasotachamber.com/community-calendar',
      updated_at: knex.fn.now(),
    });

  await knex('event_sources')
    .where({ feed_url: 'https://www.venicechamber.com/events' })
    .update({
      feed_url: 'https://business.venicechamber.com/chamber-events',
      updated_at: knex.fn.now(),
    });

  await knex('event_sources')
    .where({ feed_url: 'https://www.bradentongulfislands.com/events/' })
    .update({
      // WP REST event CPT — JSON body, trivially extractable by the
      // scrape handler's LLM pass without any JS rendering.
      feed_url: 'https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100',
      updated_at: knex.fn.now(),
    });

  await knex('event_sources')
    .where({ feed_url: 'https://www.visitvenicefl.org/calendar/' })
    .update({
      feed_url: 'https://www.visitvenicefl.org/events/?ical=1',
      feed_type: 'ical',
      updated_at: knex.fn.now(),
    });
  await mergeScrapeConfig(knex, 'https://www.visitvenicefl.org/events/?ical=1', { userAgent: BROWSER_UA });

  await knex('event_sources')
    .where({ feed_url: 'https://www.cmaquarium.org/events' })
    .update({
      feed_url: 'https://www.cmaquarium.org/events/?ical=1',
      feed_type: 'ical',
      updated_at: knex.fn.now(),
    });

  // ── Config-only repairs ─────────────────────────────────────────
  await mergeScrapeConfig(knex, 'https://thegabber.com/evofeed', { userAgent: BROWSER_UA });
  await mergeScrapeConfig(knex, 'https://selby.org/events', {
    contentSelector: '.mec-skin-list-events-container',
    maxHtmlChars: 60000,
  });
  await knex('event_sources')
    .where({ feed_url: 'https://www.ringling.org/events' })
    .update({ feed_url: 'https://www.ringling.org/events/type/all/', updated_at: knex.fn.now() });
  await mergeScrapeConfig(knex, 'https://www.ringling.org/events/type/all/', {
    contentSelector: '.events-list',
    maxHtmlChars: 60000,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources')
    .whereIn('feed_url', [
      'https://charlottepac.com/events/?ical=1',
      'https://www.visitstpeteclearwater.com/events',
      'https://www.visitsarasota.com/events-festivals',
      'https://www.northportfl.gov/Community-Recreation/Events',
      'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events',
      'https://www.venicegov.com/things-to-do/events',
      'https://www.bradentonfl.gov/events',
    ])
    .update({ enabled: true, updated_at: knex.fn.now() });

  const reverts = [
    ['https://business.manateechamber.com/feed/rss/UpcomingEvents.rss', 'https://manateechamber.chambermaster.com/feed/rss/UpcomingEvents.rss', null],
    ['https://lakewoodranch.com/connect/events-list/', 'https://www.lakewoodranch.com/events/feed/', 'rss'],
    ['https://business.sarasotachamber.com/community-calendar', 'https://www.sarasotachamber.com/events', null],
    ['https://business.venicechamber.com/chamber-events', 'https://www.venicechamber.com/events', null],
    ['https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100', 'https://www.bradentongulfislands.com/events/', null],
    ['https://www.visitvenicefl.org/events/?ical=1', 'https://www.visitvenicefl.org/calendar/', 'scrape'],
    ['https://www.cmaquarium.org/events/?ical=1', 'https://www.cmaquarium.org/events', 'scrape'],
    ['https://www.ringling.org/events/type/all/', 'https://www.ringling.org/events', null],
  ];
  for (const [current, original, originalType] of reverts) {
    await knex('event_sources')
      .where({ feed_url: current })
      .update({
        feed_url: original,
        ...(originalType ? { feed_type: originalType } : {}),
        updated_at: knex.fn.now(),
      });
  }
  // scrape_config keys added in up() are left in place — harmless
  // without the new feed URLs and indistinguishable from operator edits.
};
