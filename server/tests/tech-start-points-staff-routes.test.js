/**
 * GATE_TECH_START_POINTS part 3 (owner 2026-10-22): the staff route tools that
 * used to hard-code the office as a technician's start AND end now use the
 * tech's start point. Covered here, on the shared route-reorder machinery both
 * the admin buttons, the Intelligence Bar and the nightly pass run through:
 *
 *  1. loadTechStartPoints: gate off = no query; gate on = ONE query for many
 *     techs; an invalid coordinate is the office; ids match in lowercase.
 *  2. The model distance and drive time return to `end`, not the office, even
 *     when the first leg starts from the truck's live position.
 *  3. chooseWindowSafeOrder / the window-fit search score from and back to the
 *     tech's `home`; no `home` = the office, exactly as before.
 *  4. The nightly pass sends Google the tech's start point, scores before and
 *     after to it, and reads every start point in one query (none gate off).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
// Deterministic geometry: HQ at the origin, manhattan-degree "miles", 1000 m
// and 1 minute per mile.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 0, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2),
  fallbackLegMetrics: (miles) => ({ meters: Math.round(miles * 1000), minutes: miles }),
  optimizeRoute: jest.fn(),
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(),
}));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});

const db = require('../models/db');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { loadTechStartPoints, homeFromMap, sameStartPoint, assertStartPointUnchanged } = require('../services/scheduling/tech-start-point');
const { runRouteReorder, chooseWindowSafeOrder, resolveWindowSafeOrderByTechDay, _internals } = require('../services/route-reorder');
const { computeWindowFitOrder, computeChronologicalRepair } = require('../services/route-reorder-window-fit');

const ENV = process.env.GATE_TECH_START_POINTS;
afterEach(() => {
  if (ENV === undefined) delete process.env.GATE_TECH_START_POINTS;
  else process.env.GATE_TECH_START_POINTS = ENV;
});

// Synthetic "home" 20 miles east of the office, on the stops' line (lat 1; a
// 0 latitude reads as 'no coordinate' to the guards, so no fixture uses it).
const HOME_ROW = { id: 'T-HOME', start_lat: '1', start_lng: '20' };
const HOME = { lat: 1, lng: 20 };
const HQ = RouteOptimizer.HQ;

function stop(id, over = {}) {
  return { id, technician_id: 't1', route_order: null, window_start: null, time_window: null, estimated_duration_minutes: 60,
    service_type: 'pest', zone: null, lat: 1, lng: 1, service_address_line1: null, visit_id: null,
    customer_address_line1: '100 Main St', customer_address_line2: null, customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205',
    ...over };
}
// Current running order C,A,B along the line (lng 6, 2, 4).
const day = (tech = 't1') => [
  stop(`${tech}-C`, { technician_id: tech, lng: 6, route_order: 1 }),
  stop(`${tech}-A`, { technician_id: tech, lng: 2, route_order: 2 }),
  stop(`${tech}-B`, { technician_id: tech, lng: 4, route_order: 3 }),
];

describe('loadTechStartPoints', () => {
  function connWith(rows) {
    const calls = [];
    const conn = jest.fn((table) => {
      const q = { table, whereNotNull: jest.fn(() => q), whereIn: jest.fn(() => q), select: jest.fn(async () => rows) };
      calls.push(q);
      return q;
    });
    return { conn, calls };
  }

  test('gate off: an empty map and no query', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const { conn } = connWith([HOME_ROW]);
    const points = await loadTechStartPoints(conn);
    expect(points.size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(homeFromMap(points, 'T-HOME')).toBe(HQ);
  });

  test('gate on: one query for every tech; a bad coordinate and an unlisted tech are the office; ids match in lowercase', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const { conn, calls } = connWith([
      { id: 'ABC-1', start_lat: '27.1', start_lng: '-82.4' },
      { id: 'bad-2', start_lat: 'x', start_lng: '-82.4' },
    ]);
    const points = await loadTechStartPoints(conn);
    expect(conn).toHaveBeenCalledTimes(1);
    expect(calls[0].table).toBe('technicians');
    expect(calls[0].select).toHaveBeenCalledWith(['id', 'start_lat', 'start_lng']);
    expect(homeFromMap(points, 'abc-1')).toEqual({ lat: 27.1, lng: -82.4 });
    expect(homeFromMap(points, 'ABC-1')).toEqual({ lat: 27.1, lng: -82.4 });
    expect(homeFromMap(points, 'bad-2')).toBe(HQ);
    expect(homeFromMap(points, 'nobody')).toBe(HQ);
    expect(homeFromMap(null, 'abc-1')).toBe(HQ);
  });

  test('gate on with named techs: filtered by id; an empty list does not query', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const { conn, calls } = connWith([]);
    await loadTechStartPoints(conn, ['t1', null, 't1']);
    expect(calls[0].whereIn).toHaveBeenCalledWith('id', ['t1']);
    const none = connWith([]);
    expect((await loadTechStartPoints(none.conn, [])).size).toBe(0);
    expect(none.conn).not.toHaveBeenCalled();
  });
});

describe('assertStartPointUnchanged (commit-time fence)', () => {
  const stale = () => Object.assign(new Error('stale'), { code: 'STALE' });
  function trxWith(row) {
    const q = { where: jest.fn(() => q), forShare: jest.fn(() => q), first: jest.fn(async () => row) };
    return { trx: jest.fn(() => q), q };
  }

  test('sameStartPoint: the office object, or equal coordinates', () => {
    expect(sameStartPoint(HQ, HQ)).toBe(true);
    expect(sameStartPoint({ lat: 1, lng: 2 }, { lat: 1, lng: 2 })).toBe(true);
    expect(sameStartPoint({ lat: 1, lng: 2 }, HQ)).toBe(false);
    expect(sameStartPoint(null, HQ)).toBe(false);
  });

  test('gate off: no query; passes for the office, refuses a plan made from a point', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const { trx } = trxWith(HOME_ROW);
    await expect(assertStartPointUnchanged(trx, 't1', HQ, stale)).resolves.toBeUndefined();
    await expect(assertStartPointUnchanged(trx, 't1', HOME, stale)).rejects.toMatchObject({ code: 'STALE' });
    expect(trx).not.toHaveBeenCalled();
  });

  test('gate on: re-reads the row FOR SHARE; same point passes, an edit refuses', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const same = trxWith(HOME_ROW);
    await expect(assertStartPointUnchanged(same.trx, 't1', HOME, stale)).resolves.toBeUndefined();
    expect(same.trx).toHaveBeenCalledWith('technicians');
    expect(same.q.forShare).toHaveBeenCalledTimes(1);
    expect(same.q.first).toHaveBeenCalledWith(['start_lat', 'start_lng']);
    const moved = trxWith({ start_lat: '2', start_lng: '3' });
    await expect(assertStartPointUnchanged(moved.trx, 't1', HOME, stale)).rejects.toMatchObject({ code: 'STALE' });
    // The planned point was set, then the address was cleared or made invalid.
    await expect(assertStartPointUnchanged(trxWith({ start_lat: null, start_lng: null }).trx, 't1', HOME, stale)).rejects.toMatchObject({ code: 'STALE' });
  });

  test('gate on: office plan stays valid while the tech has no point; a newly set point refuses', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    await expect(assertStartPointUnchanged(trxWith({ start_lat: null, start_lng: null }).trx, 't1', HQ, stale)).resolves.toBeUndefined();
    await expect(assertStartPointUnchanged(trxWith(undefined).trx, 't1', HQ, stale)).resolves.toBeUndefined();
    await expect(assertStartPointUnchanged(trxWith(HOME_ROW).trx, 't1', HQ, stale)).rejects.toMatchObject({ code: 'STALE' });
  });

  test('no technician (whole-board call): nothing to check', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const { trx } = trxWith(HOME_ROW);
    await assertStartPointUnchanged(trx, null, HQ, stale);
    expect(trx).not.toHaveBeenCalled();
  });
});

describe('model distance and drive time return to `end`', () => {
  const stops = [stop('A', { lng: 2 }), stop('B', { lng: 4 })];
  test('default end is the office', () => {
    expect(_internals.modelDistanceMeters(RouteOptimizer, stops)).toBe(10000); // (0,0)->(1,2)->(1,4)->(0,0)
    expect(_internals.modelDriveMinutes(RouteOptimizer, stops)).toBe(10);
  });
  test('start and end at the tech start point', () => {
    expect(_internals.modelDistanceMeters(RouteOptimizer, stops, HOME, HOME)).toBe(36000); // 20->2->4->20 along lat 1
    expect(_internals.modelDriveMinutes(RouteOptimizer, stops, HOME, HOME)).toBe(36);
  });
  test('a live truck position starts the first leg, the return still goes home', () => {
    const truck = { lat: 1, lng: 10 };
    expect(_internals.modelDistanceMeters(RouteOptimizer, stops, truck, HOME)).toBe(26000); // 10->2->4->20
    expect(_internals.modelDriveMinutes(RouteOptimizer, stops, truck, HOME)).toBe(26);
  });
});

describe('the window guard scores from and back to `home`', () => {
  const source = day();
  const google = [source[1], source[2], source[0]]; // A, B, C
  const decide = (extra = {}) => chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: google, sourceStops: source, googleSource: 'google_routes_api', ...extra,
  });

  test('no home: the office, as before', () => {
    const out = decide();
    expect(out.beforeMeters).toBe(18000); // office->6->2->4->office
    expect(out.afterMeters).toBe(14000);  // office->2->4->6->office
  });

  test('home: before and after are measured from the start point', () => {
    const out = decide({ home: HOME });
    expect(out.beforeMeters).toBe(36000); // 20->6->2->4->20
    expect(out.afterMeters).toBe(36000);  // 20->2->4->6->20
  });

  test('a truck on the road still drives home at the end', () => {
    const out = decide({ home: HOME, origin: { lat: 1, lng: 10 } });
    expect(out.beforeMeters).toBe(4000 + 4000 + 2000 + 16000); // 10->6->2->4->20
    expect(out.afterMeters).toBe(8000 + 2000 + 2000 + 14000);  // 10->2->4->6->20
    // The same truck with no home drives back to the office instead.
    expect(decide({ origin: { lat: 1, lng: 10 } }).afterMeters).toBe(8000 + 2000 + 2000 + 7000);
  });

  test('resolveWindowSafeOrderByTechDay gives each tech their own start point and the office to the rest', () => {
    const t2 = day('t2');
    const sources = [...day('t1'), ...t2];
    const flat = [sources[1], sources[2], sources[0], t2[1], t2[2], t2[0]];
    const techHomes = new Map([['t1', HOME]]);
    const out = resolveWindowSafeOrderByTechDay({
      RouteOptimizer, orderedStops: flat, sourceStops: sources, googleSource: 'google_routes_api', techHomes, requireCalibratedModel: false,
    });
    expect(out.refusal).toBeUndefined();
    expect(out.resolvedByTech.get('t1').afterMeters).toBe(36000);
    expect(out.resolvedByTech.get('t2').afterMeters).toBe(14000);
    const officeOnly = resolveWindowSafeOrderByTechDay({
      RouteOptimizer, orderedStops: flat, sourceStops: sources, googleSource: 'google_routes_api', requireCalibratedModel: false,
    });
    expect(officeOnly.resolvedByTech.get('t1').afterMeters).toBe(14000);
  });
});

describe('window-fit search and chronological repair use the same start and end', () => {
  const timed = [stop('T1', { window_start: '09:00', lng: 10 }), stop('U', { lng: 2 })];
  const guards = () => ({
    effectiveWindowStart: _internals.effectiveWindowStart,
    effectiveWindowRange: _internals.effectiveWindowRange,
    violatesWindowChronology: _internals.violatesWindowChronology,
    violatesWindowFeasibility: _internals.violatesWindowFeasibility,
    modelDistanceMeters: jest.fn(_internals.modelDistanceMeters),
  });

  test('the candidate distance is scored to `end`', () => {
    const g = guards();
    const fit = computeWindowFitOrder(RouteOptimizer, timed, g, { origin: HOME, end: HOME });
    expect(fit).toBeTruthy();
    expect(g.modelDistanceMeters).toHaveBeenCalledWith(RouteOptimizer, expect.any(Array), HOME, HOME);
    // Either order is 20->10->2->20 = 36 miles along lat 1.
    expect(fit.orderedStops.map((x) => x.id).sort()).toEqual(['T1', 'U']);
    expect(fit.afterMeters).toBe(36000);
  });

  test('no `end` given: the office, as before', () => {
    const g = guards();
    const fit = computeWindowFitOrder(RouteOptimizer, timed, g, {});
    expect(g.modelDistanceMeters).toHaveBeenCalledWith(RouteOptimizer, expect.any(Array), HQ, HQ);
    expect(fit.afterMeters).toBe(22000); // (0,0)->(1,10)->(1,2)->(0,0)
  });

  test('chronological repair drives the day from home and back', () => {
    // 09:00 stop is last in the running order, the 08:00 one first: the repair
    // reorders; its simulated drive time ends at `home`.
    const late = [stop('L', { window_start: '10:00', lng: 4, route_order: 1 }), stop('E', { window_start: '08:00', lng: 6, route_order: 2 })];
    const office = computeChronologicalRepair(RouteOptimizer, late);
    const home = computeChronologicalRepair(RouteOptimizer, late, HOME);
    expect(office.simulation.travelMin).toBe(7 + 2 + 5);   // office->6->4->office
    expect(home.simulation.travelMin).toBe(14 + 2 + 16);   // 20->6->4->20
  });
});

describe('nightly pass starts and ends each tech at their start point', () => {
  jest.setTimeout(30000);
  const NOW = new Date('2026-08-13T08:10:00Z');
  const DAY = '2026-08-17';
  let stopsByDate;
  let ledgerInserts;
  let technicianQueries;
  let freshStart; // tech id -> row the in-transaction FOR SHARE re-read returns
  let commitReads;

  beforeEach(() => {
    freshStart = { t1: { start_lat: '1', start_lng: '20' }, t2: { start_lat: null, start_lng: null } };
    commitReads = 0;
    jest.clearAllMocks();
    delete process.env.GATE_ROUTE_REORDER_WINDOW_FIT;
    delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    stopsByDate = {};
    ledgerInserts = [];
    technicianQueries = 0;
    dayStopsQuery.mockImplementation((_db, { dateStr }) => {
      const builder = {
        whereRaw: () => builder,
        then: (resolve, reject) => Promise.resolve(stopsByDate[dateStr] || []).then(resolve, reject),
      };
      return builder;
    });
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    db.mockImplementation((table) => {
      const c = { _table: table };
      ['where', 'whereIn', 'whereNotNull', 'orderBy', 'limit'].forEach((m) => { c[m] = () => c; });
      if (table === 'technicians') technicianQueries += 1;
      c.select = () => (table === 'technicians' ? Promise.resolve([{ id: 't1', start_lat: '1', start_lng: '20' }]) : c);
      c.first = async () => null;
      c.insert = (row) => {
        if (table === 'route_optimization_planner_runs') ledgerInserts.push(row);
        return { returning: async () => [{ id: 'ledger-1' }] };
      };
      c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return c;
    });
    db.transaction.mockImplementation(async (cb) => {
      const trx = (table) => {
        if (table === 'technicians') {
          let id;
          const t = { where: (f) => { id = f.id; return t; }, forShare: () => t, first: async () => { commitReads += 1; return freshStart[id]; } };
          return t;
        }
        const filters = {};
        const c = {
          where: (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[String(a).replace('scheduled_services.', '')] = b; return c; },
          whereNotIn: () => c, whereRaw: () => c, forUpdate: () => c, leftJoin: () => c,
          // The commit fence re-reads the tech-day's guard inputs.
          select: async () => (stopsByDate[filters.scheduled_date] || []).filter((x) => x.technician_id === filters.technician_id),
          update: async () => 1,
        };
        return c;
      };
      trx.raw = async () => {};
      return cb(trx);
    });
    // Google's answer: ascending distance from the office along the line.
    RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
      orderedStops: [...stops].sort((a, b) => a.lng - b.lng),
      totalDistanceMeters: 12345, totalDurationSeconds: 600, source: 'google_routes_api',
    }));
    stopsByDate[DAY] = [...day('t1'), ...day('t2')];
  });

  const ledger = () => JSON.parse(ledgerInserts[0].result);

  test('gate off: both techs start and end at the office, with no technician query', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const res = await runRouteReorder({ now: NOW });
    expect(technicianQueries).toBe(0);
    expect(RouteOptimizer.optimizeRoute.mock.calls.map(([, o]) => [o.startLat, o.startLng])).toEqual([[0, 0], [0, 0]]);
    expect(res.applied).toBe(2);
    expect(ledger().reorders.map((r) => [r.before_distance_meters, r.after_distance_meters])).toEqual([[18000, 14000], [18000, 14000]]);
  });

  test('gate on: t1 (with a start point) is routed from and scored to it; t2 (none) stays at the office; ONE technician query', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const res = await runRouteReorder({ now: NOW });
    expect(technicianQueries).toBe(1);
    expect(RouteOptimizer.optimizeRoute.mock.calls.map(([, o]) => [o.techId, o.startLat, o.startLng])).toEqual([
      ['t1', 1, 20], ['t2', 0, 0],
    ]);
    // t1 from home: the office-best order saves nothing (36000 both ways), so
    // the day is skipped on the savings floor and the ledger shows home figures.
    const skip = ledger().skips.find((s) => s.technician_id === 't1');
    expect(skip).toMatchObject({ reason: 'BELOW_MIN_SAVINGS', before_distance_meters: 36000, after_distance_meters: 36000 });
    expect(res.applied).toBe(1);
    expect(ledger().reorders.map((r) => [r.technician_id, r.before_distance_meters, r.after_distance_meters])).toEqual([['t2', 18000, 14000]]);
  });

  test('gate on, the commit finds the start point edited: that tech-day is skipped START_POINT_CHANGED and nothing is written for it', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    freshStart.t1 = { start_lat: '1', start_lng: '30' }; // edited since the plan was certified
    // Make t1's plan worth writing from home: stored A,C,B (40 miles) vs Google C,B,A (36).
    stopsByDate[DAY] = [
      stop('t1-A', { lng: 2, route_order: 1 }), stop('t1-C', { lng: 6, route_order: 2 }), stop('t1-B', { lng: 4, route_order: 3 }),
      ...day('t2'),
    ];
    RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
      orderedStops: [...stops].sort((x, y) => y.lng - x.lng), totalDistanceMeters: 1, totalDurationSeconds: 1, source: 'google_routes_api',
    }));
    const res = await runRouteReorder({ now: NOW });
    expect(commitReads).toBeGreaterThanOrEqual(1);
    expect(ledger().skips.find((x) => x.technician_id === 't1')).toMatchObject({ reason: 'START_POINT_CHANGED' });
    expect(ledger().reorders.map((r) => r.technician_id)).toEqual(['t2']); // the untouched tech still writes
    expect(res.applied).toBe(1);
  });

  test('gate off: the commit makes no technician read', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    await runRouteReorder({ now: NOW });
    expect(commitReads).toBe(0);
    expect(technicianQueries).toBe(0);
  });

  test('gate on but the start-point read fails: the run writes nothing, records START_POINTS_UNAVAILABLE, and logs only the error text', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    db.mockImplementation((table) => {
      if (table === 'technicians') throw new Error('boom');
      const c = {};
      ['where', 'whereIn', 'orderBy', 'limit', 'select'].forEach((m) => { c[m] = () => c; });
      c.first = async () => null;
      c.insert = (row) => { if (table === 'route_optimization_planner_runs') ledgerInserts.push(row); return { returning: async () => [{ id: 'ledger-1' }] }; };
      c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return c;
    });
    const res = await runRouteReorder({ now: NOW });
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
    expect(ledger().skips).toContainEqual(expect.objectContaining({ date: DAY, reason: 'START_POINTS_UNAVAILABLE' }));
    const logger = require('../services/logger');
    expect(logger.error.mock.calls.map(([m]) => m)).toEqual([
      '[route-reorder] technician start points unavailable, run writes nothing: boom',
    ]);
  });
});
