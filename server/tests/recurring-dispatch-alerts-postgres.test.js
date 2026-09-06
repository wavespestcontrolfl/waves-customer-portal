// CI's existing DB-gated step discovers this suite. Temporary tables copy
// migrated column types, contain synthetic records only, and roll back.
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  return db;
});
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
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
  const inactiveCustomerId = randomUUID();
  const archivedCustomerId = randomUUID();
  const due = '2099-02-01';
  const now = new Date('2099-01-20T16:00:00Z');
  const cases = ['unplaced', 'placed', 'cancelled', 'old_due', 'missing', 'inactive', 'archived', 'customer_notice', 'other_lane'];
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
        SELECT * FROM public.scheduled_services WITH NO DATA;
      CREATE TEMP TABLE customers AS
        SELECT * FROM public.customers WITH NO DATA;
      CREATE TEMP TABLE notifications AS
        SELECT recipient_type, category, title, body, metadata, read_at
        FROM public.notifications WITH NO DATA;
    `);
    await trx('customers').insert([
      { id: customerId, active: true },
      { id: inactiveCustomerId, active: false },
      { id: archivedCustomerId, active: true, deleted_at: now },
    ]);
    await trx('scheduled_services').insert(cases.filter((name) => name !== 'missing').map((name) => ({
      id: ids[name], customer_id: name === 'inactive' ? inactiveCustomerId : name === 'archived' ? archivedCustomerId : customerId,
      status: name === 'cancelled' ? 'cancelled' : 'pending',
      window_start: ['unplaced', 'old_due', 'inactive', 'archived'].includes(name) ? null : '09:00',
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
    for (const name of ['placed', 'cancelled', 'old_due', 'missing', 'inactive', 'archived']) {
      expect(byService[ids[name]].read_at).toEqual(now);
      expect(byService[ids[name]].title).toBe('Recurring placement alert resolved');
    }
    for (const name of ['unplaced', 'customer_notice', 'other_lane']) {
      expect(byService[ids[name]].read_at).toBeNull();
    }

    // Staff can acknowledge the pending card before placement. Its content
    // must still retire, or a recurrence will look unchanged to the deduper.
    await trx('notifications').whereRaw("metadata->>'scheduledServiceId' = ?", [ids.unplaced])
      .update({ read_at: new Date('2099-01-19T16:00:00Z') });
    await trx('scheduled_services').where({ id: ids.unplaced }).update({ window_start: '09:00' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const closed = await trx('notifications')
      .whereRaw("metadata->>'scheduledServiceId' = ?", [ids.unplaced]).first();
    expect(closed.read_at).toEqual(now);
    expect(closed.title).toBe('Recurring placement alert resolved');

    await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2099-01-21T16:00:00Z'));
    const stillClosed = await trx('notifications')
      .whereRaw("metadata->>'scheduledServiceId' = ?", [ids.unplaced]).first();
    expect(stillClosed.read_at).toEqual(now); // no daily rewrite of resolved history

    await trx('scheduled_services').where({ id: ids.unplaced }).update({ window_start: null });
    notifications.notifyAdmin.mockClear();
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin).toHaveBeenCalledWith(
      'schedule_conflict', 'Recurring visit still needs a time', expect.any(String),
      expect.objectContaining({ dedupeKey: `recurring-dispatch:${ids.unplaced}:${due}`, refreshOnDedupe: true }),
    );
  });

  test('loads an unplaced visit before the 5000-row cap despite earlier ordinary visits', async () => {
    await trx('scheduled_services').where({ id: ids.unplaced }).update({
      is_recurring: true, recurring_parent_id: randomUUID(), scheduled_date: '2099-02-02',
    });
    await trx.raw(`INSERT INTO scheduled_services
      (id, customer_id, is_recurring, recurring_parent_id, status, scheduled_date, window_start)
      SELECT gen_random_uuid(), ?::uuid, true, ?::uuid, 'pending', DATE '2099-02-01', TIME '09:00'
      FROM generate_series(1, 5000)`, [customerId, randomUUID()]);
    const { loadEligibleServices } = require('../services/auto-dispatch');
    const rows = await loadEligibleServices('2099-01-20', '2099-03-01', '2099-01-20');
    expect(rows).toHaveLength(5000);
    expect(rows[0].id).toBe(ids.unplaced);
  });

  test.each([true, false])('reschedule holds block same-plan dates for due placement=%s', async (duePlacement) => {
    const parentId = randomUUID();
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, recurring_parent_id: parentId,
      status: 'rescheduled', scheduled_date: due, window_start: '09:00',
    });
    const { findAvailableSlots } = require('../services/scheduling/find-time');
    findAvailableSlots.mockResolvedValue({ slots: [due, '2099-02-02'].map((date) => ({
      date, technician: { id: 'synthetic-tech' }, start_time: '15:00', end_time: '16:00',
      detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1,
    })) });
    const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');
    const result = await findValidCandidateSlots({
      id: randomUUID(), recurring_parent_id: parentId, scheduled_date: due,
      recurring_dispatch_due_date: duePlacement ? due : null,
      window_start: null, technician_id: null, lat: 27.4, lng: -82.5,
    }, { service_category: 'general' }, {
      db: trx, nowDate: now, lockWindowDays: 0, lookaheadDays: 90,
      capabilityFor: () => 'qualified',
    });
    expect(result.candidates.map((slot) => slot.date)).toEqual(duePlacement ? ['2099-02-02'] : [due, '2099-02-02']);
    expect(result.drops.sibling).toBe(duePlacement ? 1 : 0);
  });

  test('seeds separate truthful SMS copy and preserves administrator edits on rerun', async () => {
    const migration = require('../models/migrations/20260906000040_recurring_dispatch_sms');
    const row = await trx('sms_templates').where({ template_key: migration.TEMPLATE.template_key }).first();
    expect(row.body).toBe(migration.TEMPLATE.body);
    expect(row.variables).toEqual(['first_name', 'start_date', 'window_text']);
    await trx('sms_templates').where({ id: row.id }).update({ body: 'Administrator test edit' });
    await migration.up(trx);
    expect((await trx('sms_templates').where({ id: row.id }).first()).body).toBe('Administrator test edit');
  });
});
