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

const { applyAcceptedDay, findInterrupted, recoverInterrupted, INITIATOR, REASON_CODE, _internals: applyInternals } = require('../services/day-replan/apply');
const { _internals } = require('../services/day-replan');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const AppointmentReminders = require('../services/appointment-reminders');
const logger = require('../services/logger');
const { HQ, row, makeDb, fakeRebooker } = require('./helpers/day-replan-db');
const { withHour, appSimCheck } = require('../services/day-replan/app-sim');
const { parseETDateTime } = require('../utils/datetime-et');

const reconcile = (w, ids, skip) => applyInternals.reconcileReminders(w.conn, w.deps, { ids, skip });

const DATE = '2026-11-04';
const TECH = 'tech-1';
const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET on Nov 3; DST has ended
const H = (h) => h * 60;
const env = { techBlind: true, openMin: H(8), closeMin: H(17), departureMin: H(8) };
const LOCATION_FIELDS = ['property_id', 'lat', 'lng'];

const toMin = (v) => { const [h, m] = String(v).slice(0, 5).split(':').map(Number); return h * 60 + m; };

/** A tech-day of one-hour visits at the given [id, hour] pairs plus an accepted plan that re-times some of them. */
function world({ visits, changes, hash = 'h1', rowExtra = {}, reminders = [], blocks = [], rebookerOpts = {}, deps: depsOver = {} }) {
  const rows = visits.map(([id, hour]) => row(id, 0.01, hour, { ...(rowExtra[id] || {}) }));
  const { conn, db } = makeDb({ rows, reminders, blocks });
  db.plans.push({ id: 'plan-1', apply_status: null });
  const rebooker = fakeRebooker(db, conn, rebookerOpts);
  const syncMovedReminders = jest.fn(async () => {});
  const raiseAlert = jest.fn(async () => ({ id: 1 }));
  const acquireOccupancyLock = jest.fn(async () => {});
  const lockTechDays = jest.fn(async () => {});
  const deps = {
    fixedReason: _internals.fixedReason,
    rowHours: _internals.rowHours,
    excludedStatuses: ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show'],
    rebooker,
    syncMovedReminders,
    locationFields: LOCATION_FIELDS,
    raiseAlert,
    acquireOccupancyLock,
    lockTechDays,
    now: () => NOW,
    ...depsOver,
  };
  const planChanges = changes.map(([id, from, to]) => ({ id, fromMin: H(from), toMin: H(to) }));
  // The fresh plan, made coherent: the tech's stops in the order of their final hours, and the app simulation's
  // figures for exactly that route (what the planner's check would hold).
  const techRows = rows.filter((r) => r.technician_id === TECH);
  const finalStart = (r) => (planChanges.find((c) => c.id === r.id) ? planChanges.find((c) => c.id === r.id).toMin : toMin(r.window_start));
  const ordered = [...techRows].sort((a, b) => finalStart(a) - finalStart(b) || a.id.localeCompare(b.id));
  const finalGroups = ordered.map((r) => [planChanges.find((c) => c.id === r.id) ? withHour(r, finalStart(r)) : r]);
  const origin = { lat: HQ.lat, lng: HQ.lng };
  const planned = appSimCheck({ groups: finalGroups, baselineOrder: ordered.map((r) => r.id), best: null, origin, departureMin: env.departureMin, marginMin: 15 }).current;
  const fresh = {
    verdict: { accepted: true },
    hash,
    origin,
    check: { planned },
    result: { changes: planChanges, best: { order: ordered.map((r) => r.id) } },
    stops: techRows.map((r) => ({ id: r.id, slotWidthMin: 60, workMin: 30, pref: null })),
    rowGroups: techRows.map((r) => [{ ...r }]),
    // The rows as the fresh plan read them (a copy: the live table moves on without them).
    dayContext: { allRows: rows.map((r) => ({ ...r })) },
    blocks,
  };
  const plan = { hash: 'h1', result: { changes: planChanges } };
  const run = (overrides = {}) => applyAcceptedDay({
    conn, env, dateStr: DATE, techId: TECH, plan, planId: 'plan-1', deps, replan: async () => fresh, ...overrides,
  });
  const windows = () => Object.fromEntries(db.rows.filter((r) => r.technician_id === TECH).map((r) => [r.id, String(r.window_start).slice(0, 5)]));
  const journal = () => JSON.parse(db.plans[0].apply_steps);
  return { db, conn, deps, rebooker, syncMovedReminders, raiseAlert, acquireOccupancyLock, lockTechDays, fresh, plan, run, windows, journal, rows };
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
      seriesPolicy: 'single', visitPolicy: 'single', keepStatus: true, suppressTechNotice: true, placeInRoute: false, notifyRequested: false,
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

describe('a rollback is fenced on what this writer committed', () => {
  /** Three visits moved forward; the third write is refused and `afterTwo` runs just before it (a person acting). */
  function personActs(afterTwo, extra = {}) {
    const w = world({
      visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 13], ['c', 10, 14]],
      rowExtra: { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 } },
      rebookerOpts: { failWhen: (_id, _win, n) => { if (n === 3) afterTwo(w.db.rows.find((r) => r.id === 'a')); return n === 3; } },
      ...extra,
    });
    return w;
  }

  test.each([
    ['moved it to another hour', (a) => { a.window_start = '15:00:00'; a.window_end = '16:00:00'; }],
    ['gave it to another technician', (a) => { a.technician_id = 'tech-9'; }],
    ['changed its status', (a) => { a.status = 'pending'; }],
    ['locked it for staff', (a) => { a.auto_dispatch_locked = true; }],
    ['edited its location', (a) => { a.lat += 0.5; a.raw_lat += 0.5; }],
    ['put it in a visit record', (a) => { a.visit_id = 'visit-9'; }],
  ])('a person %s after our step: it is left alone, the others go back, one notice, failed', async (_label, mutate) => {
    const w = personActs(mutate);
    const before = JSON.stringify(w.db.rows.find((r) => r.id === 'a'));
    let after;
    const out = await w.run();
    after = w.db.rows.find((r) => r.id === 'a');
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.reason).toBe('rollback_failed:DIVERGED');
    // a is exactly as the person left it: no write touched it during the rollback.
    expect(w.rebooker.calls.filter((c) => c.id === 'a')).toHaveLength(1);
    expect(JSON.stringify(after)).not.toBe(before); // (it changed at the person's hand, and only theirs)
    // b, whose step landed, was put back; the visit c was refused and never moved.
    expect(w.windows().b).toBe('09:00');
    expect(w.windows().c).toBe('10:00');
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    expect(w.raiseAlert.mock.calls[0][1].why).toMatch(/could not be put back/);
    expect(w.db.plans[0].apply_status ?? 'open').toBe('open'); // the runner records the outcome, not the writer
  });

  test('the route numbers stay as they are when a visit could not be put back', async () => {
    const w = personActs((a) => { a.technician_id = 'tech-9'; });
    await w.run();
    expect(w.db.rows.map((r) => r.route_order)).toEqual([1, 2, 3]);
  });

  test('a person who put the visit back on its old hour needs no undo', async () => {
    const w = personActs((a) => { a.window_start = '08:00:00'; a.window_end = '09:00:00'; });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'rolled_back' });
    expect(w.rebooker.calls.filter((c) => c.id === 'a')).toHaveLength(1);
    expect(w.raiseAlert).not.toHaveBeenCalled();
  });

  test('a stuck visit holds back its older steps too, and the others are still put back', async () => {
    // a is parked on a temporary hour by the first step of a swap, and a person then edits it.
    const w = world({
      visits: [['a', 8], ['b', 9], ['c', 11]], changes: [['a', 8, 9], ['b', 9, 8], ['c', 11, 13]],
      rebookerOpts: { failWhen: (_id, _win, n) => { if (n === 4) { const a = w.db.rows.find((r) => r.id === 'a'); a.lng += 0.5; a.raw_lng += 0.5; } return n === 4; } },
    });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'failed' });
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    // a (edited by a person) was not written again; every other visit is back on its own hour.
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['c:13:00', 'a:10:00', 'b:08:00', 'a:09:00', 'b:09:00', 'c:11:00']);
    expect(w.windows()).toEqual({ a: '10:00', b: '09:00', c: '11:00' });
    // The visit left on its parking hour never has a reminder synced to that hour.
    for (const [service, best] of w.syncMovedReminders.mock.calls) if (service.id === 'a') expect(best.start_time).not.toBe('10:00');
    expect(w.windows().c).toBe('11:00');
  });
});

describe('the route numbers on a rollback', () => {
  test('are restored only where a number still equals the one this writer wrote', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]], rowExtra: { a: { route_order: 5 }, b: { route_order: 6 } } });
    // This writer wrote 1 and 2 over the old 5 and 6; a person has since renumbered b to 9.
    w.db.rows.find((r) => r.id === 'a').route_order = 1;
    w.db.rows.find((r) => r.id === 'b').route_order = 9;
    await applyInternals.restoreRouteOrder(w.conn, w.deps, { dateStr: DATE, techId: TECH, routeBefore: { a: 5, b: 6 }, routeAfter: { a: 1, b: 2 } });
    expect(w.db.rows.map((r) => r.route_order)).toEqual([5, 9]);
  });

  test('a journal with no routeAfter (the numbers were never written) restores nothing', async () => {
    const w = world({ visits: [['a', 8]], changes: [['a', 8, 12]], rowExtra: { a: { route_order: 7 } } });
    await applyInternals.restoreRouteOrder(w.conn, w.deps, { dateStr: DATE, techId: TECH, routeBefore: { a: 1 }, routeAfter: undefined });
    expect(w.db.rows[0].route_order).toBe(7);
  });
});

describe('the rollback is journaled step by step', () => {
  test('each undo is an intent before its write and done after', async () => {
    let n = 0;
    const w = world({ visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 13], ['c', 10, 14]], rebookerOpts: { failWhen: () => { n += 1; return n === 3; } } });
    const seen = [];
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      const j = JSON.parse(w.db.plans[0].apply_steps);
      if (j.rollback) seen.push(j.steps.map((s) => `${s.id}:${s.undo || '-'}`).join(' '));
      return original(...args);
    });
    expect((await w.run()).status).toBe('rolled_back');
    // At b's undo b is an intent and a is untouched; at a's undo b is done and a is an intent.
    expect(seen).toEqual(['a:- b:intent c:done', 'a:intent b:done c:done']);
    expect(w.journal().steps.map((s) => `${s.id}:${s.state}:${s.undo}`)).toEqual(['a:done:done', 'b:done:done', 'c:failed:done']);
  });

  /** The state a crash leaves, captured at the start of a rebooker call during the rollback. */
  function crashImages() {
    let n = 0;
    const w = world({
      visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 13], ['c', 10, 14]],
      rowExtra: { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 } },
      rebookerOpts: { failWhen: () => { n += 1; return n === 3; } },
    });
    const images = [];
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      images.push({ rows: w.db.rows.map((r) => ({ ...r })), steps: w.db.plans[0].apply_steps, call: w.rebooker.calls.length + 1 });
      return original(...args);
    });
    const crash = async (image, stepsOverride) => {
      w.db.rows.splice(0, w.db.rows.length, ...image.rows.map((r) => ({ ...r })));
      Object.assign(w.db.plans[0], { service_date: DATE, technician_id: TECH, apply_status: null, apply_reason: null, apply_steps: stepsOverride || image.steps });
      w.rebooker.calls.length = 0;
      w.rebooker.reschedule.mockClear();
      w.raiseAlert.mockClear();
      return recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    };
    return { w, images, crash };
  }

  test('a crash before the first undo: recovery undoes every step, once each', async () => {
    const { w, images, crash } = crashImages();
    await w.run();
    const image = images.find((i) => i.call === 4); // the first undo is about to be written
    const out = await crash(image);
    expect(out[0]).toMatchObject({ status: 'rolled_back' });
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['b:09:00', 'a:08:00']);
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00', c: '10:00' });
    expect(w.db.rows.map((r) => r.route_order)).toEqual([1, 2, 3]);
  });

  test('a crash mid-rollback (b undone and journaled): recovery resumes with a only, and never repeats b', async () => {
    const { w, images, crash } = crashImages();
    await w.run();
    const out = await crash(images.find((i) => i.call === 5)); // b is back; a's undo is about to be written
    expect(out[0]).toMatchObject({ status: 'rolled_back' });
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['a:08:00']);
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00', c: '10:00' });
  });

  test('a crash after an undo landed but before it was journaled: that undo is not repeated', async () => {
    const { w, images, crash } = crashImages();
    await w.run();
    // Rows as at a's undo (b already back) with the journal as at b's undo (b still an intent).
    const out = await crash(images.find((i) => i.call === 5), images.find((i) => i.call === 4).steps);
    expect(out[0]).toMatchObject({ status: 'rolled_back' });
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['a:08:00']);
  });

  test('a crash right after the last undo: nothing is written again and the day closes', async () => {
    const { w, images, crash } = crashImages();
    await w.run();
    const done = { rows: w.db.rows.map((r) => ({ ...r })), steps: w.db.plans[0].apply_steps, call: 99 };
    const out = await crash(done, JSON.stringify({ ...JSON.parse(done.steps), steps: JSON.parse(done.steps).steps.map((s) => ({ ...s, undo: undefined })) }));
    expect(out[0]).toMatchObject({ status: 'rolled_back' });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(images.length).toBeGreaterThan(0);
  });

  test('a person moves a visit between the crash and the recovery: that one is refused, the rest go back', async () => {
    const { w, images, crash } = crashImages();
    await w.run();
    const image = images.find((i) => i.call === 4);
    image.rows.find((r) => r.id === 'a').window_start = '15:00:00';
    image.rows.find((r) => r.id === 'a').window_end = '16:00:00';
    const out = await crash(image);
    expect(out[0]).toMatchObject({ status: 'failed' });
    expect(w.rebooker.calls.map((c) => c.id)).toEqual(['b']);
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
  });
});

describe('the reminders after an undo', () => {
  const etTime = (hhmm) => parseETDateTime(`${DATE}T${hhmm}`);

  test('an undo that landed and stopped before its sync is re-synced to the visit\'s final hour', async () => {
    let n = 0;
    const w = world({
      visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('12:00'), cancelled: false }, { scheduled_service_id: 'b', appointment_time: etTime('09:00'), cancelled: false }],
      rebookerOpts: { failWhen: () => { n += 1; return n === 2; } },
    });
    // The rebooker moves the visit; the (mocked) sync of the undo does not run, as after a crash: a's reminder still names 12:00.
    w.syncMovedReminders.mockImplementation(async (service, best) => {
      if (best.start_time === '08:00') return;
    });
    const out = await w.run();
    expect(out.status).toBe('rolled_back');
    const synced = w.syncMovedReminders.mock.calls.map(([service, best]) => `${service.id}:${best.start_time}`);
    // The undo sync did run once through the normal path, and the reconcile then found a's reminder still at 12:00.
    expect(synced.filter((x) => x === 'a:08:00').length).toBeGreaterThanOrEqual(2);
    expect(synced).not.toContain('b:13:00');
  });

  test('a reminder that already matches is left alone, and a cancelled one too', async () => {
    const w = world({
      visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('08:00'), cancelled: false }, { scheduled_service_id: 'b', appointment_time: etTime('15:00'), cancelled: true }],
    });
    await reconcile(w, ['a', 'b']);
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });

  test('a visit that is stuck on a person\'s change is never synced', async () => {
    const w = world({
      visits: [['a', 8]], changes: [['a', 8, 12]],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('12:00'), cancelled: false }],
    });
    await reconcile(w, ['a'], new Set(['a']));
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });

  test('a recovered complete day re-syncs a reminder that a crash cut short', async () => {
    const w = world({
      visits: [['a', 8]], changes: [['a', 8, 12]],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('08:00'), cancelled: false }],
    });
    w.db.rows.find((r) => r.id === 'a').window_start = '12:00:00';
    w.db.rows.find((r) => r.id === 'a').window_end = '13:00:00';
    w.db.plans[0] = {
      id: 'plan-1', service_date: DATE, technician_id: TECH, apply_status: null, apply_started_at: '2026-11-04T04:41:00Z',
      apply_steps: JSON.stringify({ version: 1, routeBefore: {}, routeAfter: {}, complete: true, steps: [{ id: 'a', fromStart: H(8), toStart: H(12), widthMin: 60, state: 'done' }] }),
    };
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0]).toMatchObject({ status: 'applied' });
    expect(w.syncMovedReminders.mock.calls.map(([s, best]) => `${s.id}:${best.start_time}`)).toEqual(['a:12:00']);
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
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

describe('the validated snapshot pins every step', () => {
  // The rows change AFTER the fresh plan was made and BEFORE the write: the CAS is pinned on the plan's rows, so the
  // step is refused and the day goes back, instead of the writer pinning whatever it reads next.
  const changedAfterPlan = (mutate) => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]] });
    return { w, run: () => w.run({ replan: async () => { mutate(w.db.rows); return w.fresh; } }) };
  };

  test.each([
    ['a window end edited since', (rows) => { rows.find((r) => r.id === 'b').window_end = '10:30:00'; }],
    ['a technician changed since', (rows) => { rows.find((r) => r.id === 'b').technician_id = 'tech-9'; }],
    ['a location edited since', (rows) => { rows.find((r) => r.id === 'b').lat += 0.5; }],
    ['a property changed since', (rows) => { rows.find((r) => r.id === 'b').property_id = 'prop-9'; }],
    ['a confirmation landed since', (rows) => { rows.find((r) => r.id === 'b').customer_confirmed = true; }],
  ])('%s: refused by the CAS, the earlier step is undone', async (_label, mutate) => {
    const { w, run } = changedAfterPlan(mutate);
    const out = await run();
    expect(out).toMatchObject({ status: 'rolled_back', reason: 'step_failed:CAS_MISS' });
    // a was written, then b was refused, then a was put back.
    expect(w.rebooker.calls.map((c) => `${c.id}:${c.win.start}`)).toEqual(['a:12:00', 'b:13:00', 'a:08:00']);
    expect(w.windows().a).toBe('08:00');
  });

  test('the CAS carries the snapshot\'s window end, not the planned width', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]] });
    await w.run();
    for (const call of w.rebooker.calls) expect(call.options.expect.window_end).toBe(`${String(toMin(call.options.expect.window_start.slice(0, 5)) / 60 + 1).padStart(2, '0')}:00:00`);
  });

  test('the snapshot advances only by this writer\'s own steps (a visit moved twice is not refused)', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]] });
    expect((await w.run()).status).toBe('applied');
    const aCalls = w.rebooker.calls.filter((c) => c.id === 'a');
    expect(aCalls).toHaveLength(2);
    // The second step expects the hour the first step wrote.
    expect(aCalls[1].options.expect.window_start).toBe(`${aCalls[0].win.start}:00`);
  });
});

describe('the accepted route order', () => {
  const numbered = { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 }, d: { route_order: 4 } };
  const plan4 = () => world({
    visits: [['a', 8], ['b', 9], ['c', 10], ['d', 11]], changes: [['a', 8, 12], ['b', 9, 13]], rowExtra: numbered,
  });
  const orderOf = (w) => w.db.rows.filter((r) => r.technician_id === TECH).sort((x, y) => x.route_order - y.route_order).map((r) => r.id);

  test('is written under the scheduling fence (occupancy lock, then the tech-day lock) and verified', async () => {
    const w = plan4();
    expect((await w.run()).status).toBe('applied');
    // Final hours: c 10, d 11, a 12, b 13.
    expect(orderOf(w)).toEqual(['c', 'd', 'a', 'b']);
    expect(w.db.rows.map((r) => r.route_order).sort()).toEqual([1, 2, 3, 4]);
    expect(w.acquireOccupancyLock).toHaveBeenCalledWith(expect.anything(), DATE);
    expect(w.lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: TECH, date: DATE }]);
    expect(w.acquireOccupancyLock.mock.invocationCallOrder[0]).toBeLessThan(w.lockTechDays.mock.invocationCallOrder[0]);
    expect(w.journal()).toMatchObject({ routePersisted: true, complete: true });
  });

  test('a stop that joined the technician\'s day since the plan fails the write and the day goes back, numbers included', async () => {
    const w = plan4();
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      const out = await original(...args);
      if (args[0] === 'b' && !w.db.rows.some((r) => r.id === 'late')) w.db.rows.push(row('late', 0.01, 16, { technician_id: TECH }));
      return out;
    });
    const out = await w.run();
    expect(out).toMatchObject({ status: 'rolled_back', reason: 'step_failed:ROUTE_CHANGED' });
    expect(w.windows()).toMatchObject({ a: '08:00', b: '09:00', c: '10:00', d: '11:00' });
    expect(Object.fromEntries(w.db.rows.filter((r) => numbered[r.id]).map((r) => [r.id, r.route_order]))).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  test('a stop off its planned hour at the fence fails the write', async () => {
    const w = plan4();
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      const out = await original(...args);
      if (args[0] === 'b') w.db.rows.find((r) => r.id === 'c').window_start = '15:00:00';
      return out;
    });
    expect((await w.run()).reason).toBe('step_failed:ROUTE_CHANGED');
  });

  test.each([
    ['its status changed', (d) => { d.status = 'pending'; }],
    ['it was confirmed by the customer', (d) => { d.customer_confirmed = true; }],
    ['staff locked it', (d) => { d.auto_dispatch_locked = true; }],
    ['its location was edited', (d) => { d.lat += 0.5; d.raw_lat += 0.5; }],
    ['it was put in a visit record', (d) => { d.visit_id = 'visit-9'; }],
    ['it was edited in a way only its version shows', (d) => { d.updated_at = new Date('2026-11-03T12:30:00Z'); }],
    ['it was given a hold', (d) => { d.reservation_expires_at = new Date('2099-01-01T00:00:00Z'); }],
  ])('an unrelated stop of the same day changed at the fence (%s): no route write, the day is rolled back', async (_label, mutate) => {
    const w = plan4();
    w.lockTechDays.mockImplementationOnce(async () => { mutate(w.db.rows.find((r) => r.id === 'd')); });
    const before = w.db.rows.map((r) => r.route_order);
    const out = await w.run();
    expect(out).toMatchObject({ status: 'rolled_back', reason: 'step_failed:ROUTE_CHANGED' });
    expect(w.windows()).toMatchObject({ a: '08:00', b: '09:00', c: '10:00', d: '11:00' });
    expect(w.db.rows.map((r) => r.route_order)).toEqual(before);
    expect(w.journal().routePersisted).toBe(false);
  });

  test('so is a visit this writer moved that a person changed after its step', async () => {
    const w = plan4();
    w.lockTechDays.mockImplementationOnce(async () => { w.db.rows.find((r) => r.id === 'a').auto_dispatch_excluded = true; });
    const before = w.db.rows.map((r) => r.route_order);
    // The fence refuses the route write; the rollback then leaves the person's visit alone (and so says failed).
    expect(await w.run()).toMatchObject({ status: 'failed', reason: 'rollback_failed:DIVERGED' });
    expect(w.db.rows.map((r) => r.route_order)).toEqual(before);
    expect(w.windows().a).toBe('12:00');
    expect(w.windows().b).toBe('09:00');
  });

  test('every step, forward, temporary and undo, leaves the route numbers to the one final write (placeInRoute false)', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]], rowExtra: { a: { route_order: 1 }, b: { route_order: 2 } } });
    let calls = 0;
    expect((await w.run()).status).toBe('applied');
    expect(w.rebooker.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of w.rebooker.calls) expect(c.options.placeInRoute).toBe(false);
    const f = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]], rebookerOpts: { failWhen: () => { calls += 1; return calls === 2; } } });
    expect((await f.run()).status).toBe('rolled_back');
    expect(f.rebooker.calls.length).toBe(3);
    for (const c of f.rebooker.calls) expect(c.options.placeInRoute).toBe(false);
  });

  test('a final route the app would not read as a real plan is refused before any write', async () => {
    const w = plan4();
    w.fresh.result.best.order = [...w.fresh.result.best.order].reverse(); // a later promise numbered ahead of an earlier one
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'route_order_not_coherent', moved: 0 });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('so is a route the app\'s simulator does not give the planned figures for', async () => {
    const w = plan4();
    w.fresh.check.planned = { ...w.fresh.check.planned, driveMin: w.fresh.check.planned.driveMin + 5 };
    expect((await w.run()).reason).toBe('route_order_not_coherent');
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });
});

describe('the journal', () => {
  test('records the day before the first write and every step as intent then done', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]], rowExtra: { a: { route_order: 1 }, b: { route_order: 2 } } });
    const seen = [];
    const original = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (...args) => {
      // At the moment of each write the journal already holds that step as an intent.
      const j = JSON.parse(w.db.plans[0].apply_steps);
      seen.push({ started: !!w.db.plans[0].apply_started_at, last: j.steps.at(-1) });
      return original(...args);
    });
    expect((await w.run()).status).toBe('applied');
    expect(seen).toHaveLength(3);
    seen.forEach((s, i) => expect(s).toMatchObject({ started: true, last: { state: 'intent', temp: i === 0 } }));
    const journal = w.journal();
    expect(journal.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(journal.routeBefore).toEqual({ a: 1, b: 2 });
    // Ids and minutes only.
    expect(JSON.stringify(journal)).not.toMatch(/cust-|Test Ln|@/);
  });

  test('a day whose journal cannot be written is not started', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 12], ['b', 9, 13]] });
    w.db.plans.length = 0; // no plan row to journal on
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'journal_unwritable', moved: 0 });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a reminder is synced only when a visit lands its FINAL hour, never for a temporary one', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]] });
    await w.run();
    const synced = w.syncMovedReminders.mock.calls.map(([service, best]) => `${service.id}:${best.start_time}`).sort();
    expect(synced).toEqual(['a:09:00', 'b:08:00']);
  });

  test('a rollback does not sync a reminder to a temporary hour either', async () => {
    let n = 0;
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]], rebookerOpts: { failWhen: () => { n += 1; return n === 3; } } });
    expect((await w.run()).status).toBe('rolled_back');
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00' });
    const temp = w.rebooker.calls[0].win.start;
    // Reminders were synced for the b step (08:00) and the rollback landings (09:00, 08:00): never for the parking hour.
    for (const [, best] of w.syncMovedReminders.mock.calls) expect(best.start_time).not.toBe(temp);
  });
});

describe('recovering an interrupted day', () => {
  /** A swap that stopped after parking a at 10:00: the journal says so, the table shows a at the parking hour. */
  function interruptedWorld({ done = true, complete = false } = {}) {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [['a', 8, 9], ['b', 9, 8]], rowExtra: { a: { route_order: 1 }, b: { route_order: 2 } } });
    // The step as the crashed process journaled it: the visit's fingerprint before and after (the rows as they were).
    const step = { id: 'a', fromStart: H(8), toStart: H(10), widthMin: 60, temp: true, state: done ? 'done' : 'intent' };
    const original = { ...w.db.rows.find((r) => r.id === 'a') };
    step.before = applyInternals.fingerprintOf(original, w.deps);
    step.after = applyInternals.fingerprintOf(applyInternals.afterStep(original, step), w.deps);
    if (!complete) {
      const a = w.db.rows.find((r) => r.id === 'a');
      a.window_start = done ? '10:00:00' : '08:00:00';
      a.window_end = done ? '11:00:00' : '09:00:00';
    }
    w.db.rows.find((r) => r.id === 'a').route_order = 7;
    w.db.plans[0] = {
      id: 'plan-1', service_date: DATE, technician_id: TECH, apply_status: null, apply_started_at: '2026-11-04T04:41:00Z',
      apply_steps: JSON.stringify({ version: 1, routeBefore: { a: 1, b: 2 }, routeAfter: { a: 7 }, routePersisted: false, complete, steps: [step] }),
    };
    return w;
  }

  test('finds only plans that were started and have no outcome', async () => {
    const w = interruptedWorld();
    w.db.plans.push({ id: 'p2', apply_started_at: '2026-11-03T04:41:00Z', apply_status: 'applied' }, { id: 'p3', apply_started_at: null, apply_status: null });
    expect((await findInterrupted(w.conn)).map((p) => p.id)).toEqual(['plan-1']);
  });

  test('a visit left on a temporary hour goes back, its route numbers too, with one notice for Claude', async () => {
    const w = interruptedWorld();
    const plans = await findInterrupted(w.conn);
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans });
    expect(out).toEqual([expect.objectContaining({ id: 'plan-1', status: 'rolled_back', reason: 'recovered_after_interruption' })]);
    expect(w.windows().a).toBe('08:00');
    expect(w.db.rows.find((r) => r.id === 'a').route_order).toBe(1);
    expect(w.db.plans[0]).toMatchObject({ apply_status: 'rolled_back', apply_reason: 'recovered_after_interruption' });
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = w.raiseAlert.mock.calls[0];
    expect(spec.who).toBe('claude');
    expect(spec.why).toMatch(/put back to their old times/);
    expect(w.raiseAlert.mock.calls[0][1].action).toMatch(/interrupted/);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(opts.metadata.feed).toBe('activity');
    // The undo is a normal write: initiator day_replan, no 24-hour recheck, and no reminder synced to the parking hour.
    expect(w.rebooker.calls).toHaveLength(1);
    expect([w.rebooker.calls[0].reason, w.rebooker.calls[0].by]).toEqual(['day_replan', 'day_replan']);
  });

  test('a step that never landed needs no move, and the plan still closes', async () => {
    const w = interruptedWorld({ done: false });
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0].status).toBe('rolled_back');
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a day whose journal says it was complete is only recorded as applied, with no move and no notice', async () => {
    const w = interruptedWorld({ complete: true });
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0]).toMatchObject({ status: 'applied', reason: 'applied_recovered' });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(w.raiseAlert).not.toHaveBeenCalled();
    expect(w.db.plans[0]).toMatchObject({ apply_status: 'applied' });
  });

  test('a rollback that crashed after completion is resumed, never recorded as applied', async () => {
    const w = interruptedWorld({ complete: true });
    const j = JSON.parse(w.db.plans[0].apply_steps);
    w.db.plans[0].apply_steps = JSON.stringify({ ...j, rollback: true });
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0].status).toBe('rolled_back');
    expect(w.windows().a).toBe('08:00');
  });

  test('a rollback clears the completion marker before its first undo', async () => {
    const w = interruptedWorld({ complete: true });
    const journal = JSON.parse(w.db.plans[0].apply_steps);
    await applyInternals.rollBack(w.conn, w.deps, { dateStr: DATE, journal, planId: 'plan-1' });
    expect(journal).toMatchObject({ rollback: true, complete: false });
    expect(JSON.parse(w.db.plans[0].apply_steps)).toMatchObject({ rollback: true, complete: false });
  });

  test('a visit a person moved meanwhile is left alone: failed, with the notice that says so', async () => {
    const w = interruptedWorld();
    w.db.rows.find((r) => r.id === 'a').window_start = '14:00:00';
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0]).toMatchObject({ status: 'failed' });
    expect(out[0].reason).toMatch(/^rollback_failed:DIVERGED/);
    expect(w.windows().a).toBe('14:00');
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
    expect(w.raiseAlert.mock.calls[0][1].why).toMatch(/could not be put back/);
    expect(w.db.plans[0].apply_status).toBe('failed');
  });

  test('an unreadable journal is a failed day with a notice, never a throw', async () => {
    const w = interruptedWorld();
    w.db.plans[0].apply_steps = '{not json';
    const out = await recoverInterrupted({ conn: w.conn, deps: w.deps, plans: await findInterrupted(w.conn) });
    expect(out[0].status).toBe('failed');
    expect(w.raiseAlert).toHaveBeenCalledTimes(1);
  });
});
