// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins that the migration disables exactly its one feed URL, writes one audit
// row for the source it changed, and leaves look-alikes alone.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20261110100000_disable_ringling_event_source');

const ACTION = 'migration:20261110100000_disable_ringling_event_source:enabled';
const FEED_URL = 'https://www.ringling.org/events/type/all/';

(SKIP ? describe.skip : describe)('disable Ringling event source 20261110 (PostgreSQL)', () => {
  let db;
  const schema = `disable_ringling_event_source_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('event_sources', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.string('feed_url', 512).notNullable().unique();
      t.string('feed_type', 16).notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
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

  beforeEach(async () => {
    await db('audit_log').del();
    await db('event_sources').del();
    await db('event_sources').insert([
      { name: 'Art Museum — All Events', feed_url: FEED_URL, feed_type: 'scrape' },
      // Look-alikes that must stay enabled: the pre-repair URL of the same
      // site, the same URL without its trailing slash, and another venue.
      { name: 'Art Museum — Old Page', feed_url: 'https://www.ringling.org/events', feed_type: 'scrape' },
      { name: 'Art Museum — No Slash', feed_url: 'https://www.ringling.org/events/type/all', feed_type: 'scrape' },
      { name: 'City Calendar', feed_url: 'https://city.example.gov/calendar/rss.xml', feed_type: 'rss' },
    ]);
  });

  // Sorted in JS: CI's database collation can order names differently.
  const enabledNames = async () => (await db('event_sources').where({ enabled: true })).map((r) => r.name).sort();

  test('disables exactly the listed feed and audits it', async () => {
    await migration.up(db);
    expect(await enabledNames()).toEqual(['Art Museum — No Slash', 'Art Museum — Old Page', 'City Calendar']);

    const audits = await db('audit_log');
    const disabled = await db('event_sources').where({ enabled: false });
    expect(audits.map((a) => a.resource_id)).toEqual(disabled.map((r) => r.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: 'system', action: ACTION, resource_type: 'event_sources' });
    expect(audits[0].action.length).toBeLessThanOrEqual(96);
    expect(audits[0].metadata).toMatchObject({
      source: 'Art Museum — All Events', feed_url: FEED_URL, column: 'enabled', before: true, after: false,
    });
  });

  test('is idempotent, skips the source when already off, and never re-enables anything', async () => {
    await db('event_sources').where({ name: 'Art Museum — All Events' }).update({ enabled: false });
    await db('event_sources').where({ name: 'City Calendar' }).update({ enabled: false });
    await migration.up(db);
    await migration.up(db);
    expect(await enabledNames()).toEqual(['Art Museum — No Slash', 'Art Museum — Old Page']);
    expect(await db('audit_log')).toHaveLength(0);
  });

  test('runs twice on an enabled source and audits it once', async () => {
    await migration.up(db);
    await migration.up(db);
    expect(await db('audit_log')).toHaveLength(1);
  });

  test('down is a documented no-op', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await enabledNames()).toEqual(['Art Museum — No Slash', 'Art Museum — Old Page', 'City Calendar']);
  });
});
