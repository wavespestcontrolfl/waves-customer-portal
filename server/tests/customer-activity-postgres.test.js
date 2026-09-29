// Runs with the existing CI PostgreSQL pass; never a production connection.
// Pins the real throttle: the last_seen_at UPDATE only moves rows that are
// NULL or older than the throttle window, and the migration is re-runnable.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

let mockPg;
jest.mock('../models/db', () => ({ raw: (...a) => mockPg.raw(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const migration = require('../models/migrations/20260929130000_customers_last_seen_at');
const pageViewsMigration = require('../models/migrations/20260929120000_customer_page_views');
const { stampLastSeen, recordPushOpen, LAST_SEEN_THROTTLE_MINUTES } = require('../services/customer-activity');

const HUMAN_REQ = { ip: '203.0.113.9', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' }, get: () => 'Mozilla/5.0 (iPhone) Safari/604.1' };
const settle = () => new Promise((r) => setTimeout(r, 200));

(SKIP ? describe.skip : describe)('customers.last_seen_at PostgreSQL contracts', () => {
  const schema = `last_seen_${randomUUID().replaceAll('-', '')}`;
  const savedGate = process.env.GATE_PORTAL_ACTIVITY;
  let admin;
  const ids = { never: randomUUID(), recent: randomUUID(), stale: randomUUID() };

  beforeAll(async () => {
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    mockPg = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await mockPg.schema.createTable('customers', (t) => {
      t.uuid('id').primary();
      t.string('first_name');
    });
    await mockPg.schema.createTable('notifications', (t) => {
      t.uuid('id').primary();
      t.string('recipient_type', 20).notNullable();
      t.uuid('recipient_id').nullable();
      t.string('category', 30).notNullable().defaultTo('billing');
      t.string('title', 200).notNullable().defaultTo('t');
    });
    await migration.up(mockPg);
    await pageViewsMigration.up(mockPg);
    process.env.GATE_PORTAL_ACTIVITY = 'true';
  });

  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_PORTAL_ACTIVITY; else process.env.GATE_PORTAL_ACTIVITY = savedGate;
    if (mockPg) await mockPg.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  test('the migration adds a nullable timestamptz column, is re-runnable, and rolls back', async () => {
    await migration.up(mockPg);
    const col = await mockPg.raw(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = 'customers' AND column_name = 'last_seen_at'",
      [schema],
    );
    expect(col.rows[0]).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null });
    await migration.down(mockPg);
    expect(await mockPg.schema.hasColumn('customers', 'last_seen_at')).toBe(false);
    await migration.up(mockPg);
    expect(await mockPg.schema.hasColumn('customers', 'last_seen_at')).toBe(true);
  });

  test('stamps a never-seen or stale customer, leaves a recently-seen one untouched', async () => {
    const recent = new Date(Date.now() - (LAST_SEEN_THROTTLE_MINUTES - 2) * 60 * 1000);
    const stale = new Date(Date.now() - (LAST_SEEN_THROTTLE_MINUTES + 2) * 60 * 1000);
    await mockPg('customers').insert([
      { id: ids.never, first_name: 'A' },
      { id: ids.recent, first_name: 'B', last_seen_at: recent },
      { id: ids.stale, first_name: 'C', last_seen_at: stale },
    ]);
    for (const id of Object.values(ids)) stampLastSeen(HUMAN_REQ, id);
    await settle();
    const rows = Object.fromEntries((await mockPg('customers').select('id', 'last_seen_at')).map((r) => [r.id, r.last_seen_at]));
    expect(Date.now() - new Date(rows[ids.never]).getTime()).toBeLessThan(10000);
    expect(Date.now() - new Date(rows[ids.stale]).getTime()).toBeLessThan(10000);
    expect(new Date(rows[ids.recent]).getTime()).toBe(recent.getTime());

    // A second stamp inside the window is a no-op.
    const firstStamp = new Date(rows[ids.never]).getTime();
    stampLastSeen(HUMAN_REQ, ids.never);
    await settle();
    const again = await mockPg('customers').where({ id: ids.never }).first('last_seen_at');
    expect(new Date(again.last_seen_at).getTime()).toBe(firstStamp);
  });

  const notify = async (recipientId, recipientType = 'customer') => {
    const id = randomUUID();
    await mockPg('notifications').insert({ id, recipient_type: recipientType, recipient_id: recipientId });
    return id;
  };

  test('push-open: an owned notification records once and dedupes forever, from any IP or time', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'D' });
    const n = await notify(c);
    const otherIpReq = { ...HUMAN_REQ, ip: '198.51.100.77' };
    const open = (req) => recordPushOpen(req, { customerId: c, platform: 'ios', notificationId: n });
    expect(await open(HUMAN_REQ)).toBe(true);
    await mockPg('customer_page_views').where({ customer_id: c }).update({ viewed_at: mockPg.raw("now() - interval '3 hours'") });
    expect(await open(otherIpReq)).toBe(false);
    expect(await open(HUMAN_REQ)).toBe(false);
    const rows = await mockPg('customer_page_views').where({ page: 'push:open', customer_id: c }).select('subject_id', 'subject_type');
    expect(rows).toEqual([{ subject_id: `notification:${n}`, subject_type: 'ios' }]);
    // a second, different notification of the same customer still counts
    expect(await open({ ...HUMAN_REQ, ip: '198.51.100.99' })).toBe(false);
    expect(await recordPushOpen(HUMAN_REQ, { customerId: c, platform: 'ios', notificationId: await notify(c) })).toBe(true);
  });

  test('push-open: a notification owned by another customer (or an admin) records nothing and stamps nothing', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await mockPg('customers').insert([{ id: a, first_name: 'E' }, { id: b, first_name: 'F' }]);
    const ofB = await notify(b);
    const ofAdmin = await notify(null, 'admin');
    expect(await recordPushOpen(HUMAN_REQ, { customerId: a, platform: 'ios', notificationId: ofB })).toBe(false);
    expect(await recordPushOpen(HUMAN_REQ, { customerId: a, platform: 'ios', notificationId: ofAdmin })).toBe(false);
    expect(await recordPushOpen(HUMAN_REQ, { customerId: a, platform: 'ios', notificationId: randomUUID() })).toBe(false);
    await settle();
    expect(await mockPg('customer_page_views').where({ page: 'push:open', customer_id: a })).toHaveLength(0);
    expect((await mockPg('customers').where({ id: a }).first('last_seen_at')).last_seen_at).toBeNull();
    // the real owner is counted and stamped
    expect(await recordPushOpen(HUMAN_REQ, { customerId: b, platform: 'ios', notificationId: ofB })).toBe(true);
    await settle();
    expect((await mockPg('customers').where({ id: b }).first('last_seen_at')).last_seen_at).not.toBeNull();
  });

  test('push-open: no notification id records nothing and stamps nothing', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'G' });
    expect(await recordPushOpen(HUMAN_REQ, { customerId: c, platform: 'ios' })).toBe(false);
    expect(await recordPushOpen(HUMAN_REQ, { customerId: c, platform: 'ios', notificationId: 'push-routed:receipt' })).toBe(false);
    await settle();
    expect(await mockPg('customer_page_views').where({ page: 'push:open', customer_id: c })).toHaveLength(0);
    expect((await mockPg('customers').where({ id: c }).first('last_seen_at')).last_seen_at).toBeNull();
  });
});
