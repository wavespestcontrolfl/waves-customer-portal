// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins what the 20261126 migration changes on each of the ten local feeds:
// two are turned on (with an audit row each), two are repaired but stay off,
// the unfixable ones are untouched, and down() restores the replaced values.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20261126120000_restore_local_event_feeds');

const ACTION = 'migration:20261126120000_restore_local_event_feeds:enabled';
const CVB = 'https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100';
const SELBY = 'https://selby.org/events';
const NORTH_PORT = 'https://www.northportfl.gov/Community-Recreation/Events';
const SARASOTA_OLD = 'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events';
const SARASOTA_NEW = 'https://www.sarasotafl.gov/Events-directory';
const SEEDED = { contentSelector: null, waitForSelector: null, maxEvents: 15 };
// Feeds that cannot be fixed: the migration must not touch them.
const UNFIXABLE = [
  ['City of Bradenton — Events', 'https://www.bradentonfl.gov/events'],
  ['City of Venice — Events', 'https://www.venicegov.com/things-to-do/events'],
  ['Visit Sarasota County — Events', 'https://www.visitsarasota.com/events-festivals'],
  ['Sarasota Chamber — Events', 'https://business.sarasotachamber.com/community-calendar'],
  ['Venice Area Chamber — Events', 'https://business.venicechamber.com/chamber-events'],
  ['Ringling Museum', 'https://www.ringling.org/events/type/all/'],
];

(SKIP ? describe.skip : describe)('restore local event feeds 20261126 (PostgreSQL)', () => {
  let db;
  const schema = `restore_local_event_feeds_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('event_sources', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.string('url', 512);
      t.string('feed_url', 512).notNullable().unique();
      t.string('feed_type', 16).notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.jsonb('scrape_config');
      t.integer('consecutive_failures').notNullable().defaultTo(0);
      t.integer('consecutive_zero_yields').notNullable().defaultTo(0);
      t.text('last_error');
      t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
    });
    await db.schema.createTable('audit_log', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('actor_type', 32).notNullable();
      t.uuid('actor_id');
      t.string('action', 96).notNullable();
      t.string('resource_type', 64);
      t.string('resource_id', 128);
      t.jsonb('metadata');
      t.string('ip_address', 64);
      t.text('user_agent');
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
    });
  }, 30000);

  afterAll(async () => {
    await db?.schema.dropSchemaIfExists(schema, true).catch(() => {});
    await db?.destroy();
    // audit-log loads the shared pool; close it so the CI Jest process exits.
    await require('../models/db').destroy();
  });

  const bySource = (feedUrl) => db('event_sources').where({ feed_url: feedUrl }).first();

  beforeEach(async () => {
    await db.schema.dropTableIfExists('event_source_restore_20261126');
    await db('audit_log').del();
    await db('event_sources').del();
    const off = { enabled: false, consecutive_failures: 7, consecutive_zero_yields: 3, last_error: 'HTTP 403' };
    await db('event_sources').insert([
      { name: 'Bradenton Area CVB — Events', url: CVB, feed_url: CVB, feed_type: 'scrape', scrape_config: JSON.stringify(SEEDED), ...off },
      {
        name: 'Marie Selby Botanical Gardens', url: SELBY, feed_url: SELBY, feed_type: 'scrape', ...off,
        scrape_config: JSON.stringify({ contentSelector: '.mec-skin-list-events-container', maxHtmlChars: 60000, maxEvents: 10 }),
      },
      { name: 'City of North Port — Events', url: NORTH_PORT, feed_url: NORTH_PORT, feed_type: 'scrape', scrape_config: JSON.stringify(SEEDED), ...off },
      { name: 'City of Sarasota — Events', url: SARASOTA_OLD, feed_url: SARASOTA_OLD, feed_type: 'scrape', scrape_config: JSON.stringify(SEEDED), ...off },
      ...UNFIXABLE.map(([name, feedUrl]) => ({ name, url: feedUrl, feed_url: feedUrl, feed_type: 'scrape', scrape_config: JSON.stringify(SEEDED), ...off })),
    ]);
  });

  test('turns on exactly the two proven feeds, resets their health, and audits each', async () => {
    await migration.up(db);

    const cvb = await bySource(CVB);
    expect(cvb).toMatchObject({ enabled: true, feed_type: 'json', consecutive_failures: 0, consecutive_zero_yields: 0, last_error: null });
    expect(cvb.scrape_config).toEqual({ ...SEEDED, jsonAdapter: 'eventastic' });

    const selby = await bySource(SELBY);
    expect(selby).toMatchObject({ enabled: true, feed_type: 'scrape', consecutive_failures: 0, last_error: null });
    expect(selby.scrape_config).toEqual({
      contentSelector: '.mec-skin-list-events-container',
      maxHtmlChars: 60000,
      maxEvents: 10,
      userAgent: 'WavesNewsletterBot/1.0 (+https://portal.wavespestcontrol.com)',
    });

    const enabled = (await db('event_sources').where({ enabled: true })).map((r) => r.name).sort();
    expect(enabled).toEqual(['Bradenton Area CVB — Events', 'Marie Selby Botanical Gardens']);

    const audits = await db('audit_log');
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.resource_id).sort()).toEqual([cvb.id, selby.id].sort());
    expect(audits[0]).toMatchObject({ actor_type: 'system', action: ACTION, resource_type: 'event_sources' });
    expect(audits[0].action.length).toBeLessThanOrEqual(96);
    expect(audits[0].metadata).toMatchObject({ column: 'enabled', before: false, after: true });
  });

  test('repairs North Port and City of Sarasota but leaves them off', async () => {
    await migration.up(db);

    const northPort = await bySource(NORTH_PORT);
    expect(northPort.enabled).toBe(false);
    expect(northPort.scrape_config).toEqual({ ...SEEDED, contentSelector: '.events-list-container', maxHtmlChars: 30000 });

    expect(await bySource(SARASOTA_OLD)).toBeUndefined();
    const sarasota = await bySource(SARASOTA_NEW);
    expect(sarasota).toMatchObject({ enabled: false, url: SARASOTA_NEW, consecutive_failures: 7 });
    expect(sarasota.scrape_config).toEqual({ ...SEEDED, contentSelector: '.events-list-container', maxHtmlChars: 30000 });
  });

  test('leaves the unfixable feeds exactly as they were', async () => {
    const before = await db('event_sources').whereIn('feed_url', UNFIXABLE.map(([, u]) => u)).orderBy('feed_url');
    await migration.up(db);
    const after = await db('event_sources').whereIn('feed_url', UNFIXABLE.map(([, u]) => u)).orderBy('feed_url');
    expect(after).toEqual(before);
  });

  test('a second run audits only a feed that was off again', async () => {
    await migration.up(db);
    await db('event_sources').where({ feed_url: SELBY }).update({ enabled: false });
    await db('audit_log').del();
    await migration.up(db);
    // Only Selby is off again, so only its enable is audited.
    expect(await db('audit_log')).toHaveLength(1);
    expect((await bySource(CVB)).enabled).toBe(true);
  });

  test('does not touch a row that already owns the new Sarasota URL, nor rename the old row onto it', async () => {
    await db('event_sources').insert({
      name: 'Sarasota dup', url: SARASOTA_NEW, feed_url: SARASOTA_NEW, feed_type: 'scrape',
      scrape_config: JSON.stringify({ contentSelector: '#custom' }), enabled: true,
    });
    const ownerBefore = await bySource(SARASOTA_NEW);
    const oldBefore = await bySource(SARASOTA_OLD);
    await migration.up(db);
    expect(await bySource(SARASOTA_NEW)).toEqual(ownerBefore);
    expect(await bySource(SARASOTA_OLD)).toEqual(oldBefore);
    // down() has nothing recorded for Sarasota and leaves both rows alone.
    await migration.down(db);
    expect(await bySource(SARASOTA_NEW)).toEqual(ownerBefore);
    expect(await bySource(SARASOTA_OLD)).toEqual(oldBefore);
  });

  test('down() restores the replaced values and turns the two feeds back off', async () => {
    await migration.up(db);
    await migration.down(db);

    const cvb = await bySource(CVB);
    expect(cvb).toMatchObject({ enabled: false, feed_type: 'scrape', consecutive_failures: 7, consecutive_zero_yields: 3, last_error: 'HTTP 403' });
    expect(cvb.scrape_config).toEqual(SEEDED);
    const selby = await bySource(SELBY);
    expect(selby).toMatchObject({ enabled: false, consecutive_failures: 7, last_error: 'HTTP 403' });
    expect(selby.scrape_config).toEqual({ contentSelector: '.mec-skin-list-events-container', maxHtmlChars: 60000, maxEvents: 10 });
    expect((await bySource(NORTH_PORT)).scrape_config).toEqual({ ...SEEDED });
    expect(await bySource(SARASOTA_NEW)).toBeUndefined();
    expect(await bySource(SARASOTA_OLD)).toMatchObject({ url: SARASOTA_OLD, enabled: false });
    expect((await bySource(SARASOTA_OLD)).scrape_config).toEqual(SEEDED);
    expect(await db.schema.hasTable('event_source_restore_20261126')).toBe(false);
  });

  test('down() never turns off a feed that was already on before up(), and keeps later operator edits', async () => {
    // Selby was already on (an operator had fixed it) and had its own UA.
    await db('event_sources').where({ feed_url: SELBY }).update({
      enabled: true, consecutive_failures: 0, last_error: null,
      scrape_config: JSON.stringify({ contentSelector: '.mec-skin-list-events-container', userAgent: 'OperatorBot/2' }),
    });
    await migration.up(db);
    expect(await db('audit_log').where({ resource_id: (await bySource(SELBY)).id })).toHaveLength(0);
    // An operator also edits unrelated config on CVB after up().
    await db('event_sources').where({ feed_url: CVB }).update({
      scrape_config: db.raw(`scrape_config || '{"maxEvents": 40}'::jsonb`),
    });
    await migration.down(db);

    const selby = await bySource(SELBY);
    expect(selby.enabled).toBe(true);
    expect(selby.scrape_config).toEqual({ contentSelector: '.mec-skin-list-events-container', userAgent: 'OperatorBot/2' });
    const cvb = await bySource(CVB);
    expect(cvb).toMatchObject({ enabled: false, feed_type: 'scrape' });
    expect(cvb.scrape_config).toEqual({ ...SEEDED, maxEvents: 40 });
  });

  test('a rerun keeps the first recorded values, so down() returns to the pre-migration state', async () => {
    await migration.up(db);
    await migration.up(db);
    await migration.down(db);
    expect((await bySource(CVB)).feed_type).toBe('scrape');
    expect((await bySource(CVB)).enabled).toBe(false);
    expect((await bySource(SELBY)).scrape_config.userAgent).toBeUndefined();
  });
});
