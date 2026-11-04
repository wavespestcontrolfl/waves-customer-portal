/**
 * The day re-plan APPLY writer (services/day-replan/apply.js): re-validates before the first write, writes in a
 * safe order through the same path as auto-dispatch/apply.js, rolls the day back on a failed step, and raises one
 * notice for Claude's queue when it cannot. Fake rebooker over an in-memory schedule; synthetic ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [] }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60, violatesPreferredTime: jest.fn(), _internals: { isSaturday: jest.fn(), isWeekendDay: jest.fn() },
}));
// The real night writer is loaded only for the reminder-sync argument test; its collaborators are faked.
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({ id: 'r1' }),
  REMINDER_BLOCKING_STATUSES: new Set(['cancelled', 'completed']),
  reminderRowCanSend: () => true,
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(), _private: { doneColumns: jest.fn(() => ({})) } }));

const { applyAcceptedDay, INITIATOR, REASON_CODE } = require('../services/day-replan/apply');
const { _internals } = require('../services/day-replan');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const AppointmentReminders = require('../services/appointment-reminders');
const logger = require('../services/logger');
const { row, makeDb, fakeRebooker } = require('./helpers/day-replan-db');

const DATE = '2026-11-04';
const TECH = 'tech-1';
const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET on Nov 3; DST has ended
const H = (h) => h * 60;
const env = { techBlind: true, openMin: H(8), closeMin: H(17) };
const LOCATION_FIELDS = ['property_id', 'lat', 'lng'];

const toMin = (v) => { const [h, m] = String(v).slice(0, 5).split(':').map(Number); return h * 60 + m; };

/** A tech-day of one-hour visits at the given [id, hour] pairs plus an accepted plan that re-times some of them. */
function world({ visits, changes, hash = 'h1', rowExtra = {}, reminders = [], blocks = [], rebookerOpts = {}, deps: depsOver = {} }) {
  const rows = visits.map(([id, hour]) => row(id, 0.01, hour, { ...(rowExtra[id] || {}) }));
  const { conn, db } = makeDb({ rows, reminders, blocks });
  const rebooker = fakeRebooker(db, conn, rebookerOpts);
  const syncMovedReminders = jest.fn(async () => {});
  const raiseAlert = jest.fn(async () => ({ id: 1 }));
  const deps = {
    fixedReason: _internals.fixedReason,
    rowHours: _internals.rowHours,
    excludedStatuses: ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show'],
    rebooker,
    syncMovedReminders,
    locationFields: LOCATION_FIELDS,
    raiseAlert,
    now: () => NOW,
    ...depsOver,
  };
  const planChanges = changes.map(([id, from, to]) => ({ id, fromMin: H(from), toMin: H(to) }));
  const fresh = {
    verdict: { accepted: true },
    hash,
    result: { changes: planChanges },
    stops: rows.map((r) => ({ id: r.id, slotWidthMin: 60, workMin: 30, pref: null })),
    rowGroups: rows.map((r) => [r]),
    dayContext: { allRows: rows },
    blocks,
  };
  const plan = { hash: 'h1', result: { changes: planChanges } };
  const run = (overrides = {}) => applyAcceptedDay({
    conn, env, dateStr: DATE, techId: TECH, plan, planId: 'plan-1', deps, replan: async () => fresh, ...overrides,
  });
  const windows = () => Object.fromEntries(db.rows.map((r) => [r.id, String(r.window_start).slice(0, 5)]));
  return { db, conn, deps, rebooker, syncMovedReminders, raiseAlert, fresh, plan, run, windows, rows };
}

beforeEach(() => jest.clearAllMocks());

describe('writing an accepted plan', () => {
  test('moves each changed visit through the night writer\'s path with the day_replan initiator', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]] });
    const out = await w.run();
    expect(out).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(w.windows()).toEqual({ a: '12:00', b: '13:00' });

    const [first] = w.rebooker.calls;
    expect(INITIATOR).toBe('day_replan');
    expect(REASON_CODE.length).toBeLessThanOrEqual(30);
    expect([first.id, first.date, first.win, first.reason, first.by]).toEqual(['a', DATE, { start: '12:00', end: '13:00' }, 'day_replan', 'day_replan']);
    expect(first.options).toMatchObject({
      seriesPolicy: 'single', visitPolicy: 'single', keepStatus: true, suppressTechNotice: true, placeInRoute: true, notifyRequested: false,
    });
    expect(typeof first.options.beforeMove).toBe('function');
    // The CAS is pinned on the fresh read, not planned values: the whole placement, flags, status and location.
    expect(first.options.expect).toEqual({
      auto_dispatch_locked: false,
      auto_dispatch_excluded: false,
      status: 'confirmed',
      scheduled_date: DATE,
      window_start: '08:00:00',
      window_end: '09:00:00',
      technician_id: TECH,
      visit_id: null,
      recurring_dispatch_due_date: null,
      customer_confirmed: false,
      property_id: null,
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
  });

  test('a visit alone in its visit record is pinned on that record, not on null', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]], rowExtra: { a: { visit_id: 'v-solo' } } });
    expect((await w.run()).status).toBe('applied');
    expect(w.rebooker.calls.find((c) => c.id === 'a').options.expect.visit_id).toBe('v-solo');
    expect(w.rebooker.calls.find((c) => c.id === 'b').options.expect.visit_id).toBeNull();
  });

  test('syncs each reminder silently through the night writer\'s own function, and sends nothing else', async () => {
    const w = world({ visits: [['a', 8]], changes: [['a', 8, 12]] });
    await w.run();
    expect(w.syncMovedReminders).toHaveBeenCalledTimes(1);
    expect(w.syncMovedReminders).toHaveBeenCalledWith(
      { id: 'a', customer_id: 'cust-a' }, { date: DATE, start_time: '12:00', end_time: '13:00' }, expect.any(Object), [],
    );
  });

  test('a customer text reported by the rebooker undoes the day', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]], rebookerOpts: { textWhen: (id, win) => id === 'b' && win.start === '13:00' } });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'rolled_back', reason: 'step_failed:CUSTOMER_TEXT_SENT' });
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00' });
  });
});

describe('re-validation before the first write', () => {
  test.each([
    ['the version hash changed', { hash: 'h2' }],
    ['the tech-day can no longer be planned', { fresh: { skip: { reason: 'UNTIMED_STOP' } } }],
    ['the fresh plan is not accepted', { fresh: { verdict: { accepted: false } } }],
    ['the fresh plan makes other changes', { changes: [['a', 8, 13], ['b', 9, 12]] }],
  ])('%s: skipped as changed_since_plan, nothing written', async (_label, change) => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]], hash: change.hash || 'h1' });
    if (change.fresh) Object.assign(w.fresh, change.fresh);
    if (change.changes) w.fresh.result = { changes: change.changes.map(([id, from, to]) => ({ id, fromMin: H(from), toMin: H(to) })) };
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a day that cannot be read again, or that vanished, is skipped', async () => {
    const w = world({ visits: [['a', 8]], changes: [['a', 8, 12]] });
    expect((await w.run({ replan: async () => { throw new Error('connection reset'); } })).reason).toBe('changed_since_plan');
    expect((await w.run({ replan: async () => null })).reason).toBe('changed_since_plan');
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a plan with no hour changes writes nothing', async () => {
    const w = world({ visits: [['a', 8]], changes: [] });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'no_hour_changes', moved: 0 });
  });

  test.each([
    ['the 24-hour reach (24.25 h) is reached', { now: () => new Date('2026-11-03T13:45:00Z') }, 'within_24h'],
    ['the 24-hour reminder was sent', { reminders: [{ scheduled_service_id: 'a', reminder_24h_sent: true }] }, 'reminder_24h_sent'],
    ['staff locked the visit', { rowExtra: { a: { auto_dispatch_locked: true } } }, 'staff_lock'],
    ['staff excluded the visit', { rowExtra: { a: { auto_dispatch_excluded: true } } }, 'staff_lock'],
    ['the status changed', { rowExtra: { a: { status: 'on_site' } } }, 'status'],
    ['the status is empty', { rowExtra: { a: { status: null } } }, 'status'],
    ['an estimate hold is live on it', { rowExtra: { a: { reservation_expires_at: '2099-01-01T00:00:00Z' } } }, 'hold'],
    ['another service joined its visit', { rowExtra: { a: { visit_id: 'v1' }, z: { visit_id: 'v1', technician_id: 'tech-2', customer_id: 'cz' } } }, 'grouped'],
    ['the customer has another visit that day', { rowExtra: { z: { customer_id: 'cust-a', technician_id: 'tech-2' } } }, 'same_customer'],
  ])('%s: the visit is refused before any write', async (_label, change, why) => {
    const w = world({
      visits: [['a', 8], ['b', 9], ['z', 14]],
      changes: [['a', 8, 12], ['b', 9, 13]],
      rowExtra: change.rowExtra, reminders: change.reminders,
      deps: change.now ? { now: change.now } : {},
    });
    const out = await w.run();
    expect(out).toEqual({ status: 'skipped', reason: `visit_not_movable:${why}`, moved: 0 });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(w.windows()).toMatchObject({ a: '08:00', b: '09:00' });
  });

  test('moving a visit INTO the 24-hour reach is refused too', async () => {
    // Now is 04:45 on Nov 3: 08:00 on Nov 4 is 27 h away, but a target of 04:00 would be inside 24.25 h.
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 4], ['b', 9, 13]], deps: { now: () => new Date('2026-11-03T09:45:00Z') } });
    const out = await w.run();
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('visit_not_movable:within_24h');
  });
});

describe('the order of the writes', () => {
  test('a swap goes through a temporary hour, and no visit ends on it', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]] });
    const out = await w.run();
    expect(out).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(w.windows()).toEqual({ a: '09:00', b: '08:00' });
    expect(w.rebooker.calls).toHaveLength(3);
    const temp = w.rebooker.calls[0].win.start;
    expect(['08:00', '09:00']).not.toContain(temp);
    expect(toMin(temp)).toBeGreaterThanOrEqual(H(8));
    expect(toMin(temp) + 60).toBeLessThanOrEqual(H(17));
  });

  test('a three-visit cycle is written with one temporary hour', async () => {
    const w = world({ visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 9], ['b', 9, 10], ['c', 10, 8]] });
    expect((await w.run()).status).toBe('applied');
    expect(w.windows()).toEqual({ a: '09:00', b: '10:00', c: '08:00' });
    expect(w.rebooker.calls).toHaveLength(4);
  });

  test('no free temporary hour: skipped as no_safe_sequence, nothing written', async () => {
    // Hours 10-16 are held by fixed visits, so the 8 <-> 9 swap has nowhere to park.
    const fixed = [['f10', 10], ['f11', 11], ['f12', 12], ['f13', 13], ['f14', 14], ['f15', 15], ['f16', 16]];
    const w = world({ visits: [['a', 8], ['b', 9], ...fixed], changes: [['a', 8, 9], ['b', 9, 8]] });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'no_safe_sequence', moved: 0 });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('another technician\'s visit holds its hour while occupancy is tech-blind', async () => {
    // Only hour 8 and 9 are movable; every other hour belongs to a visit on another technician's day.
    const others = [10, 11, 12, 13, 14, 15, 16].map((h) => [`o${h}`, h]);
    const w = world({
      visits: [['a', 8], ['b', 9], ...others], changes: [['a', 8, 9], ['b', 9, 8]],
      rowExtra: Object.fromEntries(others.map(([id]) => [id, { technician_id: 'tech-2' }])),
    });
    expect((await w.run()).reason).toBe('no_safe_sequence');
    // With scoped occupancy those hours are free for a temporary hour (the rebooker is scoped the same way).
    const scopedWorld = world({
      visits: [['a', 8], ['b', 9], ...others], changes: [['a', 8, 9], ['b', 9, 8]],
      rowExtra: Object.fromEntries(others.map(([id]) => [id, { technician_id: 'tech-2' }])),
      rebookerOpts: { techBlind: false },
    });
    expect((await scopedWorld.run({ env: { ...env, techBlind: false } })).status).toBe('applied');
  });
});

describe('a failed step', () => {
  test('rolls the day back through the same path, in reverse, to the original hours', async () => {
    let calls = 0;
    const w = world({ visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 13], ['c', 10, 14]], rebookerOpts: { failWhen: () => { calls += 1; return calls === 3; } } });
    const out = await w.run();
    expect(out).toEqual({ status: 'rolled_back', reason: 'step_failed:SLOT_TAKEN', moved: 0 });
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00', c: '10:00' });
    // Two steps landed, the third failed, then the two are reversed newest first.
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['a:12:00', 'b:13:00', 'c:14:00', 'b:09:00', 'a:08:00']);
    const reversal = w.rebooker.calls.slice(3);
    for (const c of reversal) {
      expect([c.reason, c.by]).toEqual(['day_replan', 'day_replan']);
      expect(c.options.beforeMove).toBeUndefined(); // an undo must not be refused by the 24-hour reach
      expect(c.options.keepStatus).toBe(true);
    }
    expect(w.raiseAlert).not.toHaveBeenCalled();
  });

  test('a visit that stops being movable between the first pass and its own write rolls the day back', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]] });
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      const out = await original(...args);
      // The 24-hour reminder for b goes out right after a's step.
      if (args[0] === 'a') w.db.reminders.push({ scheduled_service_id: 'b', reminder_24h_sent: true });
      return out;
    });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'rolled_back', reason: 'step_failed:NOT_MOVABLE' });
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00' });
  });

  test('a rollback step that fails leaves the day as it is, records failed, and raises ONE notice for Claude', async () => {
    let calls = 0;
    const w = world({
      visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 13], ['c', 10, 14]],
      // The third write fails, then the first undo fails too.
      rebookerOpts: { failWhen: () => { calls += 1; return calls === 3 || calls === 4; } },
    });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'failed', moved: 2 });
    expect(out.reason).toBe('rollback_failed:SLOT_TAKEN');
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = w.raiseAlert.mock.calls[0];
    expect(category).toBe('schedule_conflict');
    expect(spec).toMatchObject({ area: 'Schedule', who: 'claude', subject: { type: 'check', id: `day-replan-${DATE}-${TECH}` } });
    // It follows the notification rule (no ids or dates in the words) and stays off the owner's bell list.
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(opts.metadata.feed).toBe('activity');
    expect(opts.dedupeKey).toBe(`day-replan-failed:${DATE}:${TECH}`);
    expect(`${spec.action} ${spec.why}`).not.toMatch(/cust-|tech-1|plan-1/);
  });
});

describe('the reminder sync is the night writer\'s own', () => {
  test('handleReschedule gets exactly the arguments apply.js gives it', async () => {
    const { syncMovedReminders } = jest.requireActual('../services/auto-dispatch/apply');
    const w = world({ visits: [['a', 8]], changes: [['a', 8, 12]], deps: { syncMovedReminders } });
    expect((await w.run()).status).toBe('applied');
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('a', `${DATE}T12:00`, {
      sendNotification: false,
      keepPendingConfirmation: true,
      expectSchedule: { date: DATE, windowStart: '12:00' },
      preserveMoveHold: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
