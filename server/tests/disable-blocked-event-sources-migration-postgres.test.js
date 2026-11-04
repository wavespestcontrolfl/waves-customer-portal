// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins that the migration disables exactly its three feed URLs, writes one
// audit row per source it changed, and leaves look-alikes alone.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20261104050000_disable_blocked_event_sources');

const ACTION = 'migration:20261104050000_disable_blocked_event_sources:enabled';

(SKIP ? describe.skip : describe)('disable blocked event sources 20261104 (PostgreSQL)', () => {
  let db;
  const schema = `disable_blocked_event_sources_${randomUUID().replaceAll('-', '')}`;

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
      { name: 'Chamber One — Events', feed_url: 'https://business.sarasotachamber.com/community-calendar', feed_type: 'scrape' },
      { name: 'Chamber Two — Events', feed_url: 'https://business.venicechamber.com/chamber-events', feed_type: 'scrape' },
      { name: 'Garden — Events', feed_url: 'https://selby.org/events', feed_type: 'scrape' },
      // Look-alikes that must stay enabled.
      { name: 'Chamber Three — Upcoming', feed_url: 'https://business.manateechamber.com/feed/rss/UpcomingEvents.rss', feed_type: 'rss' },
      { name: 'Garden Feed', feed_url: 'https://selby.org/events/?ical=1', feed_type: 'ical' },
      { name: 'Chamber One — Old Page', feed_url: 'https://www.sarasotachamber.com/events', feed_type: 'scrape' },
    ]);
  });

  // Sorted in JS: CI's database collation can order names differently.
  const enabledNames = async () => (await db('event_sources').where({ enabled: true })).map((r) => r.name).sort();

  test('disables exactly the three listed feeds and audits each one', async () => {
    await migration.up(db);
    expect(await enabledNames()).toEqual(['Chamber One — Old Page', 'Chamber Three — Upcoming', 'Garden Feed']);

    const audits = await db('audit_log').orderBy('resource_id');
    const disabled = await db('event_sources').where({ enabled: false }).orderBy('id');
    expect(audits.map((a) => a.resource_id)).toEqual(disabled.map((r) => r.id));
    for (const a of audits) {
      expect(a).toMatchObject({ actor_type: 'system', action: ACTION, resource_type: 'event_sources' });
      expect(a.action.length).toBeLessThanOrEqual(96);
      expect(a.metadata).toMatchObject({ column: 'enabled', before: true, after: false });
    }
  });

  test('is idempotent, skips a source already off, and never re-enables anything', async () => {
    await db('event_sources').where({ name: 'Garden — Events' }).update({ enabled: false });
    await db('event_sources').where({ name: 'Garden Feed' }).update({ enabled: false });
    await migration.up(db);
    await migration.up(db);
    expect(await enabledNames()).toEqual(['Chamber One — Old Page', 'Chamber Three — Upcoming']);
    // Only the two chambers changed, once each.
    expect((await db('audit_log')).map((a) => a.metadata.source).sort()).toEqual(['Chamber One — Events', 'Chamber Two — Events']);
  });

  test('down is a documented no-op', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await enabledNames()).toEqual(['Chamber One — Old Page', 'Chamber Three — Upcoming', 'Garden Feed']);
  });
});
