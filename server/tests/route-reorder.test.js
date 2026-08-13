// ROUTE-TIERS nightly reorder pass: band day selection (tomorrow .. today+6),
// the 72h clock + reminder-sent day freezes (incl. fail-closed), the >25-stop
// Google-cap skip (logged, never truncated), the min-savings floor, the
// transactional route_order write, and the planner-runs ledger row shape.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
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
const logger = require('../services/logger');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { runRouteReorder, runRouteReorderIfEnabled } = require('../services/route-reorder');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
const NOW = new Date('2026-08-13T08:10:00Z');
const BAND = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'];

function stop(id, over = {}) {
  return { id, technician_id: 't1', route_order: null, window_start: '09:00', time_window: null, service_type: 'pest', zone: null, lat: 27.4, lng: -82.5, ...over };
}

let stopsByDate;
let ledgerInserts;
let trxUpdates;

function tableChain(table) {
  const c = { _table: table };
  ['where', 'whereIn', 'orderBy', 'limit'].forEach((m) => { c[m] = () => c; });
  c.select = () => c;
  c.first = async () => null; // no auto_dispatch run by default
  c.insert = (row) => {
    if (table === 'route_optimization_planner_runs') ledgerInserts.push(row);
    return { returning: async () => [{ id: 'ledger-1' }] };
  };
  c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  stopsByDate = {};
  ledgerInserts = [];
  trxUpdates = [];
  dayStopsQuery.mockImplementation(async (_db, { dateStr }) => stopsByDate[dateStr] || []);
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
  db.mockImplementation((table) => tableChain(table));
  db.transaction.mockImplementation(async (cb) => {
    const trx = () => ({
      where: (w) => ({ update: async (u) => { trxUpdates.push({ ...w, ...u }); return 1; } }),
    });
    return cb(trx);
  });
  RouteOptimizer.optimizeRoute.mockResolvedValue({
    orderedStops: [], totalDistanceMeters: 0, totalDurationSeconds: 0, unoptimizedDistanceMeters: 0, source: 'nearest_neighbor_fallback',
  });
});

test('band day selection: exactly tomorrow through today+6 — never today, never day 7', async () => {
  await runRouteReorder({ now: NOW });
  const dates = dayStopsQuery.mock.calls.map(([, args]) => args.dateStr);
  expect(dates).toEqual(BAND);
  expect(dates).not.toContain('2026-08-13');
  expect(dates).not.toContain('2026-08-20');
});

test('days whose visits start within 72h are skipped whole (clock freeze)', async () => {
  // 08-14 09:00 ET ≈ 29h out, 08-15 ≈ 53h — both frozen; 08-16 ≈ 77h — free.
  stopsByDate['2026-08-14'] = [stop('a')];
  stopsByDate['2026-08-15'] = [stop('b')];
  stopsByDate['2026-08-16'] = [stop('c'), stop('d')];
  RouteOptimizer.optimizeRoute.mockResolvedValue({
    orderedStops: [{ id: 'd' }, { id: 'c' }], totalDistanceMeters: 1000, totalDurationSeconds: 600, unoptimizedDistanceMeters: 5000, source: 'x',
  });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const ledger = JSON.parse(ledgerInserts[0].result);
  const skipReasons = Object.fromEntries(ledger.skips.map((s) => [s.date, s.reason]));
  expect(skipReasons['2026-08-14']).toBe('WITHIN_72H');
  expect(skipReasons['2026-08-15']).toBe('WITHIN_72H');
  expect(ledger.reorders[0]).toMatchObject({ date: '2026-08-16', technician_id: 't1' });
});

test('a reminder-sent visit freezes its whole day', async () => {
  stopsByDate['2026-08-16'] = [stop('c'), stop('d')];
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set(['d']) });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-16', reason: 'REMINDER_SENT_FROZEN' }));
});

test('FAIL CLOSED: unreadable reminder status skips the day', async () => {
  stopsByDate['2026-08-17'] = [stop('e'), stop('f')];
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: true, frozen: new Set() });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-17', reason: 'REMINDER_STATUS_UNKNOWN' }));
});

test('>25 geocoded stops for one tech-day is SKIPPED and LOGGED, never truncated', async () => {
  stopsByDate['2026-08-18'] = Array.from({ length: 26 }, (_, i) => stop(`s${i}`));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('25-waypoint cap'));
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'OVER_WAYPOINT_CAP', geocoded: 26 }));
});

test('savings below the floor apply nothing', async () => {
  stopsByDate['2026-08-18'] = [stop('g'), stop('h')];
  RouteOptimizer.optimizeRoute.mockResolvedValue({
    orderedStops: [{ id: 'h' }, { id: 'g' }], totalDistanceMeters: 9600, totalDurationSeconds: 600, unoptimizedDistanceMeters: 10000, source: 'x',
  });
  const res = await runRouteReorder({ now: NOW }); // saved 400m < default 805m
  expect(res.applied).toBe(0);
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ reason: 'BELOW_MIN_SAVINGS', saved_meters: 400 }));
});

test('savings above the floor rewrite route_order transactionally in optimized order', async () => {
  stopsByDate['2026-08-18'] = [stop('g', { route_order: 2 }), stop('h', { route_order: 1 }), stop('i')];
  RouteOptimizer.optimizeRoute.mockResolvedValue({
    orderedStops: [{ id: 'i' }, { id: 'g' }, { id: 'h' }], totalDistanceMeters: 4000, totalDurationSeconds: 900, unoptimizedDistanceMeters: 9000, source: 'google_routes_api',
  });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(trxUpdates).toEqual([
    { id: 'i', route_order: 1 },
    { id: 'g', route_order: 2 },
    { id: 'h', route_order: 3 },
  ]);
  // Baseline order fed to the optimizer is the CURRENT running order
  // (route_order asc, nulls last): h(1), g(2), i(null).
  const fed = RouteOptimizer.optimizeRoute.mock.calls[0][0].map((s) => s.id);
  expect(fed).toEqual(['h', 'g', 'i']);
});

test('per-tech grouping: two techs on one day are reordered independently', async () => {
  stopsByDate['2026-08-19'] = [stop('a1'), stop('a2'), stop('b1', { technician_id: 't2' }), stop('b2', { technician_id: 't2' })];
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: [...stops].reverse(), totalDistanceMeters: 1000, totalDurationSeconds: 300, unoptimizedDistanceMeters: 3000, source: 'x',
  }));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(2);
  expect(RouteOptimizer.optimizeRoute).toHaveBeenCalledTimes(2);
});

test('ledger row shape: one route_optimization_planner_runs row per run', async () => {
  stopsByDate['2026-08-18'] = [stop('g'), stop('h')];
  RouteOptimizer.optimizeRoute.mockResolvedValue({
    orderedStops: [{ id: 'h' }, { id: 'g' }], totalDistanceMeters: 4000, totalDurationSeconds: 900, unoptimizedDistanceMeters: 9000, source: 'google_routes_api',
  });
  await runRouteReorder({ now: NOW });
  expect(ledgerInserts).toHaveLength(1);
  const row = ledgerInserts[0];
  expect(row).toMatchObject({
    run_type: 'route_tiers_nightly',
    status: 'completed',
    start_date: '2026-08-14',
    end_date: '2026-08-19',
    applied_count: 1,
    failed_count: 0,
  });
  expect(JSON.parse(row.technician_ids)).toEqual(['t1']);
  const constraints = JSON.parse(row.constraints);
  expect(constraints).toMatchObject({ gate: 'GATE_ROUTE_REORDER', min_savings_meters: 805, waypoint_cap: 25, freeze_hours: 72 });
  const result = JSON.parse(row.result);
  expect(result.reorders[0]).toMatchObject({
    date: '2026-08-18',
    technician_id: 't1',
    stops: 2,
    before_distance_meters: 9000,
    after_distance_meters: 4000,
    saved_meters: 5000,
    source: 'google_routes_api',
  });
  expect(result).toHaveProperty('auto_dispatch');
});

test('GATE_ROUTE_REORDER off ⇒ hard no-op (no queries, no ledger)', async () => {
  const orig = process.env.GATE_ROUTE_REORDER;
  delete process.env.GATE_ROUTE_REORDER;
  try {
    const res = await runRouteReorderIfEnabled();
    expect(res).toEqual({ status: 'gate_off' });
    expect(dayStopsQuery).not.toHaveBeenCalled();
    expect(ledgerInserts).toHaveLength(0);
  } finally {
    if (orig !== undefined) process.env.GATE_ROUTE_REORDER = orig;
  }
});
