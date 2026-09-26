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
const routeReorder = require('../services/route-reorder');
const { promisedWindowOrder } = require('../services/route-reorder-window-fit');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { applyRollback } = require('../../scripts/route-order-cleanup');

const { runRouteReorder, writeTechDayOrder, _internals } = routeReorder;

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

describe('opts.repairOnly excludes canonicalization entirely, even with the gate on', () => {
  // codex pre-push P1: a coordless/over-cap stale day reached the
  // canonicalize-only write attempt BEFORE the `opts.repairOnly && !repair`
  // skip even ran, so a change-triggered repair pass could canonicalize a
  // day the nightly band hasn't reached yet. Canonicalization only ever
  // runs from the nightly band pass or the cleanup script's own
  // canonicalizeStale run — neither sets opts.repairOnly.
  const repairGateEnv = ['GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION', 'GATE_ROUTE_REORDER'];
  beforeEach(() => {
    for (const g of repairGateEnv) process.env[g] = 'true';
    process.env.GATE_ROUTE_REORDER_STALE_ORDER = 'true';
  });
  afterEach(() => {
    for (const g of repairGateEnv) delete process.env[g];
    delete process.env.GATE_ROUTE_REORDER_STALE_ORDER;
  });

  test('a coordless stale day under repairOnly skips COORDLESS_STOPS — no canonicalize write, Google never called', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }), // stale (null position)
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }), // coordless
    ];
    const res = await runRouteReorder({ now: NOW, repairOnly: true, dates: [DAY] });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    const skip = ledger().skips.find((s) => s.date === DAY);
    expect(skip).toMatchObject({ reason: 'COORDLESS_STOPS' });
    expect(skip.canonicalized).toBeUndefined();
  });

  test('the same stale day WITHOUT repairOnly (nightly band) DOES canonicalize — proving the gate genuinely works outside repairOnly', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }),
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(1);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled(); // still coordless — baseline needs no Google either
    expect(trxUpdates.length).toBeGreaterThan(0);
    const applied = ledger().reorders.find((r) => r.date === DAY);
    expect(applied).toMatchObject({ source: 'promised_window' });
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
    // The route-order-cleanup script's PRIMARY backup evidence: the run's
    // own return value carries what it committed, independent of the
    // ledger row (which can fail to insert or fail to read back later).
    expect(res.appliedChanges).toEqual([
      { date: DAY, technicianId: 't1', changes: expect.arrayContaining([
        { id: 'A', before: 2, after: 1 },
        { id: 'B', before: null, after: 2 },
      ]) },
    ]);
  });

  test('appliedChanges carries the committed evidence even when the ledger insert fails', async () => {
    // The exact codex P1: a null ledgerId (ledger insert failed AFTER the
    // route_order writes already committed) must not read as "nothing was
    // applied" — the run's own appliedChanges is independent of the ledger.
    db.mockImplementation((table) => {
      const c = { _table: table };
      ['where', 'whereIn', 'orderBy', 'limit'].forEach((m) => { c[m] = () => c; });
      c.select = () => c;
      c.first = async () => null;
      c.insert = () => {
        if (table === 'route_optimization_planner_runs') throw new Error('ledger insert failed');
        return { returning: async () => [{ id: 'x' }] };
      };
      c.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return c;
    });
    stopsByDate[DAY] = [
      stop('A', { lng: 1, route_order: 2 }),
      stop('B', { lng: 3, route_order: null }),
      stop('C', { lng: 2, route_order: 3 }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.ledgerId).toBeNull();
    expect(res.applied).toBe(1);
    expect(trxUpdates).toEqual([
      { id: 'A', route_order: 1 },
      { id: 'B', route_order: 2 },
      { id: 'C', route_order: 3 },
    ]);
    expect(res.appliedChanges).toEqual([
      { date: DAY, technicianId: 't1', changes: expect.arrayContaining([
        { id: 'A', before: 2, after: 1 },
        { id: 'B', before: null, after: 2 },
      ]) },
    ]);
  });

  test('gate off / mode off never carries appliedChanges — the return shape is byte-for-byte unchanged', async () => {
    // Same backtracking-but-chronological fixture as the "non-stale day"
    // test below: distance-inefficient, not stale, clears the floor.
    stopsByDate[DAY] = [
      stop('A', { lng: 1, route_order: 2 }),
      stop('B', { lng: 3, route_order: 1 }),
      stop('C', { lng: 2, route_order: 3 }),
    ];
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(1);
    expect(res).not.toHaveProperty('appliedChanges');
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

  test('a leading gap (future day numbered 4,5,6, nothing before) is now recognized as stale — codex pre-push P2', async () => {
    // Fully numbered, no duplicates, no ADJACENT gap between 4-5-6, and
    // already chronological — the OLD adjacent-only gap check found nothing
    // wrong with this at all (it looks exactly like a resumed prefix on a
    // day already in progress). This is a FUTURE day, which has no such
    // excuse — canonicalizeStale mode now passes `futureDay: true` and
    // flags the leading gap.
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: 4, lat: null, lng: null }),
      stop('b', { window_start: '11:00', route_order: 5, lat: null, lng: null }),
      stop('c', { window_start: '13:00', route_order: 6, lat: null, lng: null }),
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
      source: 'promised_window', canonicalized: { reasons: ['gap'], source: 'promised_window' },
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

describe('promised-window baseline chronology (codex pre-push P1)', () => {
  // visit_id siblings at 09:00 (a) and 11:00 (c) plus an unrelated 10:00
  // stop (b): promisedWindowOrder pulls c adjacent to a — 09→11→10.
  const groupedDay = (coords = {}) => [
    stop('a', { window_start: '09:00', visit_id: 'v1', route_order: null, ...coords.a }),
    stop('b', { window_start: '10:00', route_order: 2, customer_address_line1: '200 Oak St', ...coords.b }),
    stop('c', { window_start: '11:00', visit_id: 'v1', route_order: 3, ...coords.c }),
  ];

  test('the repro: the grouped baseline is out of window order, so canonicalizeBaselineOrder refuses it', () => {
    expect(promisedWindowOrder(groupedDay()).map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(_internals.canonicalizeBaselineOrder(RouteOptimizer, groupedDay()))
      .toEqual({ conflict: 'WINDOW_ORDER_CONFLICT' });
  });

  test('a coordless stale day skips WINDOW_ORDER_CONFLICT and writes nothing — never the 09→11→10 baseline', async () => {
    stopsByDate[DAY] = groupedDay({ c: { lat: null, lng: null } });
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'WINDOW_ORDER_CONFLICT', source: 'promised_window' });
  });

  test('a geocoded stale day where Google saves nothing skips WINDOW_ORDER_CONFLICT instead of writing the baseline', async () => {
    stopsByDate[DAY] = groupedDay({ a: { lng: 1 }, b: { lng: 2 }, c: { lng: 3 } });
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true });
    expect(RouteOptimizer.optimizeRoute).toHaveBeenCalled();
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'WINDOW_ORDER_CONFLICT', source: 'promised_window' });
  });
});

describe('MAX_APPLIES_REACHED outranks the coordinate skips on a canonicalize day (codex pre-push P2)', () => {
  test('a coordless stale day at the cap reports MAX_APPLIES_REACHED, not COORDLESS_STOPS', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }),
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true, maxAppliesPerRun: 0 });
    expect(res.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'MAX_APPLIES_REACHED' });
  });

  test('a too-few-geocoded stale day at the cap reports MAX_APPLIES_REACHED, not TOO_FEW_GEOCODED_STOPS', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null, lat: null, lng: null }),
      stop('b', { window_start: '11:00', route_order: 2, lat: null, lng: null }),
    ];
    const res = await runRouteReorder({ now: NOW, canonicalizeStale: true, maxAppliesPerRun: 0 });
    expect(res.applied).toBe(0);
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'MAX_APPLIES_REACHED' });
  });

  test('mode off: the same coordless day at the cap still reports COORDLESS_STOPS (unchanged precedence)', async () => {
    stopsByDate[DAY] = [
      stop('a', { window_start: '09:00', route_order: null }),
      stop('b', { window_start: '11:00', route_order: 2 }),
      stop('c', { window_start: '13:00', route_order: 3, lat: null, lng: null }),
    ];
    await runRouteReorder({ now: NOW, maxAppliesPerRun: 0 });
    expect(ledger().skips.find((s) => s.date === DAY)).toMatchObject({ reason: 'COORDLESS_STOPS' });
  });

  test('a stale but FROZEN coordless day at the cap keeps its freeze outcome — never canonicalized, never reported as capped', async () => {
    const frozenDay = '2026-08-14';
    stopsByDate[frozenDay] = [
      stop('a', { route_order: null }),
      stop('b', { route_order: 2, lat: null, lng: null }),
    ];
    await runRouteReorder({ now: NOW, canonicalizeStale: true, maxAppliesPerRun: 0 });
    expect(ledger().skips.find((s) => s.date === frozenDay)).toMatchObject({ reason: 'WITHIN_72H' });
  });
});

describe('writeTechDayOrder explicit positions (rollback) — persisted values', () => {
  // A real future date: the rollback passes no opts.now, so the writer's
  // commit-time today/freeze re-checks read the wall clock.
  const FUTURE = etDateString(addETDays(new Date(), 10));

  // readLiveTechDay's unlocked read + the writer's own fenced transaction
  // (the trx fake above, which records every UPDATE's values).
  function rollbackConn() {
    const conn = () => {
      const filters = {};
      const c = {
        where: (col, val) => { filters[String(col).replace('scheduled_services.', '')] = val; return c; },
        whereNotIn: () => c,
        whereRaw: () => c,
        leftJoin: () => c,
        select: () => Promise.resolve((stopsByDate[filters.scheduled_date] || [])
          .filter((s) => s.technician_id === filters.technician_id)),
      };
      return c;
    };
    conn.raw = (sql) => sql;
    conn.transaction = db.transaction;
    return conn;
  }

  function realDeps() {
    return {
      writeTechDayOrder, classifyWriteError: routeReorder.classifyWriteError,
      ROUTE_WRITE_GUARD_COLUMNS: routeReorder.ROUTE_WRITE_GUARD_COLUMNS,
      CUSTOMER_PREMISE_ALIASES: routeReorder.CUSTOMER_PREMISE_ALIASES,
      guardedCoordSelects: jest.requireMock('../services/scheduling/day-stops').guardedCoordSelects,
      EXCLUDE_STATUSES: _internals.EXCLUDE_STATUSES, LIVE_HOLD_SQL: _internals.LIVE_HOLD_SQL,
      RouteOptimizer, violatesWindowChronology: _internals.violatesWindowChronology,
      violatesWindowFeasibility: _internals.violatesWindowFeasibility,
    };
  }

  test('rollback through the REAL writer persists 4,5,null exactly — the null-position row stays null', async () => {
    // Original A=4, B=5, C=null; the cleanup renumbered them 1,2,3.
    stopsByDate[FUTURE] = [
      stop('A', { window_start: '09:00', route_order: 1 }),
      stop('B', { window_start: '11:00', route_order: 2 }),
      stop('C', { window_start: '13:00', route_order: 3 }),
    ];
    const backup = [
      { id: 'A', date: FUTURE, technician_id: 't1', before: 4, after: 1 },
      { id: 'B', date: FUTURE, technician_id: 't1', before: 5, after: 2 },
      { id: 'C', date: FUTURE, technician_id: 't1', before: null, after: 3 },
    ];
    const result = await applyRollback(rollbackConn(), backup, new Date(), realDeps());
    expect(result.summary).toEqual({ skipped: [], failed: [] });
    expect(result.restored).toBe(3);
    expect(trxUpdates).toEqual([
      { id: 'A', route_order: 4 },
      { id: 'B', route_order: 5 },
      { id: 'C', route_order: null },
    ]);
  });

  test('a row the backup never touched is written back to its own current value', async () => {
    stopsByDate[FUTURE] = [
      stop('A', { window_start: '09:00', route_order: 2 }),
      stop('X', { window_start: '11:00', route_order: 7 }),
    ];
    const backup = [{ id: 'A', date: FUTURE, technician_id: 't1', before: 6, after: 2 }];
    await applyRollback(rollbackConn(), backup, new Date(), realDeps());
    expect(trxUpdates).toEqual([{ id: 'A', route_order: 6 }, { id: 'X', route_order: 7 }]);
  });

  test('a positions map missing a stop rolls the whole tech-day back — nothing persisted', async () => {
    stopsByDate[FUTURE] = [stop('A', { route_order: 1 }), stop('B', { route_order: 2 })];
    const techStops = stopsByDate[FUTURE];
    await expect(writeTechDayOrder(db, {
      dateStr: FUTURE, techId: 't1', techStops, finalOrdered: techStops, repair: null,
      opts: { positions: new Map([['A', 1]]) }, now: new Date(), repairGates: [],
    })).rejects.toMatchObject({ code: 'STALE_TECH_DAY' });
    expect(trxUpdates).toEqual([]);
  });

  test('without opts.positions the writer still numbers index+1 (the forward pass, unchanged)', async () => {
    stopsByDate[FUTURE] = [stop('A', { route_order: 5 }), stop('B', { route_order: null })];
    const techStops = stopsByDate[FUTURE];
    await writeTechDayOrder(db, {
      dateStr: FUTURE, techId: 't1', techStops, finalOrdered: [techStops[1], techStops[0]], repair: null,
      opts: {}, now: new Date(), repairGates: [],
    });
    expect(trxUpdates).toEqual([{ id: 'B', route_order: 1 }, { id: 'A', route_order: 2 }]);
  });
});
