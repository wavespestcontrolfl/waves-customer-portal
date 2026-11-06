/**
 * The day re-plan APPLY writer (services/day-replan/apply.js): ONE transaction per tech-day, under the app's
 * scheduling fence. Re-validates under the locks, writes the hours, the log rows and the route numbers together,
 * checks the final state with the app's occupancy predicate, and syncs reminders only after the commit. In-memory
 * schedule (rolls back like a transaction); synthetic ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [] }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60, violatesPreferredTime: jest.fn(), _internals: { isSaturday: jest.fn(), isWeekendDay: jest.fn() },
}));

const { applyAcceptedDay, reconcileApplied, INITIATOR, REASON_CODE, _internals: applyInternals } = require('../services/day-replan/apply');
const logger = require('../services/logger');
const { parseETDateTime } = require('../utils/datetime-et');
const { HQ, row, makeDb, makeApplyDeps } = require('./helpers/day-replan-db');
const { _internals } = require('../services/day-replan');
const { withHour, appSimCheck } = require('../services/day-replan/app-sim');

const DATE = '2026-11-04';
const TECH = 'tech-1';
const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET on Nov 3; DST has ended
const H = (h) => h * 60;
const env = { techBlind: true, openMin: H(8), closeMin: H(17), departureMin: H(8) };
const toMin = (v) => { const [h, m] = String(v).slice(0, 5).split(':').map(Number); return h * 60 + m; };

/** A tech-day of one-hour visits at the given [id, hour] pairs plus an accepted plan that re-times some of them. */
function world({ visits, changes, rowExtra = {}, reminders = [], blocks = [], over = {}, now = NOW }) {
  const rows = visits.map(([id, hour]) => row(id, 0.01, hour, { ...(rowExtra[id] || {}) }));
  const { conn, db } = makeDb({ rows, reminders });
  db.plans.push({ id: 'plan-1', apply_status: null });
  const { deps, mocks } = makeApplyDeps(db, { now, blocks, over });
  const planChanges = changes.map(([id, from, to]) => ({ id, fromMin: H(from), toMin: H(to) }));
  // The fresh plan, made coherent: the tech's stops in the order of their final hours, and the app simulation's
  // figures for exactly that route (what the planner's check would hold).
  const techRows = rows.filter((r) => r.technician_id === TECH);
  const finalStart = (r) => (planChanges.find((c) => c.id === r.id) ? planChanges.find((c) => c.id === r.id).toMin : toMin(r.window_start));
  const ordered = [...techRows].sort((a, b) => finalStart(a) - finalStart(b) || a.id.localeCompare(b.id));
  const finalGroups = ordered.map((r) => [planChanges.find((c) => c.id === r.id) ? withHour(r, finalStart(r)) : r]);
  const origin = { lat: HQ.lat, lng: HQ.lng };
  const planned = appSimCheck({ groups: finalGroups, baselineOrder: ordered.map((r) => r.id), best: null, origin, departureMin: env.departureMin, marginMin: 15 }).current;
  const hash = _internals.versionHash(rows);
  const fresh = {
    verdict: { accepted: true },
    hash,
    origin,
    check: { planned },
    result: { changes: planChanges, best: { order: ordered.map((r) => r.id) } },
    stops: techRows.map((r) => ({
      id: r.id, slotWidthMin: r.window_end ? toMin(r.window_end) - toMin(r.window_start) : (Number(r.estimated_duration_minutes) || 60), openEnd: !r.window_end, workMin: 30, pref: null,
    })),
    rowGroups: techRows.map((r) => [{ ...r }]),
    // The rows as the fresh plan read them (a copy: the live table moves on without them).
    dayContext: { allRows: rows.map((r) => ({ ...r })) },
    blocks,
  };
  const plan = { hash, result: { changes: planChanges } };
  const run = (overrides = {}) => applyAcceptedDay({ conn, env, dateStr: DATE, techId: TECH, plan, deps, replan: async () => fresh, ...overrides });
  const windows = () => Object.fromEntries(db.rows.filter((r) => r.technician_id === TECH).map((r) => [r.id, String(r.window_start).slice(0, 5)]));
  const routeOrders = () => Object.fromEntries(db.rows.map((r) => [r.id, r.route_order]));
  const logRows = () => db.inserts.filter((i) => i.table === 'reschedule_log').map((i) => i.row);
  const rowWrites = () => db.updates.filter((u) => u.table === 'scheduled_services');
  return { db, conn, deps, ...mocks, fresh, plan, run, windows, routeOrders, logRows, rowWrites, rows };
}

const numbered = { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 }, d: { route_order: 4 } };
const plan4 = (over = {}) => world({ visits: [['a', 8], ['b', 9], ['c', 10], ['d', 11]], changes: [['a', 8, 12], ['b', 9, 13]], rowExtra: numbered, ...over });
const swap = (over = {}) => world({ visits: [['a', 8], ['b', 9], ['c', 10], ['d', 11]], changes: [['a', 8, 9], ['b', 9, 8]], rowExtra: numbered, ...over });

beforeEach(() => jest.clearAllMocks());

describe('writing an accepted plan', () => {
  test('moves every changed visit to its planned hour and numbers the whole day, in one transaction', async () => {
    const w = plan4();
    const spy = jest.spyOn(w.conn, 'transaction');
    const out = await w.run();
    expect(out).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.windows()).toEqual({ a: '12:00', b: '13:00', c: '10:00', d: '11:00' });
    // Final hours: c 10, d 11, a 12, b 13.
    expect(w.routeOrders()).toEqual({ c: 1, d: 2, a: 3, b: 4 });
    expect(INITIATOR).toBe('day_replan');
    expect(REASON_CODE.length).toBeLessThanOrEqual(30);
  });

  test('a swap (a cycle) is written directly: no temporary hour is ever written', async () => {
    const w = swap();
    expect((await w.run()).status).toBe('applied');
    expect(w.windows()).toEqual({ a: '09:00', b: '08:00', c: '10:00', d: '11:00' });
    const starts = w.rowWrites().map((u) => u.patch.window_start).filter(Boolean);
    expect(starts.sort()).toEqual(['08:00', '09:00']);
    // Two writes for two moved visits; the rest are the route numbers.
    expect(w.rowWrites().filter((u) => 'window_start' in u.patch)).toHaveLength(2);
  });

  test('writes the window, the track-token expiry and the change time of each moved visit, and only those columns', async () => {
    const w = plan4();
    await w.run();
    const moved = w.rowWrites().filter((u) => 'window_start' in u.patch);
    expect(moved).toHaveLength(2);
    for (const u of moved) expect(Object.keys(u.patch).sort()).toEqual(['track_token_expires_at', 'updated_at', 'window_end', 'window_start']);
    expect(w.trackTokenExpiry).toHaveBeenCalledWith(expect.anything(), DATE, '13:00');
    const others = w.rowWrites().filter((u) => !('window_start' in u.patch));
    for (const u of others) expect(Object.keys(u.patch)).toEqual(['route_order']);
  });

  test('one reschedule_log row per moved visit, in the rebooker\'s same-day shape, as day_replan', async () => {
    const w = plan4({ rowExtra: { ...numbered, a: { route_order: 1, service_id: 'svc-1', property_id: 'prop-1' } } });
    await w.run();
    const logs = w.logRows();
    expect(logs).toHaveLength(2);
    const a = logs.find((l) => l.scheduled_service_id === 'a');
    expect(a).toEqual({
      scheduled_service_id: 'a', customer_id: 'cust-a', original_date: DATE, new_date: DATE, reason_code: 'day_replan', initiated_by: 'day_replan',
      original_window: '08:00:00-09:00:00', new_window: '12:00-13:00',
      occurrence_service_type: 'Quarterly Pest Control Service', occurrence_service_id: 'svc-1', occurrence_property_id: 'prop-1',
    });
    expect(logs.every((l) => l.reason_code === 'day_replan' && l.initiated_by === 'day_replan')).toBe(true);
  });

  test('takes the fence in the ordering contract\'s order: the date lock, the tech-day locks, then the row locks', async () => {
    const w = plan4();
    await w.run();
    expect(w.acquireOccupancyLock).toHaveBeenCalledWith(expect.anything(), DATE);
    expect(w.lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: TECH, date: DATE }, { techId: null, date: DATE }]);
    const order = (fn) => fn.mock.invocationCallOrder[0];
    expect(order(w.acquireOccupancyLock)).toBeLessThan(order(w.lockTechDays));
    expect(order(w.lockTechDays)).toBeLessThan(order(w.lockDayRows));
    expect(order(w.lockDayRows)).toBeLessThan(order(w.deps.loadDayRows));
  });

  test('reminders and the after-move effects run after the commit, at the final hours, once per visit', async () => {
    const w = plan4();
    const seen = [];
    w.syncMovedReminders.mockImplementation(async (service, best) => { seen.push({ id: service.id, best, hours: w.windows() }); });
    await w.run();
    expect(seen.map((s) => `${s.id}:${s.best.start_time}-${s.best.end_time}`).sort()).toEqual(['a:12:00-13:00', 'b:13:00-14:00']);
    // By the time a reminder is synced the hours are written.
    expect(seen[0].hours).toEqual({ a: '12:00', b: '13:00', c: '10:00', d: '11:00' });
    expect(w.afterMoveEffects).toHaveBeenCalledTimes(1);
    expect(w.afterMoveEffects.mock.calls[0][1]).toMatchObject({ dateStr: DATE, written: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })] });
  });

  test('a failed after-commit step is logged and does not undo or fail the day', async () => {
    const w = plan4();
    w.syncMovedReminders.mockRejectedValueOnce(new Error('reminders down'));
    w.afterMoveEffects.mockRejectedValue(new Error('effects down'));
    expect(await w.run()).toMatchObject({ status: 'applied', moved: 2 });
    expect(w.windows().a).toBe('12:00');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a plan that changes no hour writes nothing', async () => {
    const w = world({ visits: [['a', 8], ['b', 9]], changes: [] });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'no_hour_changes', moved: 0 });
    expect(w.db.updates).toEqual([]);
    expect(w.acquireOccupancyLock).not.toHaveBeenCalled();
  });

  test('a day that cannot be read again, or a stale plan, is skipped before any lock', async () => {
    const w = plan4();
    expect(await w.run({ replan: async () => { throw new Error('read failed'); } })).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(await w.run({ replan: async () => null })).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(await w.run({ plan: { ...w.plan, hash: 'old' } })).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(w.acquireOccupancyLock).not.toHaveBeenCalled();
  });

  test('a blackout day is skipped (the rebooker\'s strict night-writer test)', async () => {
    const w = plan4();
    w.isBlackoutDate.mockResolvedValue(true);
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'blackout_date', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('a final route the app would not read as a real plan, or whose figures differ, is refused before any lock', async () => {
    const w = plan4();
    w.fresh.result.best.order = [...w.fresh.result.best.order].reverse();
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'route_order_not_coherent', moved: 0 });
    const v = plan4();
    v.fresh.check.planned = { ...v.fresh.check.planned, driveMin: v.fresh.check.planned.driveMin + 5 };
    expect((await v.run()).reason).toBe('route_order_not_coherent');
    expect(v.acquireOccupancyLock).not.toHaveBeenCalled();
  });

  test('a deadlock victim retries (twice at most) and then applies', async () => {
    const w = plan4();
    const err = Object.assign(new Error('deadlock'), { code: '40P01' });
    w.lockTechDays.mockRejectedValueOnce(err).mockRejectedValueOnce(err);
    expect((await w.run()).status).toBe('applied');
    const x = plan4();
    x.lockTechDays.mockRejectedValue(err);
    expect(await x.run()).toMatchObject({ status: 'failed', reason: 'write_failed:40P01', moved: 0 });
  });

  test('an unexpected error in the transaction changes nothing and is reported as failed', async () => {
    const w = plan4();
    w.deps.loadDayRows.mockRejectedValueOnce(new Error('boom'));
    const out = await w.run();
    expect(out).toMatchObject({ status: 'failed', moved: 0 });
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00', c: '10:00', d: '11:00' });
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });
});

describe('a change committed before the fence changes nothing', () => {
  // The edit lands between the unlocked read and the locks: the hooks run when the writer takes the row locks.
  const editAtFence = (w, mutate) => w.lockDayRows.mockImplementationOnce(async () => { mutate(w.db.rows); });
  const find = (rows, id) => rows.find((r) => r.id === id);

  test.each([
    ['a moved stop\'s status', (rows) => { find(rows, 'a').status = 'pending'; }],
    ['a moved stop\'s technician', (rows) => { find(rows, 'a').technician_id = 'tech-9'; }],
    ['a moved stop\'s hours', (rows) => { find(rows, 'a').window_start = '15:00:00'; find(rows, 'a').window_end = '16:00:00'; }],
    ['a moved stop\'s duration', (rows) => { find(rows, 'a').estimated_duration_minutes = 90; }],
    ['a moved stop\'s location', (rows) => { find(rows, 'a').lat += 0.5; find(rows, 'a').raw_lat += 0.5; }],
    ['a moved stop\'s visit record', (rows) => { find(rows, 'a').visit_id = 'visit-9'; }],
    ['an unmoved stop\'s duration', (rows) => { find(rows, 'd').estimated_duration_minutes = 90; }],
    ['an unmoved stop\'s version only', (rows) => { find(rows, 'd').updated_at = new Date('2026-11-03T12:30:00Z'); }],
    ['an unmoved stop\'s confirmation', (rows) => { find(rows, 'd').customer_confirmed = true; }],
    ['an unmoved stop\'s staff lock', (rows) => { find(rows, 'd').auto_dispatch_locked = true; }],
    ['an unmoved stop\'s location', (rows) => { find(rows, 'd').lat += 0.5; find(rows, 'd').raw_lat += 0.5; }],
    ['an unmoved stop\'s status', (rows) => { find(rows, 'd').status = 'pending'; }],
    ['a stop that joined the technician\'s day', (rows) => { rows.push(row('late', 0.01, 16, { technician_id: TECH })); }],
    ['an unassigned stop that joined the date', (rows) => { rows.push(row('late', 0.01, 16, { technician_id: null })); }],
    ['another technician\'s stop on the date', (rows) => { rows.push(row('late', 0.01, 16, { technician_id: 'tech-2' })); }],
    ['a stop that left the technician\'s day', (rows) => { find(rows, 'd').technician_id = 'tech-2'; }],
  ])('%s: nothing is written and the day is skipped as changed_since_plan', async (_label, mutate) => {
    const w = plan4();
    editAtFence(w, mutate);
    const before = w.routeOrders();
    const out = await w.run();
    expect(out).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
    expect(w.logRows()).toEqual([]);
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
    expect(w.afterMoveEffects).not.toHaveBeenCalled();
    // (the edit itself is the other writer's; our own columns are as they were)
    expect(Object.fromEntries(Object.entries(w.routeOrders()).filter(([id]) => before[id] !== undefined))).toEqual(before);
  });

  test('schedule blocks that changed since the plan', async () => {
    const w = plan4();
    w.deps.loadBlocks.mockResolvedValue([{ startMin: H(12), endMin: H(14) }]);
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'changed_since_plan', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('blocks the plan was made with are fine', async () => {
    const blocks = [{ startMin: H(15), endMin: H(16) }];
    const w = plan4({ blocks });
    expect((await w.run()).status).toBe('applied');
  });
});

describe('a moved visit must still be movable under the fence', () => {
  test('its 24-hour reminder went out meanwhile', async () => {
    const w = plan4();
    w.lockDayRows.mockImplementationOnce(async () => { w.db.reminders.push({ scheduled_service_id: 'b', reminder_24h_sent: true }); });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:reminder_24h_sent', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  // GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): the move transaction re-reads the told-lock facts.
  const recurring = { a: { route_order: 1, is_recurring: true, recurring_parent_id: 'p-a' }, b: { route_order: 2, is_recurring: true, recurring_parent_id: 'p-b' },
    c: { route_order: 3, is_recurring: true, recurring_parent_id: 'p-c' }, d: { route_order: 4, is_recurring: true, recurring_parent_id: 'p-d' } };
  const toldLockOver = (on) => ({ toldLockOn: () => on, isPersonPlacedVisit: jest.fn(async () => ({ placed: false })) });

  test('told-lock on: its 72-hour reminder went out meanwhile', async () => {
    const w = plan4({ rowExtra: recurring, over: toldLockOver(true) });
    w.lockDayRows.mockImplementationOnce(async () => { w.db.reminders.push({ scheduled_service_id: 'b', reminder_72h_sent: true }); });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:reminder_72h_sent', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('told-lock on: a person placed it meanwhile (an unreadable history counts as placed)', async () => {
    const over = toldLockOver(true);
    over.isPersonPlacedVisit = jest.fn(async () => ({ placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN' }));
    const w = plan4({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:person_placed', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('told-lock on: a pre-closed 72-hour placeholder does not stop the write', async () => {
    const w = plan4({ rowExtra: recurring, over: toldLockOver(true) });
    w.lockDayRows.mockImplementationOnce(async () => { w.db.reminders.push({ scheduled_service_id: 'b', reminder_72h_sent: true, windows_preclosed: true }); });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('told-lock off: a 72-hour reminder sent meanwhile changes nothing (today)', async () => {
    const w = plan4({ rowExtra: recurring, over: toldLockOver(false) });
    w.lockDayRows.mockImplementationOnce(async () => { w.db.reminders.push({ scheduled_service_id: 'b', reminder_72h_sent: true }); });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('its visit now has another live member', async () => {
    const w = plan4({ rowExtra: { ...numbered, a: { route_order: 1, visit_id: 'v-1' } } });
    // The hash cannot see a new mate, but the movability test reads the visit under the lock.
    w.lockDayRows.mockImplementationOnce(async () => { w.db.rows.push(row('mate', 0.5, 15, { technician_id: 'tech-2', visit_id: 'v-1', status: 'cancelled' })); });
    expect((await w.run()).status).toBe('applied'); // a cancelled mate is not live
    const x = plan4({ rowExtra: { ...numbered, a: { route_order: 1, visit_id: 'v-1' } } });
    x.fresh.dayContext.allRows.push({ ...row('mate', 0.5, 15, { technician_id: 'tech-2', visit_id: 'v-1' }) });
    x.db.rows.push(row('mate', 0.5, 15, { technician_id: 'tech-2', visit_id: 'v-1' }));
    x.fresh.hash = _internals.versionHash(x.db.rows);
    x.plan.hash = x.fresh.hash;
    expect(await x.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:grouped', moved: 0 });
  });

  test('the new hour is inside the 24-hour reach', async () => {
    // 09:00 ET on Nov 3: 08:00 on Nov 4 is 23 hours away.
    const w = plan4({ now: new Date('2026-11-03T14:00:00Z') });
    expect(await w.run()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/^visit_not_movable:/) });
    expect(w.rowWrites()).toEqual([]);
  });
});

describe('the final state must pass the occupancy predicate', () => {
  test('a clash at the new hour appearing at commit: nothing changes, hours and route numbers included', async () => {
    const w = plan4();
    // The probe runs after the writes: it sees a row that holds the hour (as a live hold of another writer would).
    w.findConflicts.mockImplementationOnce(async () => [{ id: 'hold-1' }]);
    const before = { windows: w.windows(), routes: w.routeOrders() };
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'slot_taken', moved: 0 });
    expect(w.windows()).toEqual(before.windows);
    expect(w.routeOrders()).toEqual(before.routes);
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });

  test('is judged on the final state: another moved visit at its new hour counts, and the probe is the app\'s own', async () => {
    const w = plan4();
    await w.run();
    expect(w.findConflicts).toHaveBeenCalledTimes(2);
    const first = w.findConflicts.mock.calls[0][0];
    expect(first).toMatchObject({ date: DATE, windowStart: '12:00', windowEnd: '13:00', excludeServiceIds: ['a'], technicianId: TECH });
    expect(first.excludeStatuses).toEqual(expect.arrayContaining(['cancelled', 'completed']));
    // Both moves are written before the first probe: a two-visit overlap would be seen.
    expect(w.findConflicts.mock.invocationCallOrder[0]).toBeGreaterThan(w.deps.loadDayRows.mock.invocationCallOrder[0]);
  });

  test('two moved visits landing on overlapping hours are refused (the real predicate over the written rows)', async () => {
    const w = world({ visits: [['a', 8], ['b', 9], ['c', 10]], changes: [['a', 8, 12], ['b', 9, 12]], rowExtra: { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 } } });
    expect(await w.run()).toMatchObject({ status: 'skipped', reason: 'slot_taken' });
    expect(w.windows()).toEqual({ a: '08:00', b: '09:00', c: '10:00' });
  });

  test('a failure while numbering the route rolls the hours back too', async () => {
    const w = plan4();
    // A stop that sits off its planned hour when the numbers are written.
    w.findConflicts.mockImplementationOnce(async () => { w.db.rows.find((r) => r.id === 'c').window_start = '15:00:00'; return []; });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'route_changed', moved: 0 });
    expect(w.windows().a).toBe('08:00');
    expect(w.routeOrders()).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });
});

describe('a visit with no booked end', () => {
  // a: 08:00, no end, 90 minutes. It moves to 12:00 and must stay open-ended; it holds two hours.
  const openWorld = (over = {}) => world({
    visits: [['a', 8], ['b', 10]], changes: [['a', 8, 12]], rowExtra: { a: { window_end: null, estimated_duration_minutes: 90 } }, ...over,
  });

  test('keeps a NULL end through the move, logs only the start, and is probed on its estimated duration', async () => {
    const w = openWorld();
    expect((await w.run()).status).toBe('applied');
    const a = w.db.rows.find((r) => r.id === 'a');
    expect([a.window_start, a.window_end]).toEqual(['12:00', null]);
    expect(w.logRows()[0]).toMatchObject({ original_window: '08:00:00', new_window: '12:00' });
    expect(w.findConflicts.mock.calls[0][0]).toMatchObject({ windowStart: '12:00', windowEnd: '13:30' });
    expect(w.trackTokenExpiry).toHaveBeenCalledWith(expect.anything(), DATE, null);
    // The reminder follows the start.
    expect(w.syncMovedReminders.mock.calls[0][1].start_time).toBe('12:00');
  });

  test('a visit sitting inside its 90-minute span is a clash', async () => {
    const w = world({
      visits: [['a', 8], ['b', 13]], changes: [['a', 8, 12]], rowExtra: { a: { window_end: null, estimated_duration_minutes: 90 } },
    });
    expect(await w.run()).toMatchObject({ status: 'skipped', reason: 'slot_taken' });
    const a = w.db.rows.find((r) => r.id === 'a');
    expect([a.window_start, a.window_end]).toEqual(['08:00:00', null]);
  });
});

describe('the pieces', () => {
  test('the duration is part of every fingerprint and of the whole signature', () => {
    const deps = { locationFields: ['property_id', 'lat', 'lng'] };
    const base = row('a', 0.01, 8);
    expect(applyInternals.fingerprintOf({ ...base, estimated_duration_minutes: 90 }, deps)).not.toBe(applyInternals.fingerprintOf(base, deps));
    expect(applyInternals.stopSignature({ ...base, updated_at: new Date('2026-11-04T00:00:00Z') }, deps)).not.toBe(applyInternals.stopSignature(base, deps));
  });
});

describe('repair of a committed day', () => {
  const etTime = (hhmm) => parseETDateTime(`${DATE}T${hhmm}`);
  const plansWith = (w, plans) => plans.forEach((p, i) => w.db.plans.push({ id: `p${i}`, apply_status: 'applied', applied_at: '2026-11-03T05:00:00Z', ...p }));

  test('a reminder that a crash left on the old hour is synced again, and the visit\'s records repaired', async () => {
    const w = world({
      visits: [['a', 12], ['b', 13]], changes: [],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('08:00'), cancelled: false }, { scheduled_service_id: 'b', appointment_time: etTime('13:00'), cancelled: false }],
    });
    plansWith(w, [{ service_date: DATE, changes: [{ id: 'a', from: '08:00', to: '12:00' }, { id: 'b', from: '09:00', to: '13:00' }] }]);
    expect(await reconcileApplied(w.conn, w.deps, { today: '2026-11-03' })).toBe(2);
    expect(w.syncMovedReminders.mock.calls.map(([s, best]) => `${s.id}:${best.start_time}`)).toEqual(['a:12:00']);
    expect(w.repairMoved.mock.calls.map((c) => c[1]).sort()).toEqual(['a', 'b']);
  });

  test('plans of past days, plans not applied, and a deps getter that is only used when there is work', async () => {
    const w = world({ visits: [['a', 12]], changes: [] });
    plansWith(w, [{ service_date: '2026-11-01', changes: [{ id: 'a' }] }, { service_date: DATE, apply_status: 'skipped', changes: [{ id: 'a' }] }]);
    const getter = jest.fn(() => w.deps);
    expect(await reconcileApplied(w.conn, getter, { today: '2026-11-03' })).toBe(0);
    expect(getter).not.toHaveBeenCalled();
  });

  test('a failing read never throws', async () => {
    const w = world({ visits: [['a', 12]], changes: [] });
    const broken = () => { throw new Error('db down'); };
    expect(await reconcileApplied(broken, w.deps, { today: '2026-11-03' })).toBe(0);
  });

  test('a reminder that already matches, or is cancelled, is left alone', async () => {
    const w = world({
      visits: [['a', 8], ['b', 9]], changes: [],
      reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('08:00'), cancelled: false }, { scheduled_service_id: 'b', appointment_time: etTime('15:00'), cancelled: true }],
    });
    await applyInternals.reconcileReminders(w.conn, w.deps, { ids: ['a', 'b'] });
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });

  test('a visit in the skip set is not synced', async () => {
    const w = world({ visits: [['a', 8]], changes: [], reminders: [{ scheduled_service_id: 'a', appointment_time: etTime('12:00'), cancelled: false }] });
    await applyInternals.reconcileReminders(w.conn, w.deps, { ids: ['a'], skip: new Set(['a']) });
    expect(w.syncMovedReminders).not.toHaveBeenCalled();
  });
});
