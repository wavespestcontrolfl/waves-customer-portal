// Runs with the existing CI PostgreSQL pass; never a production connection.
// The pull order is a raw date_trunc/AT TIME ZONE expression, which a knex
// mock can't exercise honestly.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

jest.mock('../models/db', () => ({}));
const { enabledSourcesInPullOrder } = require('../services/event-ingestion');

(SKIP ? describe.skip : describe)('event-ingestion pull order (PostgreSQL)', () => {
  let db;
  const schema = `event_ingestion_pull_order_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('event_sources', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name', 128).notNullable();
      t.smallint('priority_tier').notNullable().defaultTo(3);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.timestamp('last_pulled_at').nullable();
    });
  }, 30000);

  afterAll(async () => {
    await db?.schema.dropSchemaIfExists(schema, true).catch(() => {});
    await db?.destroy();
  });

  beforeEach(async () => {
    await db('event_sources').del();
  });

  test('sources the last run never reached go first, then tier/name', async () => {
    // Yesterday's run (4 AM ET = 08:00Z) reached the first two, then the
    // process was restarted before the tail.
    await db('event_sources').insert([
      { name: 'Alpha Hall', priority_tier: 1, last_pulled_at: '2026-09-28T08:01:00Z' },
      { name: 'Beta Arena', priority_tier: 2, last_pulled_at: '2026-09-28T08:02:00Z' },
      { name: 'Gamma Gardens', priority_tier: 2, last_pulled_at: '2026-09-27T08:04:00Z' },
      { name: 'Delta Museum', priority_tier: 3, last_pulled_at: '2026-09-27T08:04:30Z' },
      { name: 'Epsilon Theater', priority_tier: 2, last_pulled_at: null },
      { name: 'Zeta Disabled', priority_tier: 1, enabled: false, last_pulled_at: null },
    ]);

    const names = (await enabledSourcesInPullOrder(db)).map((r) => r.name);
    expect(names).toEqual(['Epsilon Theater', 'Gamma Gardens', 'Delta Museum', 'Alpha Hall', 'Beta Arena']);
  });

  test('a normal day keeps tier/name order (all pulled the same ET day)', async () => {
    await db('event_sources').insert([
      { name: 'Omega Chamber', priority_tier: 3, last_pulled_at: '2026-09-28T08:00:05Z' },
      { name: 'Kappa Arena', priority_tier: 1, last_pulled_at: '2026-09-28T08:09:00Z' },
      { name: 'Iota Hall', priority_tier: 1, last_pulled_at: '2026-09-28T08:00:01Z' },
      // 01:30Z is still 09-27 in ET — a late-evening manual pull. It sorts
      // with the older ET day, which is the safe direction.
      { name: 'Lambda Park', priority_tier: 2, last_pulled_at: '2026-09-28T01:30:00Z' },
    ]);

    const names = (await enabledSourcesInPullOrder(db)).map((r) => r.name);
    expect(names).toEqual(['Lambda Park', 'Iota Hall', 'Kappa Arena', 'Omega Chamber']);
  });
});
