/**
 * Newsletter event-ingestion foundation. Two tables:
 *
 * - event_sources    Registry of every place we pull events from.
 *                    Schema accommodates RSS / iCal / scrape / JSON feed
 *                    types from day one so future ingestion handlers
 *                    plug in without a migration. P3a only ships the
 *                    RSS handler; iCal + scrape land in P3b.
 *
 * - events_raw       Normalized event rows pulled from any source.
 *                    Single shape regardless of feed type. The
 *                    NewsletterPage Dashboard's "Upcoming events worth
 *                    writing about" tiles read from this table.
 *
 * Seeds 6 RSS sources sourced from the user's source-research doc:
 *   - City of Tampa (RSS — confirmed, cleanest official feed in region)
 *   - Bay News 9 "On The Town" (RSS — Tampa Bay editorial events)
 *   - Manatee Chamber Upcoming Events (RSS — public+business events;
 *                                       caveat: doc flagged a possible
 *                                       login-redirect, ingestion will
 *                                       fail-closed gracefully if so)
 *   - Sarasota Magazine (RSS — Atom; arts/food editorial)
 *   - The Gabber Events (RSS — Gulfport / South Pinellas / Gulf Beaches)
 *   - Lakewood Ranch events (RSS — hyperlocal Manatee/East County)
 *
 * Coverage geo is a Postgres text[] of city/region slugs; the dashboard
 * filter logic + future per-domain spoke routing read from it. Slugs
 * are kebab-case lowercase to match the spoke-fleet domain pattern.
 *
 * Both tables get indexes on the columns we'll filter by daily:
 *   - events_raw(start_at) for "upcoming events in the next N days"
 *   - events_raw(source_id) for source-specific debugging
 *   - event_sources(enabled, priority_tier) for the cron's pull list
 */

exports.up = async function (knex) {
  await knex.schema.createTable('event_sources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 128).notNullable();
    table.string('url', 512).notNullable(); // public-facing source URL
    table.string('feed_url', 512).notNullable(); // the actual feed/scrape URL
    table.string('feed_type', 16).notNullable(); // 'rss' | 'ical' | 'scrape' | 'json'
    table.specificType('coverage_geo', 'text[]').notNullable().defaultTo('{}'); // ['sarasota','manatee']
    table.smallint('priority_tier').notNullable().defaultTo(3); // 1=highest, 6=lowest
    table.boolean('enabled').notNullable().defaultTo(true);
    table.jsonb('scrape_config').nullable(); // CSS selectors etc for the future Playwright handler
    table.timestamp('last_pulled_at').nullable();
    table.string('last_pull_status', 16).nullable(); // 'success' | 'error' | null=never
    table.text('last_error').nullable();
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['feed_url']); // a feed URL is the natural unique key
    table.index(['enabled', 'priority_tier'], 'idx_event_sources_pull_list');
  });

  await knex.schema.createTable('events_raw', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('source_id').notNullable().references('id').inTable('event_sources').onDelete('CASCADE');
    table.string('external_id', 256).notNullable(); // dedup key from the source (RSS guid, iCal uid, etc)
    table.string('title', 512).notNullable();
    table.text('description').nullable();
    table.timestamp('start_at').nullable(); // some feeds are dateless ("Saturday Markets every weekend")
    table.timestamp('end_at').nullable();
    table.string('venue_name', 256).nullable();
    table.string('venue_address', 512).nullable();
    table.string('city', 128).nullable();
    table.double('geo_lat').nullable();
    table.double('geo_lng').nullable();
    table.string('event_url', 1024).nullable();
    table.string('image_url', 1024).nullable();
    table.jsonb('categories').nullable(); // tags/categories from the source
    table.timestamp('pulled_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    // Per-source dedup. Re-pulling the same event updates the existing row
    // (via ON CONFLICT) instead of inserting a duplicate.
    table.unique(['source_id', 'external_id']);
    table.index(['start_at'], 'idx_events_raw_start_at');
    table.index(['source_id'], 'idx_events_raw_source_id');
  });

  // Seed 6 RSS sources. enabled=true for all; the ingestion service
  // will mark consecutive_failures and the dashboard can show health.
  await knex('event_sources').insert([
    {
      name: 'City of Tampa — All Events',
      url: 'https://www.tampa.gov/calendar',
      feed_url: 'https://www.tampa.gov/calendar/rss.xml',
      feed_type: 'rss',
      coverage_geo: '{tampa,hillsborough}',
      priority_tier: 1,
    },
    {
      name: 'Bay News 9 — On The Town',
      url: 'https://www.baynews9.com/fl/tampa/on-the-town',
      feed_url: 'https://www.baynews9.com/services/contentfeed.fl%7Ctampa%7Con-the-town.hero.rss',
      feed_type: 'rss',
      coverage_geo: '{tampa,st-petersburg,clearwater,hillsborough,pinellas}',
      priority_tier: 1,
    },
    {
      name: 'Manatee Chamber — Upcoming Events',
      url: 'https://business.manateechamber.com/events',
      feed_url: 'https://manateechamber.chambermaster.com/feed/rss/UpcomingEvents.rss',
      feed_type: 'rss',
      coverage_geo: '{bradenton,lakewood-ranch,parrish,palmetto,manatee}',
      priority_tier: 2,
    },
    {
      name: 'Sarasota Magazine',
      url: 'https://www.sarasotamagazine.com',
      feed_url: 'https://www.sarasotamagazine.com/feed',
      feed_type: 'rss',
      coverage_geo: '{sarasota,siesta-key,longboat-key}',
      priority_tier: 2,
    },
    {
      name: 'The Gabber — Events',
      url: 'https://thegabber.com/events',
      feed_url: 'https://thegabber.com/evofeed',
      feed_type: 'rss',
      coverage_geo: '{gulfport,st-petersburg,pinellas}',
      priority_tier: 3,
    },
    {
      name: 'Lakewood Ranch — Events',
      url: 'https://www.lakewoodranch.com/events',
      feed_url: 'https://www.lakewoodranch.com/events/feed/',
      feed_type: 'rss',
      coverage_geo: '{lakewood-ranch,manatee}',
      priority_tier: 1,
    },
  ]);

  console.log('[20260427000003] Seeded 6 RSS event_sources for newsletter ingestion (P3a)');
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('events_raw');
  await knex.schema.dropTableIfExists('event_sources');
};
