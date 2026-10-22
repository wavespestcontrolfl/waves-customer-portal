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
// The called-back retire runs first (pre-push audit); its own suites cover it.
jest.mock('../services/missed-call-bell', () => ({ ...jest.requireActual('../services/missed-call-bell'), retireCalledBackMissedCalls: jest.fn(async () => 0) }));
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
const missedCallBell = require('../services/missed-call-bell');
const blackoutDates = require('../services/scheduling/blackout-dates');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call re-push on PostgreSQL', () => {
  let database;
  const schema = `missed_call_repush_${randomUUID().replaceAll('-', '')}`;
  const tables = ['notifications', 'notification_preferences', 'technicians', 'call_log', 'scheduled_services', 'invoices', 'schedule_blackout_dates', 'system_settings'];
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
    jest.restoreAllMocks();
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
  // `now` also drives the sweep's clock, so every recheck sees the same instant.
  const run = (opts = {}) => {
    const at = opts.now || NOW;
    return sweepMissedCallRepush({ hours: HOURS, clock: () => at, ...opts, now: at });
  };

  test('the called-back retire runs before any re-push is chosen (pre-push audit)', async () => {
    const { retireCalledBackMissedCalls } = require('../services/missed-call-bell');
    retireCalledBackMissedCalls.mockClear();
    await run();
    expect(retireCalledBackMissedCalls).toHaveBeenCalledTimes(1);
  });

  test('a caller who got through after the retire ran is never re-pushed (Codex #6383 r3)', async () => {
    const row = await bell(45);
    const missedAt = minutesBefore(50);
    await database('call_log').insert([
      { id: row.callLogId, twilio_call_sid: 'CA_missed_sample', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19412975749', status: 'no-answer', answered_by: 'missed', duration_seconds: 20, metadata: {}, created_at: missedAt, updated_at: missedAt },
      { id: randomUUID(), twilio_call_sid: 'CA_later_sample', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19412975749', status: 'completed', answered_by: 'human', duration_seconds: 90, metadata: {}, created_at: minutesBefore(5), updated_at: minutesBefore(5) },
    ]);
    expect(await run()).toBe(0);
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });

  test('a still-missed call (row present, nobody got through) is re-pushed', async () => {
    const row = await bell(45);
    const missedAt = minutesBefore(50);
    await database('call_log').insert({ id: row.callLogId, twilio_call_sid: 'CA_missed_sample2', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19412975749', status: 'no-answer', answered_by: 'missed', duration_seconds: 20, metadata: {}, created_at: missedAt, updated_at: missedAt });
    expect(await run()).toBe(1);
  });

  // A missed call as the bell leaves it, with `meta` as call_log.metadata.
  async function missedCallFor(row, meta = {}) {
    const missedAt = minutesBefore(50);
    await database('call_log').insert({ id: row.callLogId, twilio_call_sid: `CA_${row.callLogId}`, direction: 'inbound', from_phone: '+19415550100', to_phone: '+19412975749', status: 'no-answer', answered_by: 'missed', duration_seconds: 53, metadata: meta, created_at: missedAt, updated_at: missedAt });
  }

  test.each(['burst_quiet', 'block_quiet'])('a quiet robodialer call (%s) is never re-pushed, and does not fill the batch ahead of a real bell', async (kind) => {
    const quiet = await bell(120);
    const ordinary = await bell(45);
    await missedCallFor(quiet, { missed_call_spam_wave: kind });
    await missedCallFor(ordinary);
    // limit 1: the older quiet bell would be picked first if it were a candidate.
    expect(await run({ limit: 1 })).toBe(1);
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    expect((await stored(quiet)).metadata.repushed_at).toBeUndefined();
    expect((await stored(ordinary)).metadata.repushed_at).toBeDefined();
  });

  test('a call that turns block_quiet between the read and the claim is not re-pushed (callStillMissed)', async () => {
    const row = await bell(45);
    await missedCallFor(row);
    const real = PushService.sendToAdminUsers.getMockImplementation();
    PushService.sendToAdminUsers.mockImplementationOnce(async (...args) => {
      await database('call_log').where({ id: row.callLogId }).update({ metadata: { missed_call_spam_wave: 'block_quiet' } });
      return real(...args);
    });
    expect(await run()).toBe(0);
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });

  test('other spam stamps do not stop a re-push: a block-wave shadow or a burst shadow call still buzzes', async () => {
    const row = await bell(45);
    await missedCallFor(row, { missed_call_spam_wave_shadow: true, missed_call_spam_burst_shadow: true });
    expect(await run()).toBe(1);
  });

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
    // Barrier: both contenders reach the push service (so both read the bell as
    // a candidate) before either claim lands. Only the claim winner may hand off.
    let arrived = 0;
    let handoffs = 0;
    let release;
    const bothArrived = new Promise((resolve) => { release = resolve; });
    PushService.sendToAdminUsers.mockImplementation(async (ids, build, opts) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      if (!(await opts.beforeDispatch())) return { sent: 0, superseded: true };
      handoffs += 1;
      ids.forEach((id) => build(id));
      return { sent: ids.length, subscriptions: ids.length };
    });
    const results = await Promise.all([run(), run()]);
    expect(arrived).toBe(2);
    expect(handoffs).toBe(1);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
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
    // Never stamped: the claim refused an opened bell.
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
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

  test('a failed subscription lookup does not consume the one re-push', async () => {
    const row = await bell(45);
    // The push service fails (or finds no devices) before it reaches beforeDispatch.
    PushService.sendToAdminUsers.mockRejectedValueOnce(new Error('subscription lookup outage'));
    expect(await run()).toBe(0);
    PushService.sendToAdminUsers.mockImplementationOnce(async () => ({ sent: 0, subscriptions: 0 }));
    expect(await run()).toBe(0);
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    // The next tick still sends it, once.
    expect(await run()).toBe(1);
    expect((await stored(row)).metadata.repushed_at).toBeTruthy();
  });

  test('office hours are rechecked at the handoff, not only at sweep start', async () => {
    const row = await bell(45);
    let at = NOW;
    const evening = new Date('2026-10-20T22:30:00Z'); // 18:30 ET
    // The office closes while the push service prepares: nothing is stamped or sent.
    PushService.sendToAdminUsers.mockImplementationOnce(async (ids, build, opts) => {
      at = evening;
      return (await opts.beforeDispatch()) ? { sent: 1 } : { sent: 0, superseded: true };
    });
    expect(await sweepMissedCallRepush({ now: NOW, hours: HOURS, clock: () => at })).toBe(0);
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    // It closes after the stamp but before a device: that device is skipped.
    at = NOW;
    PushService.sendToAdminUsers.mockImplementationOnce(async (ids, build, opts) => {
      expect(await opts.beforeDispatch()).toBe(true);
      at = evening;
      return (await opts.beforeHandoff()) ? { sent: 1 } : { sent: 0, superseded: true };
    });
    expect(await sweepMissedCallRepush({ now: NOW, hours: HOURS, clock: () => at })).toBe(0);
    expect((await stored(row)).metadata.repushed_at).toBeTruthy();
    expect((await stored(row)).metadata.repush_sent).toBe(0);
  });

  test('the handoff rereads the closed-day list: a closure landing after the claim stops the device', async () => {
    const row = await bell(45);
    PushService.sendToAdminUsers.mockImplementationOnce(async (ids, build, opts) => {
      expect(await opts.beforeDispatch()).toBe(true);
      await database('schedule_blackout_dates').insert({ date: '2026-10-20' });
      return (await opts.beforeHandoff()) ? { sent: 1 } : { sent: 0, superseded: true };
    });
    expect(await run()).toBe(0);
    expect((await stored(row)).metadata.repush_sent).toBe(0);
    // An unreadable list at the handoff also stops it.
    await database('schedule_blackout_dates').del();
    const second = await bell(46);
    PushService.sendToAdminUsers.mockImplementationOnce(async (ids, build, opts) => {
      expect(await opts.beforeDispatch()).toBe(true);
      jest.spyOn(blackoutDates, 'getBlackoutDates').mockRejectedValue(new Error('blackout read failed'));
      return (await opts.beforeHandoff()) ? { sent: 1 } : { sent: 0, superseded: true };
    });
    expect(await run()).toBe(0);
    expect((await stored(second)).metadata.repush_sent).toBe(0);
  });

  test('a closed day in the blackout list holds it back; an unreadable list counts as closed', async () => {
    const row = await bell(45);
    await database('schedule_blackout_dates').insert({ date: '2026-10-20' });
    expect(await run()).toBe(0);
    await database('schedule_blackout_dates').del();
    jest.spyOn(blackoutDates, 'getBlackoutDates').mockRejectedValue(new Error('blackout read failed'));
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    blackoutDates.getBlackoutDates.mockRestore();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    expect(await run()).toBe(1);
  });

  test('if retiring called-back bells fails, the tick sends nothing', async () => {
    const row = await bell(45);
    jest.spyOn(missedCallBell, 'retireCalledBackMissedCalls').mockRejectedValue(new Error('retire failed'));
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });

  test('gate off does nothing: no query, no push, no stamp', async () => {
    isEnabled.mockImplementation(() => false);
    const row = await bell(45);
    expect(await run()).toBe(0);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.repushed_at).toBeUndefined();
  });
});
