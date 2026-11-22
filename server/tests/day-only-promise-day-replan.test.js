/**
 * GATE_DAY_ONLY_PROMISE on the nightly day re-plan (services/day-replan, owner 2026-11-05 "D2 a"): with
 * this gate on, the told lock reads the promise LEVEL: a stop told an hour (a known slot, or an unknown window) is
 * fixed (time_told); a stop told only the DAY is not. Since the owner's 2026-11-22 rule a time that is the customer's
 * own (customer_time) fixes a stop whatever it was told, and staff placement, a confirmation and a first or one-time
 * visit fix nothing. A failed level read fails CLOSED. Gate off: the known-slot told lock alone. Same harness as night-told-lock-day-replan
 * and day-replan-apply; the promise reader (told-visits) is mocked. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [] }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60, violatesPreferredTime: jest.fn(), _internals: { isSaturday: jest.fn(), isWeekendDay: jest.fn() },
}));
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn(), loadPromiseLevels: jest.fn() }));
jest.mock('../services/time-promise', () => ({
  ...jest.requireActual('../services/time-promise'),
  dayOnlyEligibility: jest.fn(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: true, level: 'none' }]))),
}));

const { loadToldVisitIds, loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const logger = require('../services/logger');
const { applyAcceptedDay } = require('../services/day-replan/apply');
const { _internals } = require('../services/day-replan');
const { HQ, row, makeDb, makeApplyDeps } = require('./helpers/day-replan-db');
const { withHour, appSimCheck } = require('../services/day-replan/app-sim');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; ET = UTC-5
const TOMORROW = '2026-11-04';
const TECH = 'tech-1';
const H = (h) => h * 60;
const env = { techBlind: true, openMin: H(8), closeMin: H(17), departureMin: H(8) };
const toMin = (v) => { const [h, m] = String(v).slice(0, 5).split(':').map(Number); return h * 60 + m; };

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DAY_ONLY_PROMISE;
  loadToldVisitIds.mockReset();
  loadToldVisitIds.mockResolvedValue(new Set());
  loadPromiseLevels.mockReset();
  loadPromiseLevels.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, 'none'])));
});
afterAll(() => { process.env = savedEnv; });

const levelsOf = (map) => async (_conn, ids) => new Map(ids.map((id) => [id, map[id] || 'none']));

describe('fixedReason with the promise-level context', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, told: new Set(), customerTime: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });
  const one = new Set(['s1']);

  test('a one-time visit told only the day (not in the told set) may move', () => {
    expect(_internals.fixedReason(stop({ is_recurring: false, recurring_parent_id: null }), base())).toBeNull();
  });

  test('an hour-told visit stays fixed time_told', () => {
    expect(_internals.fixedReason(stop(), base({ told: one }))).toBe('time_told');
  });

  test('a day-told visit whose time is the customer\'s own stays fixed: customer_time comes first', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: one }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ customerTime: one, told: one }))).toBe('customer_time');
  });

  test('the other reasons still hold for a day-told visit', () => {
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), base())).toBe('status');
    expect(_internals.fixedReason(stop(), base({ sent24: one }))).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ auto_dispatch_locked: true }), base())).toBe('staff_lock');
  });
});

describe('loadDayContext', () => {
  const dayRows = () => [
    { ...row('a', 0.30, 8), is_recurring: false, recurring_parent_id: null },
    { ...row('b', 0.02, 9), recurring_parent_id: 'p1' },
    { ...row('c', 0.31, 10), recurring_parent_id: 'p1' },
  ];
  const load = (rows = dayRows()) => {
    const { conn } = makeDb({ rows: rows.map((r) => ({ ...r, scheduled_date: TOMORROW })) });
    return _internals.loadDayContext(conn, TOMORROW, NOW);
  };

  test('this gate on: ONE bulk level read; hour -> told, day -> not told', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockImplementation(levelsOf({ a: 'day', b: 'hour' }));
    const ctx = await load();
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(loadPromiseLevels.mock.calls[0][1].sort()).toEqual(['a', 'b', 'c']);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect([...ctx.told]).toEqual(['b']);
    expect(ctx).not.toHaveProperty('dayTold');
    expect(_internals.fixedReason({ ...dayRows()[0], customer_confirmed: false }, ctx)).toBeNull();
    expect(_internals.fixedReason({ ...dayRows()[1], customer_confirmed: false }, ctx)).toBe('time_told');
  });

  test('this gate on: a failed level read keeps the whole day fixed (every row counts as hour)', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockRejectedValue(new Error('level read down'));
    const ctx = await load();
    expect([...ctx.told].sort()).toEqual(['a', 'b', 'c']);
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['time_told', 'time_told', 'time_told']);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('this gate off: the known-slot told set only (no level read)', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect([...ctx.told]).toEqual(['b']);
  });
});

describe('recheckVisit inside the move transaction (apply mode)', () => {
  const recurring = { a: { route_order: 1, is_recurring: true, recurring_parent_id: 'p-a' }, b: { route_order: 2, is_recurring: true, recurring_parent_id: 'p-b' },
    c: { route_order: 3, is_recurring: true, recurring_parent_id: 'p-c' }, d: { route_order: 4, is_recurring: true, recurring_parent_id: 'p-d' } };
  const oneTime = { a: { route_order: 1, recurring_parent_id: null }, b: { route_order: 2, recurring_parent_id: null }, c: { route_order: 3, recurring_parent_id: null }, d: { route_order: 4, recurring_parent_id: null } };

  function world({ rowExtra, over }) {
    const visits = [['a', 8], ['b', 9], ['c', 10], ['d', 11]];
    const changes = [['a', 8, 12], ['b', 9, 13]];
    const rows = visits.map(([id, hour]) => row(id, 0.01, hour, { ...(rowExtra[id] || {}) }));
    const { conn, db } = makeDb({ rows, reminders: [] });
    db.plans.push({ id: 'plan-1', apply_status: null });
    const { deps } = makeApplyDeps(db, { now: NOW, blocks: [], over });
    const planChanges = changes.map(([id, from, to]) => ({ id, fromMin: H(from), toMin: H(to) }));
    const techRows = rows.filter((r) => r.technician_id === TECH);
    const finalStart = (r) => (planChanges.find((c) => c.id === r.id) ? planChanges.find((c) => c.id === r.id).toMin : toMin(r.window_start));
    const ordered = [...techRows].sort((a, b) => finalStart(a) - finalStart(b) || a.id.localeCompare(b.id));
    const finalGroups = ordered.map((r) => [planChanges.find((c) => c.id === r.id) ? withHour(r, finalStart(r)) : r]);
    const origin = { lat: HQ.lat, lng: HQ.lng };
    const planned = appSimCheck({ groups: finalGroups, baselineOrder: ordered.map((r) => r.id), best: null, origin, departureMin: env.departureMin, marginMin: 15 }).current;
    const hash = _internals.versionHash(rows);
    const fresh = {
      verdict: { accepted: true }, hash, origin, check: { planned }, result: { changes: planChanges, best: { order: ordered.map((r) => r.id) } },
      stops: techRows.map((r) => ({ id: r.id, slotWidthMin: r.window_end ? toMin(r.window_end) - toMin(r.window_start) : 60, openEnd: !r.window_end, workMin: 30, pref: null })),
      rowGroups: techRows.map((r) => [{ ...r }]), dayContext: { allRows: rows.map((r) => ({ ...r })) }, blocks: [],
    };
    const plan = { hash, result: { changes: planChanges } };
    const run = () => applyAcceptedDay({ conn, env, dateStr: TOMORROW, techId: TECH, plan, deps, replan: async () => fresh });
    return { db, run, rowWrites: () => db.updates.filter((u) => u.table === 'scheduled_services') };
  }
  const deps = ({ dayOnly = true, levels = {}, customerTime = [] } = {}) => ({
    dayOnlyOn: () => dayOnly,
    loadCustomerTime: jest.fn(async (_conn, rows) => new Set(rows.map((r) => r.id).filter((id) => customerTime.includes(id)))),
    loadToldIds: jest.fn(async () => new Set()),
    loadPromiseLevels: jest.fn(levelsOf(levels)),
  });

  test('this gate on: a one-time visit told only the day is written', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.loadPromiseLevels).toHaveBeenCalled();
    expect(over.loadToldIds).not.toHaveBeenCalled();
  });

  test('this gate on: a day-told visit whose time is the customer\'s own stops the write (customer_time)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, customerTime: ['b'] });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:customer_time', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('this gate on: a visit told an hour meanwhile stops the write (time_told)', async () => {
    const over = deps({ levels: { a: 'day', b: 'hour' } });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:time_told', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('this gate on: a level read that throws fails closed (time_told), nothing written', async () => {
    const over = deps();
    over.loadPromiseLevels = jest.fn(async () => { throw new Error('level read down'); });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:time_told', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('this gate on: a one-time visit with no promise at all is written (no first_or_one_time lock any more)', async () => {
    const over = deps({ levels: {} });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('this gate off: the known-slot read and no level read', async () => {
    const over = deps({ dayOnly: false, levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.loadPromiseLevels).not.toHaveBeenCalled();
    expect(over.loadToldIds).toHaveBeenCalled();
  });

  test('applyDeps carries dayOnlyOn, loadPromiseLevels and loadCustomerTime, and no person-placed read', () => {
    const real = _internals.applyDeps();
    expect(typeof real.loadCustomerTime).toBe('function');
    expect(real).not.toHaveProperty('isPersonPlacedVisit');
    expect(typeof real.dayOnlyOn).toBe('function');
    expect(typeof real.loadPromiseLevels).toBe('function');
    expect(real.dayOnlyOn()).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(real.dayOnlyOn()).toBe(true);
  });
});
