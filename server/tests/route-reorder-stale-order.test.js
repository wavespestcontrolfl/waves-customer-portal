// Stale-order canonicalization (GATE_ROUTE_REORDER_STALE_ORDER /
// opts.canonicalizeStale, owner-approved 2026-09-26: "kill the stale June
// numbers", "a driveable order beats a stale one"). Covered: gate/option OFF
// is byte-for-byte today's behavior; a stale day with no improvement over the
// promised-window baseline gets the baseline written (source
// 'promised_window'); a stale day where Google/window-fit genuinely beats
// the baseline is applied normally with a `canonicalized` ledger tag; a
// stale day Google can't even run (coordless) still gets the baseline;
// every freeze/LOCKED_STOP/MAX_APPLIES invariant still applies; opts.dates
// reaches D+7..D+30 only when this mode is enabled; opts.dryRun writes
// nothing and returns a plan.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
// Deterministic geometry: HQ at the origin, manhattan-degree "miles", and a
// 1000 m/mile leg model — so model distances are exact integers in tests.
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
const { runRouteReorder } = require('../services/route-reorder');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
const NOW = new Date('2026-08-13T08:10:00Z');
const DAY = '2026-08-17';

function stop(id, over = {}) {
  return { id, technician_id: 't1', route_order: null, window_start: '09:00', time_window: null, service_type: 'pest', zone: null, lat: 1, lng: 1, service_address_line1: null, visit_id: null,
    customer_address_line1: '100 Main St', customer_address_line2: null,
    customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205', ...over };
}

let stopsByDate;
let ledgerInserts;
let trxUpdates;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_ROUTE_REORDER_STALE_ORDER;
  stopsByDate = {};
  ledgerInserts = [];
  trxUpdates = [];
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
    c.first = async () => null;
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
          .map((s) => ({ id: s.id, window_start: s.window_start, window_end: s.window_end, visit_id: s.visit_id, time_window: s.time_window, estimated_duration_minutes: s.estimated_duration_minutes, auto_dispatch_locked: s.auto_dispatch_locked, auto_dispatch_excluded: s.auto_dispatch_excluded, route_order: s.route_order, lat: s.lat, lng: s.lng,
            service_address_line1: s.service_address_line1, service_address_line2: s.service_address_line2,
            service_address_city: s.service_address_city, service_address_zip: s.service_address_zip,
            customer_id: s.customer_id,
            customer_address_line1: s.customer_address_line1, customer_address_line2: s.customer_address_line2,
            customer_city: s.customer_city, customer_state: s.customer_state, customer_zip: s.customer_zip })),
        update: async (u) => { attempted.push({ id: filters.id, ...u }); return 1; },
      };
      return c;
    };
    trx.raw = async () => {};
    const out = await cb(trx);
    trxUpdates.push(...attempted);
    return out;
  });
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: [...stops].sort((p, q) => p.lng - q.lng),
    totalDistanceMeters: 12345,
    totalDurationSeconds: 600,
    source: 'google_routes_api',
  }));
});

const ledger = () => JSON.parse(ledgerInserts[0].result);

describe('mode OFF — byte-for-byte the pre-existing behavior', () => {
  test('gate off, option off: a stale (gapped) day skips BELOW_MIN_SAVINGS exactly as before — no canonicalized tag, no write', async () => {
    stopsByDate[DAY] = [
      stop('a', { lng: 1, route_order: 1 }),
      stop('b', { lng: 2, route_order: 3 }), // gap: 1,3 — no '2'
    ];
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    const skip = ledger().skips.find((s) => s.date === DAY);
    expect(skip).toMatchObject({ reason: 'BELOW_MIN_SAVINGS' });
    expect(skip.canonicalized).toBeUndefined();
  });

  test('gate off: a coordless stale day still skips COORDLESS_STOPS — no baseline attempted', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }),
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'COORDLESS_STOPS' });
  });
});

describe('mode ON — canonicalization', () => {
  test('nothing beats the promised-window baseline: the baseline itself is written, renumbering the gap', async () => {
    // A(2), B(null), C(3) — window ties (all 09:00), so currentOrder =
    // A,C,B (lng 1,2,3 = the lng-sorted order Google also returns): both the
    // stale order AND Google's order already equal 8000 m, so nothing beats
    // the 805 m floor. The promised-window baseline (tie-break by id: A,B,C)
    // also totals 8000 m but renumbers A:2→1 and B:null→2 — a real,
    // driveable renumbering with zero distance change.
    stopsByDate[DAY] = [
      stop('A', { lng: 1, route_order: 2 }),
      stop('B', { lng: 3, route_order: null }),
      stop('C', { lng: 2, route_order: 3 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(1);
    expect(trxUpdates).toEqual([
      { id: 'A', route_order: 1 },
      { id: 'B', route_order: 2 },
      { id: 'C', route_order: 3 },
    ]);
    const applied = ledger().reorders[0];
    expect(applied).toMatchObject({
      date: DAY, source: 'promised_window', saved_meters: 0,
      canonicalized: { reasons: ['null'], source: 'promised_window' },
    });
    expect(applied.route_order_changes).toEqual(expect.arrayContaining([
      { id: 'A', before: 2, after: 1 },
      { id: 'B', before: null, after: 2 },
    ]));
    expect(RouteOptimizer.optimizeRoute).toHaveBeenCalled();
  });

  test('a Google order that genuinely beats the baseline is applied, tagged canonicalized: source google', async () => {
    // Alphabetical id order (the baseline's tie-break, since all three share
    // one window) maps to lng 2,1,3 — a backtracking 10000 m tour. Google's
    // lng-ascending pick (1,2,3) is the direct 8000 m tour — 2000 m clear of
    // the 805 m floor against the BASELINE (the stale stored order, gapped
    // 1,2,4, coincidentally tours the same backtracking 10000 m path).
    stopsByDate[DAY] = [
      stop('p1', { lng: 2, route_order: 1 }),
      stop('p2', { lng: 1, route_order: 2 }),
      stop('p3', { lng: 3, route_order: 4 }), // gap: 1,2,4
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(1);
    expect(trxUpdates).toEqual([
      { id: 'p2', route_order: 1 },
      { id: 'p1', route_order: 2 },
      { id: 'p3', route_order: 3 },
    ]);
    const applied = ledger().reorders[0];
    expect(applied).toMatchObject({
      source: 'google_routes_api',
      before_distance_meters: 10000,
      after_distance_meters: 8000,
      saved_meters: 2000,
      canonicalized: { reasons: ['gap'], source: 'google' },
    });
  });

  test('a coordless stale day gets the baseline written — Google is never called', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }),
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(1);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(trxUpdates).toEqual([
      { id: 'a', route_order: 1 },
      { id: 'b', route_order: 2 },
      { id: 'c', route_order: 3 },
    ]);
    expect(ledger().reorders[0]).toMatchObject({
      // 'a' is chronologically first (09:00) but its null position sorts it
      // LAST in the board's default order — a real inversion, not a quirk.
      source: 'promised_window', canonicalized: { reasons: ['null', 'inversion'], source: 'promised_window' },
    });
  });

  test('too few geocoded stops on a stale day still gets the baseline written', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null, lat: null, lng: null }),
      stop('b', { window_start: '11:00', route_order: 2, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(1);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(trxUpdates).toEqual([{ id: 'a', route_order: 1 }, { id: 'b', route_order: 2 }]);
  });

  test('a non-stale day is completely unaffected — no canonicalized tag, ordinary floor applies', async () => {
    // Complete, chronological (all one tied window) but distance-inefficient
    // — staleOrderReasons finds nothing wrong with the NUMBERING, only the
    // route is backtracking. currentOrder (B,A,C) = 10000 m; Google's
    // lng-ascending pick (A,C,B) = 8000 m, 2000 m clear of the floor.
    stopsByDate[DAY] = [
      stop('A', { lng: 1, route_order: 2 }),
      stop('B', { lng: 3, route_order: 1 }),
      stop('C', { lng: 2, route_order: 3 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(1);
    const applied = ledger().reorders[0];
    expect(applied).toMatchObject({ source: 'google_routes_api', before_distance_meters: 10000, after_distance_meters: 8000 });
    // Not stale, so no `canonicalized` tag — but route_order_changes still
    // rides along while the mode is on (the cleanup script's backup file
    // needs an exact per-row before/after for any day it touches, not only
    // the ones staleOrderReasons actually flagged).
    expect(applied.canonicalized).toBeUndefined();
    // Google's lng-ascending pick is A,C,B — every stop's position moves.
    expect(applied.route_order_changes).toEqual(expect.arrayContaining([
      { id: 'A', before: 2, after: 1 },
      { id: 'C', before: 3, after: 2 },
      { id: 'B', before: 1, after: 3 },
    ]));
  });

  test('a frozen stale day is never canonicalized — WITHIN_72H wins', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    const frozenDay = '2026-08-14'; // ~29h out — inside the 72h clock freeze
    stopsByDate[frozenDay] = [
      stop('a', { route_order: null }),
      stop('b', { route_order: 2 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(ledger().skips.find((s) => s.date === frozenDay)).toMatchObject({ reason: 'WITHIN_72H' });
  });

  test('a locked stale day is never canonicalized', async () => {
    stopsByDate[DAY] = [
      stop('a', { route_order: null, auto_dispatch_locked: true }),
      stop('b', { route_order: 2 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'LOCKED_STOP' });
  });

  test('the GATE_ROUTE_REORDER_STALE_ORDER env gate is equivalent to opts.canonicalizeStale', async () => {
    process.env.GATE_ROUTE_REORDER_STALE_ORDER = 'true';
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null, lat: null, lng: null }),
      stop('b', { window_start: '11:00', route_order: 2, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(1);
    delete process.env.GATE_ROUTE_REORDER_STALE_ORDER;
  });

  test('opts.dates reaches D+7..D+30 only with this mode enabled, mirroring repairOnly\'s bound', async () => {
    const farDay = '2026-08-30'; // ~D+17, outside the D+1..D+6 nightly band
    stopsByDate[farDay] = [stop('a', { route_order: null }), stop('b', { route_order: 2 })];
    const withoutMode = await runRouteReorder({ now: NOW, dates: [farDay] });
    expect(dayStopsQuery).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dateStr: farDay }));
    expect(withoutMode.applied).toBe(0);
    jest.clearAllMocks();
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    const withMode = await runRouteReorder({ now: NOW, canonicalizeStale: true, dates: [farDay] });
    expect(dayStopsQuery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dateStr: farDay }));
    expect(withMode.applied).toBe(1);
  });

  test('a custom run_type (the cleanup script) is honored on the ledger row', async () => {
    stopsByDate[DAY] = [stop('a', { route_order: null }), stop('b', { route_order: 2 })];
    await runRouteReorder({ now: NOW, canonicalizeStale: true, runType: 'route_order_cleanup' });
    expect(ledgerInserts[0].run_type).toBe('route_order_cleanup');
  });

  test('opts.dryRun writes nothing, opens no transaction, and returns a per-tech-day plan', async () => {
    stopsByDate[DAY] = [
      stop('A', { lng: 1, route_order: 2 }),
      stop('B', { lng: 3, route_order: null }),
      stop('C', { lng: 2, route_order: 3 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true, dryRun: true });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(ledgerInserts).toEqual([]);
    expect(res.status).toBe('completed');
    expect(res.plan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date: DAY, technicianId: 't1', reasons: ['null'], source: 'promised_window',
        before: ['A', 'C', 'B'], after: ['A', 'B', 'C'], skipped_reason: null,
      }),
    ]));
  });

  test('a dry run over an otherwise-skipped day reports the skip reason, not a false plan', async () => {
    stopsByDate[DAY] = [stop('a', { route_order: 1 }), stop('b', { route_order: 2 })]; // identical points, complete order — no savings, not stale
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true, dryRun: true });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(res.plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: DAY, technicianId: 't1', skipped_reason: 'BELOW_MIN_SAVINGS' }),
    ]));
  });
});
