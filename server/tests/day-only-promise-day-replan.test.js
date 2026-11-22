/**
 * GATE_DAY_ONLY_PROMISE on the nightly day re-plan (services/day-replan, owner 2026-11-05 "D2 a", 2026-11-22): with
 * this gate on, a stop the customer was told only the DAY for may change its hour inside that day: a first or
 * one-time visit and a person-placed visit told only the day are movable. A customer-confirmed stop, a stop told an
 * hour (a known slot, or an unknown window) and every other existing reason stay fixed. A failed level read fails
 * CLOSED. Gate off: the known-slot told lock alone. The one change of 2026-11-22: only with the gate on does the app
 * record whether the customer asked for the time (`askRecorded`), and then customer_time (time-promise.dayOnlyEligibility,
 * mocked here; customer_time_unread when the answer cannot be read) fixes a stop FIRST, whatever it was told, so a
 * day-only notice no longer frees a time the customer asked for. Gate off, or a context without `askRecorded`:
 * `customerTime` is never read or used. Same harness as night-told-lock-day-replan
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

  // The rule before 2026-11-22 (main), written out as the oracle. This change adds only the customer-time lock, checked
  // first and only with askRecorded, so for a stop that is not in customerTime nothing else may change.
  const mainRule = (row, { told, personPlaced, dayTold }) => {
    const dayOnly = !!dayTold && dayTold.has(row.id);
    if (row.customer_confirmed === true) return 'customer_confirmed';
    if (!dayOnly && (row.is_recurring !== true || row.recurring_parent_id == null)) return 'first_or_one_time';
    if (!dayOnly && (!personPlaced || personPlaced.has(row.id))) return 'person_placed';
    if (!told || told.has(row.id)) return 'time_told';
    return null;
  };

  test('table: for a stop not in customerTime, every combination of confirmed, day-only notice, first-or-one-time, person-placed (yes / no / missing) and told (yes / no / missing) gives main\'s answer, with and without askRecorded', () => {
    let cases = 0;
    for (const confirmed of [true, false]) {
      for (const dayTold of [day, new Set(), undefined]) {
        for (const firstOrOneTime of [true, false]) {
          for (const personPlaced of [day, new Set(), undefined]) {
            for (const told of [day, new Set(), undefined]) {
              for (const ask of [{}, { askRecorded: true, customerTime: new Map() }]) {
                const ctx = base({ dayTold, personPlaced, told, ...ask });
                const row = stop({ customer_confirmed: confirmed, ...(firstOrOneTime ? { is_recurring: false, recurring_parent_id: null } : {}) });
                expect(_internals.fixedReason(row, ctx)).toBe(mainRule(row, ctx));
                cases += 1;
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(2 * 3 * 2 * 3 * 3 * 2);
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

  test('the PR\'s one behavior change: with askRecorded, customer_time fixes a stop FIRST, also one told only the day, and before every other told-lock reason', () => {
    const ask = (extra = {}) => base({ askRecorded: true, customerTime: new Map([['s1', 'customer_time']]), ...extra });
    expect(_internals.fixedReason(stop(), ask())).toBe('customer_time');
    expect(_internals.fixedReason(stop(), ask({ dayTold: day }))).toBe('customer_time');
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false }), ask({ personPlaced: day, told: day }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), ask({ customerTime: new Map([['other', 'customer_time']]), dayTold: day }))).toBeNull();
    expect(_internals.fixedReason(stop(), ask({ customerTime: new Map([['s1', 'customer_time_unread']]), dayTold: day }))).toBe('customer_time_unread');
    // The earlier reasons still win.
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), ask())).toBe('status');
    expect(_internals.fixedReason(stop(), ask({ sent24: day }))).toBe('reminder_24h_sent');
  });

  test('askRecorded with no customerTime fact keeps the stop fixed as customer_time_unread (fail closed)', () => {
    expect(_internals.fixedReason(stop(), base({ askRecorded: true, customerTime: undefined, dayTold: day }))).toBe('customer_time_unread');
  });

  test('without askRecorded (gate off, or a hand-built context) a customerTime fact is ignored', () => {
    const own = new Map([['s1', 'customer_time']]);
    expect(_internals.fixedReason(stop(), base({ customerTime: own }))).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: false }), base({ customerTime: own }))).toBe('first_or_one_time');
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

describe('loadCustomerTime', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  test('not eligible is customer_time; eligible is absent; a missing verdict and a failed-read verdict are customer_time_unread; one bulk read, the told level ignored', async () => {
    dayOnlyEligibility.mockResolvedValue(new Map([
      ['a', { eligible: false, level: 'none' }],
      ['b', { eligible: true, level: 'none' }],
      ['c', { eligible: false, level: 'hour', failed: true }],
    ]));
    const fixed = await _internals.loadCustomerTime({}, rows, NOW);
    expect(fixed).toBeInstanceOf(Map);
    expect([...fixed].sort()).toEqual([['a', 'customer_time'], ['c', 'customer_time_unread'], ['d', 'customer_time_unread']]);
    expect(fixed.has('b')).toBe(false);
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility).toHaveBeenCalledWith({}, ['a', 'b', 'c', 'd'], NOW, { ignoreLevel: true });
  });

  test('a verdict marked originUnknown (a booking source that does not say who chose the hour) is customer_time_unread, never the customer\'s own time', async () => {
    dayOnlyEligibility.mockResolvedValue(new Map([
      ['a', { eligible: false, level: 'none', originUnknown: true }],
      ['b', { eligible: false, level: 'none' }],
    ]));
    const fixed = await _internals.loadCustomerTime({}, [{ id: 'a' }, { id: 'b' }], NOW);
    expect([...fixed].sort()).toEqual([['a', 'customer_time_unread'], ['b', 'customer_time']]);
  });

  test('over the REAL reader: a cron_selfheal booking and a visit with no reminder row are customer_time_unread; an online booking is customer_time; an office booking can move', async () => {
    const oneTime = (id) => ({
      id, visit_id: null, status: 'pending', scheduled_date: '2026-11-15', is_recurring: false, recurring_parent_id: null,
      date_exception: null, date_exception_source: null, date_exception_at: null, customer_asked_time: null,
    });
    const reminder = (id, source) => ({ scheduled_service_id: id, source, cancelled: false, created_at: '2026-11-09T12:00:00Z' });
    const tables = {
      scheduled_services: ['heal', 'online', 'office', 'bare'].map(oneTime),
      appointment_reminders: [reminder('heal', 'cron_selfheal'), reminder('online', 'booking_new'), reminder('office', 'admin_manual')],
    };
    // Knex-shaped: every filter chains; the reads this reader makes return the table's rows (no move history).
    const conn = (table) => {
      const chain = { select: async () => tables[table] || [] };
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'orderBy']) chain[m] = () => chain;
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    dayOnlyEligibility.mockImplementation(jest.requireActual('../services/time-promise').dayOnlyEligibility);
    const fixed = await _internals.loadCustomerTime(conn, tables.scheduled_services, NOW);
    expect([...fixed].sort()).toEqual([['bare', 'customer_time_unread'], ['heal', 'customer_time_unread'], ['online', 'customer_time']]);
    expect(fixed.has('office')).toBe(false);
  });

  test('a thrown read returns every id as customer_time_unread and warns (fail closed)', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const fixed = await _internals.loadCustomerTime({}, rows, NOW);
    expect([...fixed].sort()).toEqual([['a', 'customer_time_unread'], ['b', 'customer_time_unread'], ['c', 'customer_time_unread'], ['d', 'customer_time_unread']]);
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

  test('this gate on: ONE bulk level read; hour -> told, day -> dayTold', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockImplementation(levelsOf({ a: 'day', b: 'hour' }));
    const ctx = await load();
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(loadPromiseLevels.mock.calls[0][1].sort()).toEqual(['a', 'b', 'c']);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.dayTold]).toEqual(['a']);
    // The ask is recorded only with the gate on: customerTime from one bulk read, and the person-placed read as before.
    expect(ctx.askRecorded).toBe(true);
    expect(ctx.customerTime).toEqual(new Map());
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility.mock.calls[0][3]).toEqual({ ignoreLevel: true });
    expect(ctx.personPlaced).toBeInstanceOf(Set);
    expect(isPersonPlacedVisit).toHaveBeenCalledTimes(3);
    expect(_internals.fixedReason({ ...dayRows()[0], customer_confirmed: false }, ctx)).toBeNull();
    expect(_internals.fixedReason({ ...dayRows()[1], customer_confirmed: false }, ctx)).toBe('time_told');
  });

  test('this gate on: a failed level read keeps the whole day fixed (every row counts as hour)', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockRejectedValue(new Error('level read down'));
    const ctx = await load();
    expect([...ctx.told].sort()).toEqual(['a', 'b', 'c']);
    expect(ctx.dayTold.size).toBe(0);
    // Every row stays fixed: the one-time row by its existing reason (it comes first), the recurring rows by time_told.
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual(['first_or_one_time', 'time_told', 'time_told']);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('this gate off: the known-slot told set only (no dayTold, no level read)', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    const ctx = await load();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect([...ctx.told]).toEqual(['b']);
    expect(ctx).not.toHaveProperty('dayTold');
    expect(ctx).not.toHaveProperty('askRecorded');
    expect(ctx).not.toHaveProperty('customerTime');
    expect(dayOnlyEligibility).not.toHaveBeenCalled();
    expect(ctx.personPlaced).toBeInstanceOf(Set);
  });

  test('this gate on: a customer-time answer fixes that stop first, also one told only the day; a failed read keeps the whole day fixed', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    loadPromiseLevels.mockImplementation(levelsOf({ a: 'day', b: 'day', c: 'day' }));
    dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: id !== 'b', level: 'none' }])));
    const ctx = await load();
    expect([...ctx.customerTime]).toEqual([['b', 'customer_time']]);
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, ctx))).toEqual([null, 'customer_time', null]);
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const failed = await load();
    expect(dayRows().map((r) => _internals.fixedReason({ ...r, customer_confirmed: false }, failed))).toEqual(['customer_time_unread', 'customer_time_unread', 'customer_time_unread']);
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
    loadCustomerTime: jest.fn(async (_conn, rows) => new Map(rows.map((r) => r.id).filter((id) => customerTime.includes(id)).map((id) => [id, 'customer_time']))),
    loadToldIds: jest.fn(async () => new Set()),
    loadPromiseLevels: jest.fn(levelsOf(levels)),
  });

  test('this gate on: a one-time visit told only the day is written (no first_or_one_time)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
    expect(over.loadPromiseLevels).toHaveBeenCalled();
    expect(over.loadToldIds).not.toHaveBeenCalled();
  });

  test('this gate on: a person-placed visit told only the day is written', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, placed: true });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'applied', reason: 'applied', moved: 2 });
  });

  test('this gate on: a visit whose time became the customer\'s own meanwhile stops the write (visit_not_movable:customer_time), also one told only the day', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' }, customerTime: ['b'] });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:customer_time', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
    // Read with the transaction handle, for the one visit.
    expect(over.loadCustomerTime.mock.calls[0][1]).toEqual([{ id: expect.any(String) }]);
  });

  test('this gate on: the real customer-time read that fails stops the write as customer_time_unread', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const over = deps({ levels: { a: 'day', b: 'day' } });
    over.loadCustomerTime = _internals.loadCustomerTime;
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:customer_time_unread', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('this gate on: a customer-time read that throws stops the write (fail closed)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    over.loadCustomerTime = jest.fn(async () => { throw new Error('verdict read down'); });
    const w = world({ rowExtra: recurring, over });
    expect(await w.run()).toEqual({ status: 'failed', reason: 'write_failed:error', moved: 0 });
    expect(w.rowWrites()).toEqual([]);
  });

  test('this gate on: a confirmed stop stays fixed also when told only the day (customer_confirmed)', async () => {
    const over = deps({ levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: { ...recurring, b: { ...recurring.b, customer_confirmed: true } }, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:customer_confirmed', moved: 0 });
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

  test('this gate on: a one-time visit with no promise at all keeps today\'s rule (first_or_one_time)', async () => {
    const over = deps({ levels: {} });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:first_or_one_time', moved: 0 });
  });

  test('this gate off: the known-slot read and no level read', async () => {
    const over = deps({ dayOnly: false, levels: { a: 'day', b: 'day' } });
    const w = world({ rowExtra: oneTime, over });
    expect(await w.run()).toEqual({ status: 'skipped', reason: 'visit_not_movable:first_or_one_time', moved: 0 });
    expect(over.loadPromiseLevels).not.toHaveBeenCalled();
    expect(over.loadCustomerTime).not.toHaveBeenCalled();
    expect(over.loadToldIds).toHaveBeenCalled();
  });

  test('applyDeps carries dayOnlyOn, loadPromiseLevels and loadCustomerTime', () => {
    const real = _internals.applyDeps();
    expect(typeof real.loadCustomerTime).toBe('function');
    expect(typeof real.dayOnlyOn).toBe('function');
    expect(typeof real.loadPromiseLevels).toBe('function');
    expect(real.dayOnlyOn()).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(real.dayOnlyOn()).toBe(true);
  });
});
