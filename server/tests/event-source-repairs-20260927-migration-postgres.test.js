// Runs with the existing CI PostgreSQL pass; never a production connection.
// Verifies the raw-SQL JSONB scrape_config merge (mergeScrapeConfig) and the
// plain column updates this migration makes against a real event_sources
// table — a knex/jest mock can't exercise the `COALESCE(...) || ?::jsonb`
// merge honestly, and every prior migration in this repair family
// (20260611000015 / 20260622000001 / 20260805000001) relies on that exact
// SQL, so this is the first migration in the family to get a contract test.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20260927120000_event_source_repairs_20260927');
const guardMigration = require('../models/migrations/20260927115000_guard_wellen_event_source_rename');
const seedMigration = require('../models/migrations/20260927140000_seed_clearwater_wellen_event_sources');
const wellenMigration = require('../models/migrations/20260927150000_convert_legacy_wellen_event_source');

const DISABLE_FEED_URLS = [
  'https://www.visitsarasota.com/events-festivals',
  'https://www.visitstpeteclearwater.com/events',
  'https://www.visittampabay.com/tampa-events/all-events/',
];

async function seedSource(db, overrides) {
  await db('event_sources').insert({
    name: overrides.name,
    url: overrides.url || 'https://example.com',
    feed_url: overrides.feed_url,
    feed_type: overrides.feed_type,
    priority_tier: overrides.priority_tier ?? 3,
    enabled: overrides.enabled ?? true,
    scrape_config: overrides.scrape_config ? JSON.stringify(overrides.scrape_config) : null,
    consecutive_failures: overrides.consecutive_failures ?? 0,
    consecutive_zero_yields: overrides.consecutive_zero_yields ?? 0,
    last_error: overrides.last_error ?? null,
  });
}

(SKIP ? describe.skip : describe)('event-source repairs 20260927 (PostgreSQL)', () => {
  let db;
  const schema = `event_source_repairs_20260927_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // Relevant columns only — mirrors 20260427000003_event_ingestion_foundation
    // + 20260611000012_event_sources_yield_tracking, the two migrations that
    // define every column this migration reads or writes.
    await db.schema.createTable('event_sources', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.string('url', 512).notNullable();
      t.string('feed_url', 512).notNullable().unique();
      t.string('feed_type', 16).notNullable();
      t.specificType('coverage_geo', 'text[]').nullable();
      t.smallint('priority_tier').notNullable().defaultTo(3);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.jsonb('scrape_config').nullable();
      t.text('last_error').nullable();
      t.integer('consecutive_failures').notNullable().defaultTo(0);
      t.integer('consecutive_zero_yields').notNullable().defaultTo(0);
      t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
    });
  }, 30000);

  afterAll(async () => {
    await db?.schema.dropSchemaIfExists(schema, true).catch(() => {});
    await db?.destroy();
  });

  beforeEach(async () => {
    await db('event_sources').del();
    await seedSource(db, {
      name: 'Visit Sarasota County — Events',
      feed_url: 'https://www.visitsarasota.com/events-festivals',
      feed_type: 'scrape',
      priority_tier: 1,
      scrape_config: { proxy: 'residential', userAgent: 'UA', maxEvents: 15 },
      consecutive_failures: 60,
      last_error: 'HTTP 403',
    });
    await seedSource(db, {
      name: 'Visit St. Pete-Clearwater — Events',
      feed_url: 'https://www.visitstpeteclearwater.com/events',
      feed_type: 'scrape',
      priority_tier: 2,
      scrape_config: { proxy: 'residential', userAgent: 'UA', maxEvents: 15 },
      consecutive_failures: 52,
      last_error: 'HTTP 403',
    });
    await seedSource(db, {
      name: 'Visit Tampa Bay — Events',
      feed_url: 'https://www.visittampabay.com/tampa-events/all-events/',
      feed_type: 'scrape',
      priority_tier: 2,
      scrape_config: { maxEvents: 15 },
      consecutive_zero_yields: 62,
    });
    await seedSource(db, {
      name: 'Ringling Museum',
      feed_url: 'https://www.ringling.org/events/type/all/',
      feed_type: 'scrape',
      priority_tier: 2,
      scrape_config: { maxEvents: 10, maxHtmlChars: 60000, contentSelector: '.events-list' },
      consecutive_failures: 1,
      last_error: 'HTTP 403 from https://www.ringling.org/events/type/all/',
    });
    await seedSource(db, {
      name: 'City of Clearwater — Events',
      feed_url: 'https://www.myclearwater.com/Events-and-Meetings',
      feed_type: 'scrape',
      priority_tier: 2,
      scrape_config: { maxEvents: 15, gotoTimeoutMs: 45000 },
      consecutive_zero_yields: 60,
    });
    await seedSource(db, {
      name: 'Mote Marine Laboratory — Events',
      feed_url: 'https://mote.org/events/?ical=1',
      feed_type: 'ical',
      priority_tier: 3,
      consecutive_zero_yields: 1,
    });
    await seedSource(db, {
      name: 'Wellen Park — Events',
      feed_url: 'https://wellenpark.com/events/feed/',
      feed_type: 'rss',
      priority_tier: 2,
      scrape_config: { maxEvents: 12 },
      consecutive_zero_yields: 52,
    });
    await seedSource(db, {
      name: 'Sarasota Magazine',
      feed_url: 'https://www.sarasotamagazine.com/feed',
      feed_type: 'rss',
      priority_tier: 2,
      scrape_config: { rssMode: 'news' },
      consecutive_zero_yields: 22,
    });
    await seedSource(db, {
      name: 'Lakewood Ranch — Events',
      feed_url: 'https://lakewoodranch.com/connect/events-list/',
      feed_type: 'scrape',
      priority_tier: 1,
      scrape_config: { rssMode: 'news', maxHtmlChars: 60000, contentSelector: '.row.default-pad' },
    });
    await seedSource(db, {
      name: 'Manatee Chamber — Upcoming Events',
      feed_url: 'https://business.manateechamber.com/feed/rss/UpcomingEvents.rss',
      feed_type: 'rss',
      priority_tier: 2,
      scrape_config: { rssMode: 'news' },
    });
  });

  test('disables the three unrecoverable bot-walled sources', async () => {
    await migration.up(db);
    const rows = await db('event_sources').whereIn('feed_url', DISABLE_FEED_URLS);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  test('leaves Ringling untouched (no browser-UA workaround)', async () => {
    await migration.up(db);
    const row = await db('event_sources').where({ feed_url: 'https://www.ringling.org/events/type/all/' }).first();
    expect(row.scrape_config.userAgent).toBeUndefined();
  });

  test('pins Clearwater to the verified listing container and resets its zero-yield streak', async () => {
    await migration.up(db);
    const row = await db('event_sources').where({ feed_url: 'https://www.myclearwater.com/Events-and-Meetings' }).first();
    expect(row.scrape_config).toMatchObject({
      contentSelector: '.events-list-container',
      maxHtmlChars: 30000,
      maxEvents: 15, // an existing key merge preserves
      gotoTimeoutMs: 45000,
    });
    expect(row.consecutive_zero_yields).toBe(0);
  });

  test('repairs the Mote iCal export URL', async () => {
    await migration.up(db);
    const old = await db('event_sources').where({ feed_url: 'https://mote.org/events/?ical=1' }).first();
    expect(old).toBeUndefined();
    const row = await db('event_sources').where({ feed_url: 'https://mote.org/?post_type=tribe_events&ical=1&eventDisplay=list' }).first();
    expect(row).toBeTruthy();
    expect(row.feed_type).toBe('ical');
    expect(row.consecutive_zero_yields).toBe(0);
  });

  test('switches Wellen Park from the dead archive RSS to the real events page (scrape)', async () => {
    await migration.up(db);
    const row = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' }).first();
    expect(row).toBeTruthy();
    expect(row.feed_type).toBe('scrape');
    expect(row.scrape_config).toMatchObject({
      contentSelector: 'section.featured-events-slider',
      maxHtmlChars: 40000,
      maxEvents: 12, // preserved from before the switch
    });
    expect(row.consecutive_zero_yields).toBe(0);
  });

  test('switches Sarasota Magazine to the standing Things to Do page (scrape)', async () => {
    await migration.up(db);
    const row = await db('event_sources').where({ feed_url: 'https://www.sarasotamagazine.com/arts-and-entertainment/things-to-do-sarasota' }).first();
    expect(row).toBeTruthy();
    expect(row.feed_type).toBe('scrape');
    expect(row.scrape_config).toMatchObject({ contentSelector: '.c-body' });
    expect(row.consecutive_zero_yields).toBe(0);
  });

  test('lowers Lakewood Ranch and Manatee Chamber to the lowest priority tier already in use', async () => {
    await migration.up(db);
    const lwr = await db('event_sources').where({ feed_url: 'https://lakewoodranch.com/connect/events-list/' }).first();
    const chamber = await db('event_sources').where({ feed_url: 'https://business.manateechamber.com/feed/rss/UpcomingEvents.rss' }).first();
    expect(lwr.priority_tier).toBe(3);
    expect(chamber.priority_tier).toBe(3);
  });

  test('repeat-up is idempotent', async () => {
    await migration.up(db);
    await migration.up(db);
    const rows = await db('event_sources').select('feed_url', 'feed_type', 'enabled', 'priority_tier');
    expect(rows.find((r) => r.feed_url === 'https://mote.org/?post_type=tribe_events&ical=1&eventDisplay=list')).toBeTruthy();
    expect(rows.filter((r) => DISABLE_FEED_URLS.includes(r.feed_url) && r.enabled === false)).toHaveLength(3);
  });

  test('down is a no-op: sources keep their repaired state', async () => {
    await migration.up(db);
    await migration.down(db);

    const disabled = await db('event_sources').whereIn('feed_url', DISABLE_FEED_URLS);
    expect(disabled.every((r) => r.enabled === false)).toBe(true);
    const mote = await db('event_sources').where({ feed_url: 'https://mote.org/?post_type=tribe_events&ical=1&eventDisplay=list' }).first();
    expect(mote).toBeTruthy();
  });

  test('seeds Clearwater and Wellen Park when a fresh database never had them', async () => {
    await db('event_sources').whereIn('feed_url', [
      'https://www.myclearwater.com/Events-and-Meetings',
      'https://wellenpark.com/events/feed/',
      'https://wellenpark.com/events/',
    ]).del();
    await migration.up(db);
    await seedMigration.up(db);
    const clearwater = await db('event_sources').where({ feed_url: 'https://www.myclearwater.com/Events-and-Meetings' });
    const wellen = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' });
    expect(clearwater).toHaveLength(1);
    expect(clearwater[0].scrape_config).toMatchObject({ contentSelector: '.events-list-container' });
    expect(wellen).toHaveLength(1);
    expect(wellen[0].feed_type).toBe('scrape');
    expect(wellen[0].scrape_config).toMatchObject({ contentSelector: 'section.featured-events-slider' });
  });

  test('seed does not duplicate or alter existing Clearwater / Wellen Park rows', async () => {
    await seedMigration.up(db);
    await migration.up(db);
    await seedMigration.up(db);
    expect(await db('event_sources').where({ feed_url: 'https://www.myclearwater.com/Events-and-Meetings' })).toHaveLength(1);
    const rows = await db('event_sources').where('name', 'like', 'Wellen Park%');
    expect(rows).toHaveLength(1);
  });

  test('legacy Wellen conversion renames a legacy Wellen RSS row that reappears after the repair ran', async () => {
    await migration.up(db);
    await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' }).del();
    await db('event_sources').insert({
      name: 'Wellen Park — Events', url: 'https://wellenpark.com/events/',
      feed_url: 'https://wellenpark.com/events/feed/', feed_type: 'rss', priority_tier: 2, enabled: true,
    });
    await seedMigration.up(db);
    await wellenMigration.up(db);
    expect(await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/feed/' })).toHaveLength(0);
    const row = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' }).first();
    expect(row.feed_type).toBe('scrape');
    expect(row.scrape_config).toMatchObject({ contentSelector: 'section.featured-events-slider' });
  });

  test('legacy Wellen conversion disables a legacy Wellen RSS row when the repaired row already exists', async () => {
    await migration.up(db);
    await db('event_sources').insert({
      name: 'Wellen Park — Events (legacy)', url: 'https://wellenpark.com/events/',
      feed_url: 'https://wellenpark.com/events/feed/', feed_type: 'rss', priority_tier: 2, enabled: true,
    });
    await seedMigration.up(db);
    await wellenMigration.up(db);
    const legacy = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/feed/' }).first();
    expect(legacy.enabled).toBe(false);
    expect(await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' })).toHaveLength(1);
  });

  test('full sequence succeeds when both Wellen URLs exist before the batch', async () => {
    await db('event_sources').insert({
      name: 'Wellen Park — Events (page)', url: 'https://wellenpark.com/events/',
      feed_url: 'https://wellenpark.com/events/', feed_type: 'scrape', priority_tier: 2, enabled: true,
    });
    const legacyBefore = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/feed/' }).first();

    await guardMigration.up(db);
    await migration.up(db);
    await seedMigration.up(db);
    await wellenMigration.up(db);

    const legacy = await db('event_sources').where({ id: legacyBefore.id }).first();
    expect(legacy.enabled).toBe(false);
    expect(legacy.feed_url).not.toBe('https://wellenpark.com/events/feed/');
    const live = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/' });
    expect(live).toHaveLength(1);
    expect(live[0].enabled).toBe(true);
  });

  test('guard is a no-op when only the legacy Wellen row exists', async () => {
    await guardMigration.up(db);
    const legacy = await db('event_sources').where({ feed_url: 'https://wellenpark.com/events/feed/' }).first();
    expect(legacy.enabled).toBe(true);
  });
});
