// WINDOW-FIT FALLBACK (GATE_ROUTE_REORDER_WINDOW_FIT): when Google's order
// fails the chronology/feasibility guards, the nightly pass computes the best
// LEGAL order in-process. Covered here: gate OFF = byte-for-byte the
// pre-fallback skip; gate ON applies a legal order through the same fenced
// write with source 'window_constrained' + unconstrained_saved_meters; an
// infeasible/unprofitable day keeps its ORIGINAL skip reason plus the
// fallback:'NO_FEASIBLE_IMPROVEMENT' tag; a legal Google order never
// consults the fallback. Plus unit coverage of the search itself
// (backbone preserved, exhaustive optimality, greedy above the cap,
// infeasible day ⇒ null).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
// Deterministic geometry: HQ at the origin, manhattan-degree "miles", and a
// 1000 m/mile, 0-minute leg model — model distances are exact integers and
// integration-test feasibility is driven purely by windows + durations.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 0, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2),
  fallbackLegMetrics: (miles) => ({ meters: Math.round(miles * 1000), minutes: 0 }),
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
const { runRouteReorder, _internals } = require('../services/route-reorder');
const { computeWindowFitOrder, _internals: wfInternals } = require('../services/route-reorder-window-fit');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
// 08-17 is ~4 days out — inside the reorder band, outside every freeze.
const NOW = new Date('2026-08-13T08:10:00Z');
const DAY = '2026-08-17';

function stop(id, over = {}) {
  return { id, technician_id: 't1', route_order: null, window_start: null, time_window: null, estimated_duration_minutes: 60, service_type: 'pest', zone: null, lat: 1, lng: 1, ...over };
}

const GUARDS = {
  effectiveWindowStart: _internals.effectiveWindowStart,
  effectiveWindowRange: _internals.effectiveWindowRange,
  violatesWindowChronology: _internals.violatesWindowChronology,
  violatesWindowFeasibility: _internals.violatesWindowFeasibility,
  modelDistanceMeters: _internals.modelDistanceMeters,
};

let stopsByDate;
let ledgerInserts;
let trxUpdates;
let adRunRow;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_ROUTE_REORDER_WINDOW_FIT;
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  stopsByDate = {};
  ledgerInserts = [];
  trxUpdates = [];
  adRunRow = null;
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
    ['where', 'whereIn', 'orderBy', 'limit'].forEach((m) => { c[m] = () => c; });
    c.select = () => c;
    c.first = async () => (table === 'auto_dispatch_runs' ? adRunRow || null : null);
    c.insert = (row) => {
      if (table === 'route_optimization_planner_runs') ledgerInserts.push(row);
      return { returning: async () => [{ id: 'ledger-1' }] };
    };
    c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return c;
  });
  db.transaction.mockImplementation(async (cb) => {
    const attempted = [];
    const trx = () => {
      const filters = {};
      const c = {
        where: (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[String(a).replace('scheduled_services.', '')] = b; return c; },
        whereNotIn: () => c,
        whereRaw: () => c,
        forUpdate: () => c,
        leftJoin: () => c,
        select: async () => (stopsByDate[filters.scheduled_date] || [])
          .filter((s) => s.technician_id === filters.technician_id)
          .map((s) => ({ id: s.id, window_start: s.window_start, time_window: s.time_window, estimated_duration_minutes: s.estimated_duration_minutes, auto_dispatch_locked: s.auto_dispatch_locked, auto_dispatch_excluded: s.auto_dispatch_excluded, route_order: s.route_order, lat: s.lat, lng: s.lng })),
        update: async (u) => { attempted.push({ id: filters.id, ...u }); return 1; },
      };
      return c;
    };
    trx.raw = async () => {};
    const out = await cb(trx);
    trxUpdates.push(...attempted);
    return out;
  });
});

const ledger = () => JSON.parse(ledgerInserts[0].result);
const mockOptimizerOrder = (ids) => {
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: ids.map((id) => stops.find((s) => s.id === id)),
    totalDistanceMeters: 12345,
    totalDurationSeconds: 600,
    source: 'google_routes_api',
  }));
};

// ── Fixture A (chronology conflict, feasible legal improvement) ──
// T1 promised 09:00 far out (lng 10), T2 promised 13:00 near (lng 1),
// U untimed (lng 2). Current running order U,T2,T1 = 24000 m. Google's
// distance order T2,T1,U = 22000 m (saves 2000) but runs the 13:00 promise
// before the 09:00 one. Best LEGAL order T1,U,T2 = 22000 m — same saving,
// windows honored.
function chronologyDay() {
  return [
    stop('T1', { window_start: '09:00', lng: 10, route_order: 3 }),
    stop('T2', { window_start: '13:00', lng: 1, route_order: 2 }),
    stop('U', { lng: 2, route_order: 1 }),
  ];
}

test('gate OFF: guard violation skips the day exactly as before — no fallback fields, ledger says window_fit:false', async () => {
  stopsByDate[DAY] = chronologyDay();
  mockOptimizerOrder(['T2', 'T1', 'U']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  const skip = ledger().skips.find((s) => s.date === DAY);
  expect(skip).toMatchObject({ reason: 'WINDOW_ORDER_CONFLICT', saved_meters: 2000 });
  expect(skip.fallback).toBeUndefined();
  expect(trxUpdates).toEqual([]);
  expect(JSON.parse(ledgerInserts[0].constraints).window_fit).toBe(false);
});

test('gate ON but calibration OFF: fallback stands down — model-authored orders require the calibrated drive-time model', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  // GATE_DRIVE_TIME_CALIBRATION deliberately unset: the legacy 30 mph model
  // must never author an order (pre-push audit P1 — the fallback's safety
  // case is the calibrated model's MAE, and killing calibration must also
  // stand the fallback down).
  stopsByDate[DAY] = chronologyDay();
  mockOptimizerOrder(['T2', 'T1', 'U']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  const skip = ledger().skips.find((s) => s.date === DAY);
  expect(skip).toMatchObject({ reason: 'WINDOW_ORDER_CONFLICT', fallback: 'CALIBRATION_OFF' });
  expect(trxUpdates).toEqual([]);
});

test('gate ON: chronology conflict falls back to the best LEGAL order and applies it through the same write', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  stopsByDate[DAY] = chronologyDay();
  mockOptimizerOrder(['T2', 'T1', 'U']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const applied = ledger().reorders[0];
  expect(applied).toMatchObject({
    date: DAY,
    source: 'window_constrained',
    before_distance_meters: 24000,
    after_distance_meters: 22000,
    saved_meters: 2000,
    unconstrained_saved_meters: 2000,
  });
  // The written order is the legal one: promised 09:00 before promised 13:00.
  expect(trxUpdates).toEqual([
    { id: 'T1', route_order: 1 },
    { id: 'U', route_order: 2 },
    { id: 'T2', route_order: 3 },
  ]);
  expect(JSON.parse(ledgerInserts[0].constraints).window_fit).toBe(true);
});

test('gate ON: a day with NO feasible legal order keeps its original skip reason plus the fallback tag', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Promises that cannot both be kept: T1 09:00 (deadline 11:00) and T2
  // 11:00 (deadline 13:00), each 300 minutes of work — whichever runs first
  // pushes the other past its deadline. Google still "saves" 8000 m with an
  // order that runs the promises backwards (guard rejects it).
  stopsByDate[DAY] = [
    stop('T1', { window_start: '09:00', estimated_duration_minutes: 300, lng: 5, route_order: 3 }),
    stop('T2', { window_start: '11:00', estimated_duration_minutes: 300, lng: 1, route_order: 2 }),
    stop('U', { lng: 6, route_order: 1 }),
  ];
  mockOptimizerOrder(['T2', 'T1', 'U']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  const skip = ledger().skips.find((s) => s.date === DAY);
  expect(skip).toMatchObject({ reason: 'WINDOW_ORDER_CONFLICT', fallback: 'NO_FEASIBLE_IMPROVEMENT' });
  expect(trxUpdates).toEqual([]);
});

test('gate ON: feasibility (WINDOW_FIT_CONFLICT) rejection also falls back — untimed long job moves AFTER the promised windows', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Google wedges a 400-minute untimed job between the 09:00 and 13:00
  // promises (chronology passes, day undriveable). Legal order runs it last.
  stopsByDate[DAY] = [
    stop('T1', { window_start: '09:00', lng: 1, route_order: 2 }),
    stop('T2', { window_start: '13:00', lng: 2, route_order: 3 }),
    stop('U', { estimated_duration_minutes: 400, lng: 10, route_order: 1 }),
  ];
  mockOptimizerOrder(['T1', 'U', 'T2']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const applied = ledger().reorders[0];
  expect(applied).toMatchObject({ source: 'window_constrained', saved_meters: 2000, unconstrained_saved_meters: 2000 });
  expect(trxUpdates).toEqual([
    { id: 'T1', route_order: 1 },
    { id: 'T2', route_order: 2 },
    { id: 'U', route_order: 3 },
  ]);
});

test('gate ON: a LEGAL Google order never consults the fallback — applied as google_routes_api, no unconstrained delta', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Untimed backtracking day: current B(3),A(1),C(2) = 8000 m; lng-sorted
  // A,C,B = 6000 m, no windows to violate.
  stopsByDate[DAY] = [
    stop('A', { lng: 1, route_order: 2 }),
    stop('B', { lng: 3, route_order: 1 }),
    stop('C', { lng: 2, route_order: 3 }),
  ];
  mockOptimizerOrder(['A', 'C', 'B']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const applied = ledger().reorders[0];
  expect(applied.source).toBe('google_routes_api');
  expect(applied.unconstrained_saved_meters).toBeUndefined();
});

// ── Unit coverage of the search itself (custom optimizer with REAL travel
// minutes so the simulation, not just durations, constrains feasibility). ──
const FAKE_RO = {
  HQ: { lat: 1, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2),
  fallbackLegMetrics: (miles) => ({ meters: Math.round(miles * 1000), minutes: miles * 10 }),
};

test('unit: exhaustive search finds the optimal interleaving and never permutes the promised backbone', async () => {
  const stops = [
    stop('T1', { window_start: '09:00', lng: 10 }),
    stop('T2', { window_start: '13:00', lng: 1 }),
    stop('U', { lng: 2 }),
  ];
  const out = computeWindowFitOrder(FAKE_RO, stops, GUARDS);
  expect(out).not.toBeNull();
  expect(out.afterMeters).toBe(20000);
  const ids = out.orderedStops.map((s) => s.id);
  expect(ids.indexOf('T1')).toBeLessThan(ids.indexOf('T2'));
  expect(ids).toHaveLength(3);
  expect(out.afterSeconds).toBeGreaterThan(0);
});

test('unit: a day whose promises cannot all be kept returns null', async () => {
  const stops = [
    stop('T1', { window_start: '09:00', estimated_duration_minutes: 300, lng: 5 }),
    stop('T2', { window_start: '11:00', estimated_duration_minutes: 300, lng: 1 }),
  ];
  expect(computeWindowFitOrder(FAKE_RO, stops, GUARDS)).toBeNull();
});

test('unit: above the interleaving cap the greedy path still produces a full feasible order', async () => {
  // 8 untimed stops ⇒ 8! = 40320 interleavings > cap ⇒ greedy insertion.
  // On a line, cheapest-feasible insertion converges to the sorted sweep.
  const stops = Array.from({ length: 8 }, (_, i) => stop(`s${i}`, { lng: i + 1, estimated_duration_minutes: 30 }));
  expect(wfInternals.sequenceCount(8, 0, [])).toBeGreaterThan(wfInternals.EXHAUSTIVE_SEQUENCE_CAP);
  const out = computeWindowFitOrder(FAKE_RO, stops, GUARDS);
  expect(out).not.toBeNull();
  expect(out.orderedStops).toHaveLength(8);
  expect(out.afterMeters).toBe(16000);
});

test('unit: equal-window ties are PERMUTED, not frozen in input order — the only feasible tie order is found', () => {
  // A and B share the 09:00 promise (window 540–660, +2h deadline). With
  // 10 min/mile travel from HQ(1,0): A(lng 2) then B(lng 8) works — A starts
  // 540, done 600, arrive B 660 = deadline. B then A: B done at 620, arrive
  // A at 680 > 660 — infeasible. Input order is B first; a backbone frozen
  // in input order would return null (pre-push audit P1).
  const stops = [
    stop('B', { window_start: '09:00', lng: 8 }),
    stop('A', { window_start: '09:00', lng: 2 }),
  ];
  const out = computeWindowFitOrder(FAKE_RO, stops, GUARDS);
  expect(out).not.toBeNull();
  expect(out.orderedStops.map((s) => s.id)).toEqual(['A', 'B']);
});

test('unit: fewer than 2 stops is not a reorder problem', () => {
  expect(computeWindowFitOrder(FAKE_RO, [stop('only')], GUARDS)).toBeNull();
});
