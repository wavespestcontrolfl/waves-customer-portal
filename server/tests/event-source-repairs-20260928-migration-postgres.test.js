// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins that the migration disables exactly its three feed URLs and nothing
// that merely looks similar.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20260928230000_event_source_repairs_20260928');

(SKIP ? describe.skip : describe)('event-source repairs 20260928 (PostgreSQL)', () => {
  let db;
  const schema = `event_source_repairs_20260928_${randomUUID().replaceAll('-', '')}`;

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
  }, 30000);

  afterAll(async () => {
    await db?.schema.dropSchemaIfExists(schema, true).catch(() => {});
    await db?.destroy();
  });

  beforeEach(async () => {
    await db('event_sources').del();
    await db('event_sources').insert([
      { name: 'Arena One — Events', feed_url: 'https://www.benchmarkintlarena.com/events/?ical=1', feed_type: 'ical' },
      { name: 'Arena Two — Events', feed_url: 'https://www.yuenglingcenter.com/events/?ical=1', feed_type: 'ical' },
      { name: 'City of St. Petersburg — Events', feed_url: 'https://events.stpete.org/', feed_type: 'scrape' },
      // Look-alikes that must stay enabled.
      { name: 'St. Petersburg Museum — Events', feed_url: 'https://museum.example.com/events', feed_type: 'scrape' },
      { name: 'Stpete Parks', feed_url: 'https://parks.stpete.org/calendar', feed_type: 'scrape' },
      { name: 'Theater — Events', feed_url: 'https://theater.example.com/events/?ical=1', feed_type: 'ical' },
    ]);
  });

  // Sorted in JS: CI's database collation orders "St. Petersburg" vs
  // "Stpete" differently from a C-collation local database.
  const enabledNames = async () => (await db('event_sources').where({ enabled: true })).map((r) => r.name).sort();

  test('disables exactly the three listed feeds', async () => {
    await migration.up(db);
    expect(await enabledNames()).toEqual(['St. Petersburg Museum — Events', 'Stpete Parks', 'Theater — Events']);
  });

  test('is idempotent and never re-enables anything', async () => {
    await db('event_sources').where({ name: 'Theater — Events' }).update({ enabled: false });
    await migration.up(db);
    await migration.up(db);
    expect(await enabledNames()).toEqual(['St. Petersburg Museum — Events', 'Stpete Parks']);
  });

  test('down is a documented no-op', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await enabledNames()).toEqual(['St. Petersburg Museum — Events', 'Stpete Parks', 'Theater — Events']);
  });
});
