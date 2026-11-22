/**
 * GATE_DAY_ONLY_PROMISE on the nightly day re-plan (services/day-replan): only while this gate is on does the app
 * record whether the customer asked for the time, so only then (`askRecorded`) does the owner's 2026-11-22 rule apply:
 * a stop is fixed when its time is the customer's own (customer_time, time-promise.dayOnlyEligibility, mocked here) or
 * when it was told an hour (a known slot, or an unknown window: time_told); a stop told only the day is not. Staff
 * placement, a confirmation and a first or one-time visit fix nothing. A failed read fails CLOSED. Gate off, or a
 * context built by hand without `askRecorded`: the rule before 2026-11-22 (customer_confirmed, first_or_one_time,
 * person_placed, time_told) applies unchanged. Same harness as night-told-lock-day-replan
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
jest.mock('../services/time-promise', () => ({ ...jest.requireActual('../services/time-promise'), dayOnlyEligibility: jest.fn() }));
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));

const { loadToldVisitIds, loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const { isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');
const { dayOnlyEligibility } = require('../services/time-promise');
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
  isPersonPlacedVisit.mockImplementation(async () => ({ placed: false }));
  loadToldVisitIds.mockReset();
  loadToldVisitIds.mockResolvedValue(new Set());
  loadPromiseLevels.mockReset();
  loadPromiseLevels.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, 'none'])));
  dayOnlyEligibility.mockReset();
  dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: true, level: 'none' }])));
});
afterAll(() => { process.env = savedEnv; });

const levelsOf = (map) => async (_conn, ids) => new Map(ids.map((id) => [id, map[id] || 'none']));

describe('fixedReason: gate on (askRecorded)', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, askRecorded: true, told: new Set(), customerTime: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });
  const one = new Set(['s1']);

  test('a confirmed stop, a first or one-time stop and a staff-placed stop may move: who set the time no longer fixes it', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
    expect(_internals.fixedReason(stop({ customer_confirmed: true }), base())).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: false, recurring_parent_id: null }), base())).toBeNull();
    // A person-placed fact a caller still sends is not read.
    expect(_internals.fixedReason(stop(), base({ personPlaced: one }))).toBeNull();
  });

  test('customer_time, and it is checked before time_told', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: one }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ customerTime: new Set(['other']) }))).toBeNull();
    expect(_internals.fixedReason(stop(), base({ customerTime: one, told: one }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ told: one }))).toBe('time_told');
  });

  test('a fact the day load did not provide keeps the stop fixed (fail closed)', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: undefined }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ told: undefined }))).toBe('time_told');
  });

  test('the earlier reasons keep their order', () => {
    const all = base({ customerTime: one, told: one, sent24: one });
    expect(_internals.fixedReason(stop(), all)).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), all)).toBe('status');
    expect(_internals.fixedReason(stop({ auto_dispatch_locked: true }), all)).toBe('staff_lock');
    expect(_internals.fixedReason(stop(), { ...all, sent24: new Set() })).toBe('customer_time');
  });
});

describe('fixedReason: no askRecorded (gate off, or a hand-built context) keeps the rule before 2026-11-22', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, told: new Set(), personPlaced: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });
  const one = new Set(['s1']);

  test('customer_confirmed, first_or_one_time, person_placed and time_told, in that order', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false }), base({ personPlaced: one, told: one }))).toBe('customer_confirmed');
    expect(_internals.fixedReason(stop({ is_recurring: false }), base({ personPlaced: one, told: one }))).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop({ recurring_parent_id: null }), base())).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop(), base({ personPlaced: one, told: one }))).toBe('person_placed');
    expect(_internals.fixedReason(stop(), base({ told: one }))).toBe('time_told');
  });

  test('a context that carries customerTime but not askRecorded ignores it (the fail-closed default)', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: one }))).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: false }), base({ customerTime: one }))).toBe('first_or_one_time');
  });

  test('a missing fact keeps the stop fixed', () => {
    expect(_internals.fixedReason(stop(), base({ personPlaced: undefined }))).toBe('person_placed');
    expect(_internals.fixedReason(stop(), base({ told: undefined }))).toBe('time_told');
  });
});

describe('loadCustomerTime', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  test('a visit that is not eligible, and one with no verdict, are the customer\'s time; an eligible one is not; one bulk read, the told level ignored', async () => {
    dayOnlyEligibility.mockResolvedValue(new Map([['a', { eligible: false, level: 'none' }], ['b', { eligible: true, level: 'none' }]]));
    const set = await _internals.loadCustomerTime({}, rows, NOW);
    expect([...set].sort()).toEqual(['a', 'c']);
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility).toHaveBeenCalledWith({}, ['a', 'b', 'c'], NOW, { ignoreLevel: true });
  });

  test('a failed read returns every id and warns (fail closed)', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const set = await _internals.loadCustomerTime({}, rows, NOW);
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customer-time read failed'));
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

  test('this gate on: askRecorded, ONE bulk level read (hour -> told, day -> not told), customerTime from one bulk read, no person-placed read', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockImplementation(levelsOf({ a: 'day', b: 'hour' }));
    dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: id !== 'c', level: 'none' }])));
    const ctx = await load();
    expect(ctx.askRecorded).toBe(true);
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(loadPromiseLevels.mock.calls[0][1].sort()).toEqual(['a', 'b', 'c']);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.customerTime]).toEqual(['c']);
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility.mock.calls[0][3]).toEqual({ ignoreLevel: true });
    expect(isPersonPlacedVisit).not.toHaveBeenCalled();
    expect(ctx).not.toHaveProperty('personPlaced');
    expect(ctx).not.toHaveProperty('dayTold');
    // The first-or-one-time stop A, told only the day, may move; B was told an hour; C is the customer's own.
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual([null, 'time_told', 'customer_time']);
  });

  test('this gate on: a failed level read keeps the whole day fixed (every row counts as hour)', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockRejectedValue(new Error('level read down'));
    const ctx = await load();
    expect([...ctx.told].sort()).toEqual(['a', 'b', 'c']);
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['time_told', 'time_told', 'time_told']);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('this gate on: a failed customer-time read keeps the whole day fixed as customer_time', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const ctx = await load();
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['customer_time', 'customer_time', 'customer_time']);
  });

  test('this gate off: no askRecorded, the known-slot told set and the person-placed read, no level read and no customer-time read', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(dayOnlyEligibility).not.toHaveBeenCalled();
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect(isPersonPlacedVisit).toHaveBeenCalledTimes(3);
    expect(ctx).not.toHaveProperty('askRecorded');
    expect(ctx).not.toHaveProperty('customerTime');
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.personPlaced]).toEqual([]);
    // The rule before 2026-11-22: the one-time stop A is first_or_one_time, B is time_told.
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['first_or_one_time', 'time_told', null]);
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
  const deps = ({ dayOnly = true, levels = {}, placed = false, customerTime = [] } = {}) => ({
    dayOnlyOn: () => dayOnly,
    isPersonPlacedVisit: jest.fn(async () => ({ placed })),
    loadCustomerTime: jest.fn(async (_conn, rows) => new Set(rows.map((r) => r.id).filter((id) => customerTime.includes(id)))),
    loadToldIds: jest.fn(async () => new Set()),
    loadPromiseLevels: jest.fn(levelsOf(levels)),
  });

  test('this gate on: a one-time visit told only the day is written (no first_or_one_time)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.loadPromiseLevels).toHaveBeenCalled();
    expect(over.loadCustomerTime).toHaveBeenCalled();
    expect(over.loadToldIds).not.toHaveBeenCalled();
  });

  test('this gate on: a person-placed visit is written, and the person-placed history is not read', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, placed: true });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.isPersonPlacedVisit).not.toHaveBeenCalled();
  });

  test('this gate on: a visit whose time became the customer\'s own meanwhile stops the write (visit_not_movable:customer_time), read with the transaction handle', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, customerTime: ['b'] });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:customer_time', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
    expect(over.loadCustomerTime.mock.calls[0][1]).toEqual([{ id: expect.any(String) }]);
  });

  test('this gate on: a customer-time read that throws stops the write (fail closed)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    over.loadCustomerTime = jest.fn(async () => { throw new Error('verdict read down'); });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'failed', reason: 'write_failed:error', moved: 0 });
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

  test('this gate on: a one-time visit with no promise at all is written (no first_or_one_time lock)', async () => {
    const over = deps({ levels: {} });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('this gate off: the known-slot read and no level read', async () => {
    const over = deps({ dayOnly: false, levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:first_or_one_time', moved: 0 });
    expect(over.loadPromiseLevels).not.toHaveBeenCalled();
    expect(over.loadCustomerTime).not.toHaveBeenCalled();
    expect(over.loadToldIds).toHaveBeenCalled();
  });

  test('this gate off: a person-placed visit still stops the write (person_placed), a customer-time answer is not read', async () => {
    const over = deps({ dayOnly: false, placed: true, customerTime: ['a', 'b'] });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:person_placed', moved: 0 });
    expect(over.loadCustomerTime).not.toHaveBeenCalled();
    expect(w.rowWrites()).toEqual([]);
  });

  test('applyDeps carries dayOnlyOn, loadPromiseLevels, loadCustomerTime and isPersonPlacedVisit', () => {
    const real = _internals.applyDeps();
    expect(typeof real.loadCustomerTime).toBe('function');
    expect(typeof real.isPersonPlacedVisit).toBe('function');
    expect(typeof real.dayOnlyOn).toBe('function');
    expect(typeof real.loadPromiseLevels).toBe('function');
    expect(real.dayOnlyOn()).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(real.dayOnlyOn()).toBe(true);
  });
});
