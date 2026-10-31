// Runs with the existing CI PostgreSQL pass; never a production connection.
// Google profile sync against real Postgres: a repeated or concurrent sync of
// an unchanged difference leaves ONE pending decision (the route used to insert
// a new pending row on every sync). Google is never called: the profile read is
// mocked. A private schema keeps CI's migrated tables untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `gbp_sync_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 6 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.adminUser = { email: 'owner@example.invalid' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
const mockGetLocationDetails = jest.fn();
jest.mock('../services/google-business', () => ({
  getLocationDetails: (...args) => mockGetLocationDetails(...args),
  _getHeaders: async () => ({}),
}));

// A Business Profile read whose title differs from the stored snapshot.
const googleProfile = (title) => ({
  title,
  phoneNumbers: { primaryPhone: '(941) 555-0100' },
  websiteUri: 'https://example.invalid',
});

(SKIP ? describe.skip : describe)('Google profile sync queues an unchanged difference once (live Postgres)', () => {
  let db;
  let server;
  let base;

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    // The columns of migration 20260401000056_gbp_management.
    await db.schema.withSchema(mockSchema).createTable('gbp_locations', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('location_id', 30).unique().notNullable();
      t.string('business_name', 200);
      t.text('description');
      t.text('address');
      t.string('phone', 30);
      t.jsonb('additional_phones').defaultTo('[]');
      t.string('website_url', 500);
      t.string('primary_category', 200);
      t.jsonb('additional_categories').defaultTo('[]');
      t.jsonb('regular_hours');
      t.jsonb('special_hours').defaultTo('[]');
      t.jsonb('services').defaultTo('[]');
      t.jsonb('attributes').defaultTo('{}');
      t.string('store_code', 50);
      t.date('opening_date');
      t.jsonb('service_areas').defaultTo('[]');
      t.boolean('hide_address').defaultTo(false);
      t.string('logo_url', 500);
      t.string('cover_photo_url', 500);
      t.jsonb('photos').defaultTo('[]');
      t.timestamp('last_synced_at');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
    await db.schema.withSchema(mockSchema).createTable('gbp_updates', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('location_id', 30).notNullable();
      t.string('field_name', 100).notNullable();
      t.text('old_value');
      t.text('new_value');
      t.string('source', 30).notNullable();
      t.string('status', 20).defaultTo('pending');
      t.string('reviewed_by', 100);
      t.timestamp('reviewed_at');
      t.timestamp('detected_at').defaultTo(db.fn.now());
      t.timestamp('created_at').defaultTo(db.fn.now());
    });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/admin/gbp', require('../routes/admin-gbp'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    await db('gbp_updates').del();
    await db('gbp_locations').del();
    await db('gbp_locations').insert({
      location_id: 'bradenton',
      business_name: 'Fixture Pest Control',
      phone: '(941) 555-0100',
      website_url: 'https://example.invalid',
      last_synced_at: new Date('2026-05-29T23:36:38Z'),
    });
    mockGetLocationDetails.mockReset();
    mockGetLocationDetails.mockResolvedValue(googleProfile('Fixture Pest Control of Lakewood Ranch'));
  });

  const sync = async () => {
    const res = await fetch(`${base}/admin/gbp/locations/bradenton/sync`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  };
  const pendingTitles = () => db('gbp_updates').where({ location_id: 'bradenton', field_name: 'business_name', status: 'pending' });

  test('a second sync of the same difference queues nothing new', async () => {
    const first = await sync();
    expect(first.status).toBe(200);
    expect(first.body.updates.map((u) => u.field_name)).toContain('business_name');
    const pendingAfterFirst = await db('gbp_updates').where({ status: 'pending' }).count('* as n').first();

    const second = await sync();
    expect(second.status).toBe(200);
    expect(second.body.changesDetected).toBe(first.body.changesDetected);
    expect(second.body.updates).toEqual([]);
    expect(await db('gbp_updates').where({ status: 'pending' }).count('* as n').first()).toEqual(pendingAfterFirst);
    expect(await pendingTitles()).toHaveLength(1);
  });

  test('syncs that run at the same moment queue the difference once', async () => {
    const results = await Promise.all([sync(), sync(), sync()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await pendingTitles()).toHaveLength(1);
  });

  test('a difference already decided is queued again by the next sync', async () => {
    await sync();
    await db('gbp_updates').where({ field_name: 'business_name' }).update({ status: 'approved' });
    await sync();
    expect(await pendingTitles()).toHaveLength(1);
  });
});
