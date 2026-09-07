// Real concurrent connections, synthetic rows, and no provider calls. CI
// discovers this suite in its existing DB-gated step; a managed worktree may
// also run it against its own empty Railway QA database.
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/appointment-email', () => ({}));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: () => false }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => false }));

function barrier() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describeWithDatabase('recurring dispatch delivery and alert concurrency', () => {
  const { randomUUID } = require('crypto');
  const db = require('../models/db');
  const reminders = require('../services/appointment-reminders');
  const notifications = require('../services/notification-service');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  const { loadReminderFreeze, REMINDER_SENDABLE_HOURS } = require('../services/auto-dispatch/route-tiers');
  const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');
  const schema = `recurring_races_${randomUUID().replaceAll('-', '')}`;
  const customerId = randomUUID();
  const serviceId = randomUUID();
  const reminderId = randomUUID();
  const now = new Date('2099-02-01T14:00:00Z');
  const due = '2099-02-04';
  const appointmentTime = new Date(now.getTime() + REMINDER_SENDABLE_HOURS * 3600000 + 1);
  let database;
  let admin;

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use the disposable CI database or this managed worktree\'s private QA database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    // Copy migrated types without foreign keys/required business fields, so
    // each test owns only the four records relevant to this race. Notifications
    // keep their actual UUID default for the real shared deduper below.
    for (const table of ['customers', 'scheduled_services', 'appointment_reminders']) {
      await admin.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    }
    await admin.raw('CREATE TABLE ??.notifications (LIKE public.notifications INCLUDING DEFAULTS)', [schema]);
    database = require('knex')({
      client: 'pg', connection: { connectionString: connection, application_name: schema },
      searchPath: [schema, 'public'], pool: { min: 0, max: 2 },
      acquireConnectionTimeout: 3000,
    });
    db.connection = database;
    db.client = database.client;
  }, 30000);

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'performance'] });
    jest.setSystemTime(now);
    await database('notifications').delete();
    await database('appointment_reminders').delete();
    await database('scheduled_services').delete();
    await database('customers').delete();
    await database('customers').insert({ id: customerId, active: true });
    await database('scheduled_services').insert({
      id: serviceId, customer_id: customerId, status: 'pending',
      scheduled_date: due, window_start: null, recurring_dispatch_due_date: due,
    });
    await database('appointment_reminders').insert({
      id: reminderId, customer_id: customerId, scheduled_service_id: serviceId,
      appointment_time: appointmentTime, cancelled: false, confirmation_sent: true,
      reminder_72h_sent: false, reminder_24h_sent: false,
      windows_preclosed: false, suppressed_by_sibling: false,
    });
  });

  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  afterAll(async () => {
    await database?.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  // Wait for PostgreSQL to report an actual blocked connection, rather than
  // guessing that an arbitrary sleep allowed the competing query to start.
  async function waitForBlockedBy(pid) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.raw(
        'SELECT pid FROM pg_stat_activity WHERE application_name = ? AND ?::int = ANY(pg_blocking_pids(pid))',
        [schema, pid],
      );
      if (result.rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Competing operation never waited for the shared database lock');
  }

  test('a cron reminder leaves a connection for delivery queries with a two-connection pool', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    const row = await database('appointment_reminders').where({ id: reminderId }).first();
    const send = jest.fn(async () => {
      expect(await database('customers').where({ id: customerId }).first()).toBeTruthy();
      return true;
    });
    const delivered = await runExclusive(`reminder-pool-${schema}`, () =>
      reminders._test.withReminderSendFence(row, '72h', send), { recordHealth: false });
    expect(delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    // The transaction must leave the session usable for the cron unlock.
    expect(await runExclusive(`reminder-pool-${schema}`, async () => true, { recordHealth: false })).toBe(true);
  });

  test('an already-running sender finishes before the freeze read at the 72.25-hour boundary', async () => {
    await database('scheduled_services').where({ id: serviceId }).update({ window_start: '09:00' });
    const row = await database('appointment_reminders').where({ id: reminderId }).first();
    expect((await loadReminderFreeze(database, [serviceId], new Date())).frozen.has(serviceId)).toBe(false);
    jest.setSystemTime(new Date(now.getTime() + 2));
    const sending = barrier();
    const finishSend = barrier();
    const delivered = reminders._test.withReminderSendFence(row, '72h', async () => {
      const locks = await admin.raw(
        'SELECT pid FROM pg_stat_activity WHERE application_name = ? AND state = ?', [schema, 'idle in transaction'],
      );
      sending.resolve(locks.rows[0].pid);
      await finishSend.promise;
      return true; // synthetic provider acceptance, sent flag intentionally still false
    });
    const senderPid = await sending.promise;
    const deferral = database.transaction(async (trx) => {
      await lockCustomerComms(trx, customerId);
      return loadReminderFreeze(trx, [serviceId], new Date());
    });
    try {
      await waitForBlockedBy(senderPid);
    } finally {
      finishSend.resolve();
    }
    expect(await delivered).toBe(true);
    expect((await deferral).frozen.has(serviceId)).toBe(true);
  }, 30000);

  test.each(['72h', '24h'])('a deferral that wins the fence prevents a stale %s sender from delivering', async (tier) => {
    const stale = await database('appointment_reminders').where({ id: reminderId }).first();
    const deferral = await database.transaction();
    await lockCustomerComms(deferral, customerId);
    const { rows: [{ pid }] } = await deferral.raw('SELECT pg_backend_pid() AS pid');
    const send = jest.fn(async () => true);
    const delivery = reminders._test.withReminderSendFence(stale, tier, send);
    try {
      await waitForBlockedBy(pid);
      // The sender was selected before the series committed. The ordinary
      // freeze snapshot said movable; the clock may enter the band now.
      jest.setSystemTime(new Date(now.getTime() + 2));
      await reminders.precloseWindowlessReminderInTx(deferral, serviceId);
      await deferral.commit();
      expect(await delivery).toBeNull();
      expect(send).not.toHaveBeenCalled();
      expect((await database('appointment_reminders').where({ id: reminderId }).first()).windows_preclosed).toBe(true);
    } finally {
      if (!deferral.isCompleted()) await deferral.rollback();
      await delivery;
    }
  }, 30000);

  test('a rolled-back deferral releases the fence and the valid reminder still delivers', async () => {
    const row = await database('appointment_reminders').where({ id: reminderId }).first();
    const deferral = await database.transaction();
    await lockCustomerComms(deferral, customerId);
    await reminders.precloseWindowlessReminderInTx(deferral, serviceId);
    const send = jest.fn(async () => true);
    const delivery = reminders._test.withReminderSendFence(row, '72h', send);
    await deferral.rollback();
    expect(await delivery).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['placement', { window_start: '09:00' }],
    ['cancellation', { status: 'cancelled' }],
    ['changed due date', { recurring_dispatch_due_date: '2099-02-05' }],
  ])('%s committed after the scan prevents insertion of a stale alert', async (_name, patch) => {
    const placement = await database.transaction();
    const { rows: [{ pid }] } = await placement.raw('SELECT pg_backend_pid() AS pid');
    await placement('scheduled_services').where({ id: serviceId }).update(patch);
    // The scan sees the old committed row; FOR NO KEY UPDATE must wait,
    // then re-evaluate the eligibility predicate on the newly committed row.
    const alerts = flagUnplacedVisits({ lockWindowDays: 14 }, now);
    try {
      await waitForBlockedBy(pid);
      await placement.commit();
      expect(await alerts).toBe(0);
      expect(await database('notifications')).toHaveLength(0);
    } finally {
      if (!placement.isCompleted()) await placement.rollback();
      await alerts;
    }
  }, 30000);

  test('placement waits until the shared dedupe and alert insertion commit', async () => {
    const reachedNotification = barrier();
    const allowNotification = barrier();
    const notifyAdmin = notifications.notifyAdmin.bind(notifications);
    jest.spyOn(notifications, 'notifyAdmin').mockImplementationOnce(async (...args) => {
      const { trx } = args[3];
      const { rows: [{ pid }] } = await trx.raw('SELECT pg_backend_pid() AS pid');
      reachedNotification.resolve(pid);
      await allowNotification.promise;
      return notifyAdmin(...args);
    });
    const alerts = flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const alertPid = await reachedNotification.promise;
    const placement = database.transaction(async (trx) => {
      await trx('scheduled_services').where({ id: serviceId }).update({ window_start: '09:00' });
      return trx('notifications').select('*');
    });
    try {
      await waitForBlockedBy(alertPid);
    } finally {
      allowNotification.resolve();
    }
    expect(await alerts).toBe(1);
    expect(await placement).toHaveLength(1);
  }, 30000);

  test('atomic alerts still dedupe, retire after placement, and reopen the same due date', async () => {
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const first = await database('notifications').first();
    await database('notifications').where({ id: first.id }).update({ read_at: now });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(await database('notifications')).toHaveLength(1);
    expect((await database('notifications').first()).read_at).toEqual(now);
    await database('scheduled_services').where({ id: serviceId }).update({ window_start: '09:00' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect((await database('notifications').first()).title).toBe('Recurring placement alert resolved');
    await database('scheduled_services').where({ id: serviceId }).update({ window_start: null });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const reopened = await database('notifications').first();
    expect(reopened.id).toBe(first.id);
    expect(reopened.read_at).toBeNull();
    expect(reopened.title).toBe('Recurring visit still needs a time');
  });
});
