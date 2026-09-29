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

  test('push-open dedupe is per customer: two customers on one IP both count, one customer twice counts once', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await mockPg('customers').insert([{ id: a, first_name: 'D' }, { id: b, first_name: 'E' }]);
    const open = (customerId) => recordPushOpen(HUMAN_REQ, {
      customerId, platform: 'ios', tag: 'push-routed:appointment_reminder',
    });
    expect(await open(a)).toBe(true);
    expect(await open(b)).toBe(true);
    expect(await open(a)).toBe(false);
    const rows = await mockPg('customer_page_views').where({ page: 'push:open' }).select('customer_id', 'subject_type', 'subject_id');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.customer_id).sort()).toEqual([a, b].sort());
    expect(rows[0]).toMatchObject({ subject_type: 'ios', subject_id: 'type:appointment_reminder' });
  });

  test('routed pushes: a retried tap dedupes, two separate taps of the same type both count', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'F' });
    const tap = (tapId) => recordPushOpen(HUMAN_REQ, {
      customerId: c, platform: 'ios', tag: 'push-routed:appointment_reminder', tapId,
    });
    const [t1, t2] = [randomUUID(), randomUUID()];
    expect(await tap(t1)).toBe(true);
    expect(await tap(t1)).toBe(false);
    expect(await tap(t2)).toBe(true);
    const rows = await mockPg('customer_page_views').where({ page: 'push:open', customer_id: c }).select('subject_id');
    expect(rows.map((r) => r.subject_id).sort()).toEqual([`tap:${t1}`, `tap:${t2}`].sort());
  });
});
