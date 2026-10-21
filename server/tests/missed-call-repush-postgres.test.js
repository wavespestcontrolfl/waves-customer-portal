// GATE_MISSED_CALL_REPUSH on PostgreSQL: an unread, not-done customer_missed_call
// bell gets ONE more admin push 30 minutes after it rang, in office hours,
// with the call's own tag and renotify true, and no new bell row. Admin push
// only: the push service is a stand-in, and nothing here can reach a customer.
// CI's DATABASE_URL pass runs this; fixture rows live in a unique schema that
// is removed after the suite.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/notification-bell-policy', () => ({
  isBellPolicyEnabled: jest.fn(() => false),
  bellAllowed: jest.fn(async () => true),
}));
jest.mock('../services/push-notifications', () => ({
  // Runs the sweep's last-moment check like the real fan-out, then "delivers".
  sendToAdminUsers: jest.fn(async (ids, build, opts = {}) => {
    if (opts.beforeDispatch && (await opts.beforeDispatch()) === false) return { sent: 0, superseded: true };
    ids.forEach((id) => build(id));
    return { sent: ids.length, subscriptions: ids.length };
  }),
}));

const { isEnabled } = require('../config/feature-gates');
const PushService = require('../services/push-notifications');
const { sweepMissedCallRepush } = require('../services/missed-call-repush');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call re-push on PostgreSQL', () => {
  let database;
  const schema = `missed_call_repush_${randomUUID().replaceAll('-', '')}`;
  const tables = ['notifications', 'notification_preferences', 'technicians'];
  // Tue 2026-10-20 11:00 ET (EDT) is inside Mon-Sat 8:00-18:00.
  const NOW = new Date('2026-10-20T15:00:00Z');
  const HOURS = { startMin: 8 * 60, endMin: 18 * 60 };
  const minutesBefore = (m, at = NOW) => new Date(at.getTime() - m * 60 * 1000);
  let adminId;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
    adminId = randomUUID();
    await database('technicians').insert({ id: adminId, name: 'Synthetic Admin', active: true, role: 'admin', created_at: NOW, updated_at: NOW });
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function bell(minutesOld, extra = {}) {
    const callLogId = randomUUID();
    const row = {
      id: randomUUID(),
      recipient_type: 'admin',
      category: 'missed_call',
      title: 'Missed call — Pat Synthetic',
      body: '(941) 555-0100 called and did not leave a voicemail.',
      link: `/admin/communications#tab=calls&call=${callLogId}`,
      metadata: { triggerKey: 'customer_missed_call', payload: { callLogId, phone: '(941) 555-0100' } },
      created_at: minutesBefore(minutesOld),
      ...extra,
    };
    await database('notifications').insert(row);
    return { ...row, callLogId };
  }
  const stored = (row) => database('notifications').where({ id: row.id }).first();
  const run = (opts = {}) => sweepMissedCallRepush({ now: NOW, hours: HOURS, ...opts });

  test('re-pushes once after 30 minutes in office hours: same tag, renotify, no new bell row', async () => {
    const row = await bell(31);
    expect(await run()).toBe(1);

    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    const [ids, build] = PushService.sendToAdminUsers.mock.calls[0];
    expect(ids).toEqual([adminId]);
    const push = build(adminId);
    expect(push).toMatchObject({
      title: row.title,
      body: row.body,
      url: row.link,
      tag: `waves-customer_missed_call-${row.callLogId}`,
      renotify: true,
      priority: 'high',
      silent: false,
    });
    const after = await stored(row);
    expect(new Date(after.metadata.repushed_at).toISOString()).toBe(NOW.toISOString());
    expect(after.metadata.repush_sent).toBe(1);
    expect(after.metadata.payload.callLogId).toBe(row.callLogId);
    expect(after.read_at).toBeNull();
    expect(after.done_at).toBeNull();
    expect(Number((await database('notifications').count('* as n').first()).n)).toBe(1);
  });

  test('never twice: later ticks and an overlapping sweep leave it alone', async () => {
    const row = await bell(40);
    expect(await run()).toBe(1);
    expect(await run({ now: new Date(NOW.getTime() + 2 * 60 * 1000) })).toBe(0);
    await Promise.all([run(), run()]);
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    expect((await stored(row)).metadata.repushed_at).toBeTruthy();
  });

  test('two sweeps racing on one fresh bell send exactly once', async () => {
    await bell(45);
    const results = await Promise.all([run(), run()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
  });

  test('not before 30 minutes', async () => {
    const row = await bell(29);
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    // The same bell qualifies once it is 30 minutes old.
    expect(await run({ now: new Date(NOW.getTime() + 60 * 1000) })).toBe(1);
  });

  test('not outside office hours: evening, early morning, Sunday, a closed day', async () => {
    const row = await bell(60, { created_at: new Date('2026-10-20T21:00:00Z') });
    // 20:00 ET Tuesday, 07:30 ET Wednesday, 11:00 ET Sunday.
    for (const at of ['2026-10-21T00:00:00Z', '2026-10-21T11:30:00Z', '2026-10-25T15:00:00Z']) {
      expect(await run({ now: new Date(at) })).toBe(0);
    }
    // A closure flag for the day (blackout) also holds it back.
    expect(await run({ hours: { ...HOURS, closedToday: true, closedForDate: '2026-10-20' } })).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    // Monday 8:00 ET: the bell is still unread and within 48 hours, so it goes then.
    const sat = await bell(60, { created_at: new Date('2026-10-24T20:00:00Z') });
    expect(await run({ now: new Date('2026-10-26T12:00:00Z') })).toBe(1);
    expect((await stored(sat)).metadata.repushed_at).toBeTruthy();
  });

  test('not when the bell was read, done, or retired', async () => {
    const read = await bell(45, { read_at: minutesBefore(5) });
    const done = await bell(45, { done_at: minutesBefore(5), done_by: 'tech-1' });
    const retired = await bell(45, { done_at: minutesBefore(5), done_by: 'supersede', resolution: 'The caller got through on a later call' });
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    for (const row of [read, done, retired]) expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });

  test('a bell opened between the read and the send is not re-pushed', async () => {
    const row = await bell(45);
    PushService.sendToAdminUsers.mockImplementationOnce(async (ids, build, opts) => {
      await database('notifications').where({ id: row.id }).update({ read_at: NOW });
      return (await opts.beforeDispatch()) ? { sent: 1 } : { sent: 0, superseded: true };
    });
    expect(await run()).toBe(0);
    expect((await stored(row)).metadata.repush_sent).toBe(0);
  });

  test('only missed-call bells and only the admin recipients with push on', async () => {
    await bell(45, { category: 'inbound_sms', metadata: { triggerKey: 'sms_reply', payload: {} } });
    await bell(45, { metadata: { triggerKey: 'repeat_caller', payload: { callLogId: randomUUID() } } });
    const quiet = randomUUID();
    await database('technicians').insert({ id: quiet, name: 'Synthetic Quiet', active: true, role: 'admin', created_at: NOW, updated_at: NOW });
    await database('notification_preferences').insert({ id: randomUUID(), admin_user_id: quiet, trigger_key: 'customer_missed_call', push_enabled: false });
    const target = await bell(45);
    expect(await run()).toBe(1);
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    expect(PushService.sendToAdminUsers.mock.calls[0][0]).toEqual([adminId]);
    expect((await stored(target)).metadata.repushed_at).toBeTruthy();
  });

  test('a bell older than 48 hours is the office\'s to close by hand', async () => {
    await bell(49 * 60);
    expect(await run()).toBe(0);
  });

  test('gate off does nothing: no query, no push, no stamp', async () => {
    isEnabled.mockImplementation(() => false);
    const row = await bell(45);
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });
});
