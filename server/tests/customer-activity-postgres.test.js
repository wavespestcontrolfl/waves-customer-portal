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
const pushOpenUniqueMigration = require('../models/migrations/20260929200000_customer_page_views_push_open_unique');
const { recordPageView } = require('../services/customer-page-views');
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
      t.timestamp('deleted_at');
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
    await pushOpenUniqueMigration.up(mockPg);
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

  test('concurrent forever push:open inserts for one notification leave exactly one row', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'H' });
    const subjectId = `notification:${randomUUID()}`;
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => recordPageView({
      req: { ...HUMAN_REQ, ip: `198.51.100.${i + 1}` },
      page: 'push:open',
      customerId: c,
      subjectType: 'ios',
      subjectId,
      dedupeForever: true,
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    // losers of the race are swallowed by ON CONFLICT, not surfaced as failed inserts
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await mockPg('customer_page_views').where({ page: 'push:open', customer_id: c, subject_id: subjectId })).toHaveLength(1);
  });

  test('the unique index is scoped to push:open: portal tab views for one subject can still repeat', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'I' });
    const row = { customer_id: c, page: 'portal:home', subject_type: 'customer', subject_id: c };
    await mockPg('customer_page_views').insert([row, row]);
    expect(await mockPg('customer_page_views').where({ page: 'portal:home', customer_id: c })).toHaveLength(2);
    await expect(mockPg('customer_page_views').insert([
      { customer_id: c, page: 'push:open', subject_id: 'notification:dup' },
      { customer_id: c, page: 'push:open', subject_id: 'notification:dup' },
    ])).rejects.toThrow(/customer_page_views_push_open_uniq/);
  });

  test('the unique-index migration removes pre-existing duplicate push:open rows (keeping the earliest) before indexing, and is re-runnable', async () => {
    const c = randomUUID();
    await mockPg('customers').insert({ id: c, first_name: 'J' });
    await pushOpenUniqueMigration.down(mockPg);
    await mockPg('customer_page_views').insert([
      { customer_id: c, page: 'push:open', subject_id: 'notification:x', subject_type: 'late', viewed_at: mockPg.raw("now() - interval '1 hour'") },
      { customer_id: c, page: 'push:open', subject_id: 'notification:x', subject_type: 'early', viewed_at: mockPg.raw("now() - interval '5 hours'") },
      { customer_id: c, page: 'push:open', subject_id: 'notification:y', subject_type: 'only' },
      { customer_id: c, page: 'push:open', subject_id: null, subject_type: 'nosubj1' },
      { customer_id: c, page: 'push:open', subject_id: null, subject_type: 'nosubj2' },
    ]);
    await pushOpenUniqueMigration.up(mockPg);
    await pushOpenUniqueMigration.up(mockPg);
    const rows = await mockPg('customer_page_views').where({ page: 'push:open', customer_id: c }).select('subject_id', 'subject_type');
    expect(rows.filter((r) => r.subject_id === 'notification:x')).toEqual([{ subject_id: 'notification:x', subject_type: 'early' }]);
    expect(rows.filter((r) => r.subject_id === 'notification:y')).toHaveLength(1);
    expect(rows.filter((r) => r.subject_id === null)).toHaveLength(2);
    const idx = await mockPg.raw("SELECT 1 FROM pg_indexes WHERE schemaname = ? AND indexname = 'customer_page_views_push_open_uniq'", [schema]);
    expect(idx.rows).toHaveLength(1);
  });

  test('a soft-deleted (merged-away) customer gets no page view, push open or last_seen stamp', async () => {
    const dead = randomUUID();
    const notif = randomUUID();
    await mockPg('customers').insert({ id: dead, first_name: 'M', deleted_at: mockPg.fn.now() });
    await mockPg('notifications').insert({ id: notif, recipient_type: 'customer', recipient_id: dead });
    expect(await recordPageView({ req: HUMAN_REQ, page: 'portal:plan', customerId: dead, subjectType: 'web' })).toBe(false);
    expect(await recordPushOpen(HUMAN_REQ, { customerId: dead, platform: 'ios', notificationId: notif })).toBe(false);
    stampLastSeen(HUMAN_REQ, dead);
    await settle();
    expect(await mockPg('customer_page_views').where({ customer_id: dead })).toHaveLength(0);
    expect((await mockPg('customers').where({ id: dead }).first()).last_seen_at).toBeNull();
    // a live customer still records
    const live = randomUUID();
    await mockPg('customers').insert({ id: live, first_name: 'L' });
    expect(await recordPageView({ req: HUMAN_REQ, page: 'portal:plan', customerId: live, subjectType: 'web' })).toBe(true);
    // a lead view (null customer) is unaffected by the guard
    expect(await recordPageView({ req: HUMAN_REQ, page: 'track', subjectType: 'scheduled_service', subjectId: 'lead-1' })).toBe(true);
  });

  test('a beacon racing executeMerge (loser locked FOR UPDATE, then soft-deleted and committed) writes nothing', async () => {
    const loser = randomUUID();
    const notif = randomUUID();
    await mockPg('customers').insert({ id: loser, first_name: 'R' });
    await mockPg('notifications').insert({ id: notif, recipient_type: 'customer', recipient_id: loser });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let release;
    const gate = new Promise((r) => { release = r; });
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    // What executeMerge does: lock the row FOR UPDATE, do its sweep, soft-delete, commit.
    const merge = mockPg.transaction(async (trx) => {
      await trx('customers').where({ id: loser }).forUpdate().first();
      locked();
      await gate;
      await trx('customers').where({ id: loser }).update({ deleted_at: trx.fn.now() });
    });
    await lockedP;
    // Beacons start while the merge holds the lock (snapshot still shows the loser live).
    const view = recordPageView({ req: HUMAN_REQ, page: 'portal:plan', customerId: loser, subjectType: 'web' });
    stampLastSeen(HUMAN_REQ, loser);
    await sleep(300);
    release();
    await merge;
    expect(await view).toBe(false);
    await settle();
    expect(await mockPg('customer_page_views').where({ customer_id: loser })).toHaveLength(0);
    expect((await mockPg('customers').where({ id: loser }).first()).last_seen_at).toBeNull();
  });
});
