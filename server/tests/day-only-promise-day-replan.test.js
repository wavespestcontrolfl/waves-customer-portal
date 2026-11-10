/**
 * GATE_DAY_ONLY_PROMISE on the nightly day re-plan (services/day-replan, owner 2026-11-05 "D2 a"): with the told-lock
 * AND this gate on, a stop the customer was told only the DAY for may change its hour inside that day: a first or
 * one-time visit and a person-placed visit told only the day are movable. A customer-confirmed stop, a stop told an
 * hour (a known slot, or an unknown window) and every other existing reason stay fixed. A failed level read fails
 * CLOSED. Gate off, or the told-lock off: PR 1's behavior, byte for byte. Same harness as night-told-lock-day-replan
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
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));

const { loadToldVisitIds, loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const { isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');
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
  delete process.env.GATE_NIGHT_TOLD_LOCK;
  delete process.env.GATE_DAY_ONLY_PROMISE;
  isPersonPlacedVisit.mockImplementation(async () => ({ placed: false }));
  loadToldVisitIds.mockReset();
  loadToldVisitIds.mockResolvedValue(new Set());
  loadPromiseLevels.mockReset();
  loadPromiseLevels.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, 'none'])));
});
afterAll(() => { process.env = savedEnv; });

const levelsOf = (map) => async (_conn, ids) => new Map(ids.map((id) => [id, map[id] || 'none']));

describe('fixedReason with the day-told context', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, told: new Set(), personPlaced: new Set(), dayTold: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });
  const day = new Set(['s1']);

  test('a first or one-time visit told only the day may move; without the day mark it is first_or_one_time', () => {
    const first = stop({ is_recurring: false, recurring_parent_id: null });
    expect(_internals.fixedReason(first, base({ dayTold: day }))).toBeNull();
    expect(_internals.fixedReason(first, base())).toBe('first_or_one_time');
  });

  test('a person-placed visit told only the day may move; without the day mark it is person_placed', () => {
    expect(_internals.fixedReason(stop(), base({ dayTold: day, personPlaced: new Set(['s1']) }))).toBeNull();
    expect(_internals.fixedReason(stop(), base({ personPlaced: new Set(['s1']) }))).toBe('person_placed');
  });

  test('a customer-confirmed day-told visit stays fixed (conservative)', () => {
    expect(_internals.fixedReason(stop({ customer_confirmed: true }), base({ dayTold: day }))).toBe('customer_confirmed');
  });

  test('an hour-told visit stays fixed time_told; the day mark does not outrank an hour', () => {
    expect(_internals.fixedReason(stop(), base({ told: new Set(['s1']) }))).toBe('time_told');
    expect(_internals.fixedReason(stop(), base({ told: new Set(['s1']), dayTold: day }))).toBe('time_told');
  });

  test('the other reasons still hold for a day-told visit', () => {
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), base({ dayTold: day }))).toBe('status');
    expect(_internals.fixedReason(stop(), base({ dayTold: day, sent24: day }))).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ auto_dispatch_locked: true }), base({ dayTold: day }))).toBe('staff_lock');
  });

  test('a visit with level none keeps today\'s rules', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: false }), base())).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop(), base({ personPlaced: new Set(['s1']) }))).toBe('person_placed');
  });

  test('no dayTold in the context (gate off): PR 1 behavior', () => {
    const { dayTold, ...pr1 } = base({ personPlaced: new Set(['s1']) });
    expect(dayTold).toBeDefined();
    expect(_internals.fixedReason(stop(), pr1)).toBe('person_placed');
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

  test('both gates on: ONE bulk level read; hour -> told, day -> dayTold', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockImplementation(levelsOf({ a: 'day', b: 'hour' }));
    const ctx = await load();
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(loadPromiseLevels.mock.calls[0][1].sort()).toEqual(['a', 'b', 'c']);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.dayTold]).toEqual(['a']);
    expect(_internals.fixedReason({ ...dayRows()[0], customer_confirmed: false }, ctx)).toBeNull();
    expect(_internals.fixedReason({ ...dayRows()[1], customer_confirmed: false }, ctx)).toBe('time_told');
  });

  test('both gates on: a failed level read keeps the whole day fixed (every row counts as hour)', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockRejectedValue(new Error('level read down'));
    const ctx = await load();
    expect([...ctx.told].sort()).toEqual(['a', 'b', 'c']);
    expect(ctx.dayTold.size).toBe(0);
    // Every row stays fixed: the one-time row by its existing reason (it comes first), the recurring rows by time_told.
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['first_or_one_time', 'time_told', 'time_told']);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('the told-lock alone: PR 1 exactly (known-slot told set, no dayTold, no level read)', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect([...ctx.told]).toEqual(['b']);
    expect(ctx).not.toHaveProperty('dayTold');
  });

  test('this gate alone (told-lock off): nothing is read, no told-lock facts', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect(ctx.toldLock).toBeUndefined();
    expect(ctx.dayTold).toBeUndefined();
  });

  test('both gates off: nothing is read', async () => {
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(ctx.told).toBeUndefined();
  });
});

describe('recheckVisit inside the move transaction (apply mode)', () => {
  const recurring = { a: { route_order: 1, is_recurring: true, recurring_parent_id: 'p-a' }, b: { route_order: 2, is_recurring: true, recurring_parent_id: 'p-b' },
    c: { route_order: 3, is_recurring: true, recurring_parent_id: 'p-c' }, d: { route_order: 4, is_recurring: true, recurring_parent_id: 'p-d' } };
  const oneTime = { a: { route_order: 1 }, b: { route_order: 2 }, c: { route_order: 3 }, d: { route_order: 4 } };

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
  const deps = ({ dayOnly = true, levels = {}, placed = false } = {}) => ({
    toldLockOn: () => true,
    dayOnlyOn: () => dayOnly,
    isPersonPlacedVisit: jest.fn(async () => ({ placed })),
    loadToldIds: jest.fn(async () => new Set()),
    loadPromiseLevels: jest.fn(levelsOf(levels)),
  });

  test('both on: a one-time visit told only the day is written (no first_or_one_time)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.loadPromiseLevels).toHaveBeenCalled();
    expect(over.loadToldIds).not.toHaveBeenCalled();
  });

  test('both on: a person-placed visit told only the day is written', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, placed: true });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('both on: a visit told an hour meanwhile stops the write (time_told)', async () => {
    const over = deps({ levels: { a: 'day', b: 'hour' } });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:time_told', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('both on: a level read that throws fails closed (time_told), nothing written', async () => {
    const over = deps();
    over.loadPromiseLevels = jest.fn(async () => { throw new Error('level read down'); });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:time_told', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('both on: a one-time visit with no promise at all keeps today\'s rule (first_or_one_time)', async () => {
    const over = deps({ levels: {} });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:first_or_one_time', moved: 0 });
  });

  test('this gate off (told-lock on): PR 1 behavior, the known-slot read and no level read', async () => {
    const over = deps({ dayOnly: false, levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:first_or_one_time', moved: 0 });
    expect(over.loadPromiseLevels).not.toHaveBeenCalled();
    expect(over.loadToldIds).toHaveBeenCalled();
  });

  test('applyDeps carries dayOnlyOn and loadPromiseLevels', () => {
    const real = _internals.applyDeps();
    expect(typeof real.dayOnlyOn).toBe('function');
    expect(typeof real.loadPromiseLevels).toBe('function');
    expect(real.dayOnlyOn()).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(real.dayOnlyOn()).toBe(false); // counts only while the told-lock is on
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    expect(real.dayOnlyOn()).toBe(true);
  });
});
