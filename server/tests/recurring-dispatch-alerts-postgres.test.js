// CI's existing DB-gated step discovers this suite. Temporary tables copy
// migrated column types, contain synthetic records only, and roll back.
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  return db;
});
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describeWithDatabase('recurring placement alert retirement on PostgreSQL', () => {
  const { randomUUID } = require('crypto');
  const db = require('../models/db');
  const notifications = require('../services/notification-service');
  const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');
  let database;
  let trx;
  const customerId = randomUUID();
  const due = '2099-02-01';
  const now = new Date('2099-01-20T16:00:00Z');
  const cases = ['unplaced', 'placed', 'cancelled', 'old_due', 'missing', 'customer_notice', 'other_lane'];
  const ids = Object.fromEntries(cases.map((name) => [name, randomUUID()]));

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    if (!['localhost', '127.0.0.1'].includes(new URL(connection).hostname)) {
      throw new Error('This suite requires the disposable local CI database');
    }
    database = require('knex')({ client: 'pg', connection });
    trx = await database.transaction();
    db.connection = trx;
    await trx.raw(`
      CREATE TEMP TABLE scheduled_services AS
        SELECT id, customer_id, status, window_start, recurring_dispatch_due_date
        FROM public.scheduled_services WITH NO DATA;
      CREATE TEMP TABLE customers AS
        SELECT id, active, deleted_at FROM public.customers WITH NO DATA;
      CREATE TEMP TABLE notifications AS
        SELECT recipient_type, category, title, body, metadata, read_at
        FROM public.notifications WITH NO DATA;
    `);
    await trx('customers').insert({ id: customerId, active: true });
    await trx('scheduled_services').insert(cases.filter((name) => name !== 'missing').map((name) => ({
      id: ids[name], customer_id: customerId,
      status: name === 'cancelled' ? 'cancelled' : 'pending',
      window_start: ['unplaced', 'old_due'].includes(name) ? null : '09:00',
      recurring_dispatch_due_date: name === 'old_due' ? '2099-02-02' : due,
    })));
    await trx('notifications').insert(cases.map((name) => ({
      recipient_type: name === 'customer_notice' ? 'customer' : 'admin',
      category: 'schedule_conflict', title: 'Recurring visit still needs a time', body: 'Awaiting placement',
      metadata: {
        scheduledServiceId: ids[name], dueDate: due,
        dedupeKey: `${name === 'other_lane' ? 'other-lane' : 'recurring-dispatch'}:${ids[name]}:${due}`,
      },
    })));
    notifications.notifyAdmin.mockResolvedValue({ id: 'existing-admin-alert' });
  });
  afterAll(async () => {
    await trx?.rollback();
    await database?.destroy();
  });

  test('retires only obsolete admin placement alerts and can reopen the same due date later', async () => {
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const rows = await trx('notifications').select('*');
    const byService = Object.fromEntries(rows.map((row) => [row.metadata.scheduledServiceId, row]));
    for (const name of ['placed', 'cancelled', 'old_due', 'missing']) {
      expect(byService[ids[name]].read_at).toEqual(now);
      expect(byService[ids[name]].title).toBe('Recurring placement alert resolved');
    }
    for (const name of ['unplaced', 'customer_notice', 'other_lane']) {
      expect(byService[ids[name]].read_at).toBeNull();
    }

    // A later successful placement retires an earlier pending card too.
    await trx('scheduled_services').where({ id: ids.unplaced }).update({ window_start: '09:00' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const closed = await trx('notifications')
      .whereRaw("metadata->>'scheduledServiceId' = ?", [ids.unplaced]).first();
    expect(closed.read_at).toEqual(now);
    expect(closed.title).toBe('Recurring placement alert resolved');

    await trx('scheduled_services').where({ id: ids.unplaced }).update({ window_start: null });
    notifications.notifyAdmin.mockClear();
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin).toHaveBeenCalledWith(
      'schedule_conflict', 'Recurring visit still needs a time', expect.any(String),
      expect.objectContaining({ dedupeKey: `recurring-dispatch:${ids.unplaced}:${due}`, refreshOnDedupe: true }),
    );
  });
});
