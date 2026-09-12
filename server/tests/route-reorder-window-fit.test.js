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
const {
  computeWindowFitOrder, computeChronologicalRepair, simulateArrivalRoute, effectiveWindowRange,
  _internals: wfInternals,
} = require('../services/route-reorder-window-fit');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
// 08-17 is ~4 days out — inside the reorder band, outside every freeze.
const NOW = new Date('2026-08-13T08:10:00Z');
const DAY = '2026-08-17';

function stop(id, over = {}) {
  // service_address_line1 is null on a real row that inherits the
  // customer's address — present-but-null, which is what the guard needs.
  return { id, technician_id: 't1', route_order: null, window_start: null, time_window: null, estimated_duration_minutes: 60, service_type: 'pest', zone: null, lat: 1, lng: 1, service_address_line1: null, visit_id: null,
    // A real row: unstamped, so its premise is the customer's own
    // primary address (the columns the day load aliases).
    customer_address_line1: '100 Main St', customer_address_line2: null,
    customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205', ...over };
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
          .map((s) => ({ id: s.id, window_start: s.window_start, time_window: s.time_window, estimated_duration_minutes: s.estimated_duration_minutes, auto_dispatch_locked: s.auto_dispatch_locked, auto_dispatch_excluded: s.auto_dispatch_excluded, route_order: s.route_order, lat: s.lat, lng: s.lng,
            // Same projection the day load selects — the commit fence hashes
            // the effective premise (customer fallback included).
            window_end: s.window_end, visit_id: s.visit_id, customer_id: s.customer_id,
            service_address_line1: s.service_address_line1, service_address_line2: s.service_address_line2,
            service_address_city: s.service_address_city, service_address_zip: s.service_address_zip,
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

test('gate ON: a below-floor ILLEGAL Google order still reaches the fallback — the floor applies to the legal order', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Google's routed-distance pick scores 0 model savings AND runs the 13:00
  // promise before the 09:00 one; exiting on BELOW_MIN_SAVINGS would hide
  // the legal order that saves 18000 m (audit r3 P1). Current U,T2,T1 =
  // 42000 m; Google returns the SAME illegal sequence (model saving 0,
  // chronology illegal); legal best T1,U,T2 = 24000 m.
  stopsByDate[DAY] = [
    stop('T1', { window_start: '09:00', lng: 10, route_order: 3 }),
    stop('T2', { window_start: '13:00', lng: 1, route_order: 2 }),
    stop('U', { lng: 11, route_order: 1 }),
  ];
  mockOptimizerOrder(['U', 'T2', 'T1']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const applied = ledger().reorders[0];
  expect(applied).toMatchObject({
    source: 'window_constrained',
    before_distance_meters: 42000,
    after_distance_meters: 24000,
    saved_meters: 18000,
    unconstrained_saved_meters: 0,
  });
  expect(ledger().skips.find((s) => s.date === DAY)).toBeUndefined();
});

test('gate OFF: a below-floor illegal Google order still skips BELOW_MIN_SAVINGS — legacy sequencing byte for byte', async () => {
  stopsByDate[DAY] = [
    stop('T1', { window_start: '09:00', lng: 10, route_order: 3 }),
    stop('T2', { window_start: '13:00', lng: 1, route_order: 2 }),
    stop('U', { lng: 11, route_order: 1 }),
  ];
  mockOptimizerOrder(['U', 'T2', 'T1']);
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  const skip = ledger().skips.find((s) => s.date === DAY);
  expect(skip).toMatchObject({ reason: 'BELOW_MIN_SAVINGS', saved_meters: 0 });
  expect(skip.fallback).toBeUndefined();
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

test('unit: above the cap, greedy still permutes equal-window ties — infeasible stable tie order is not a false null', async () => {
  // Same B/A 09:00 tie as above (only A-then-B is feasible; input order is
  // B-first), plus 8 untimed stops pushing the full-day sequence count over
  // the cap (10!/2! ≫ 20k) so the greedy path runs. A frozen stable backbone
  // would be infeasible and return null (uncapped audit P1); the tie space
  // alone (2! = 2) is searched first. The A→B leg has zero slack, so every
  // untimed stop must land after B — which greedy insertion finds.
  const stops = [
    stop('B', { window_start: '09:00', lng: 8 }),
    stop('A', { window_start: '09:00', lng: 2 }),
    ...Array.from({ length: 8 }, (_, i) => stop(`u${i}`, { lng: 9 + i, estimated_duration_minutes: 30 })),
  ];
  const out = computeWindowFitOrder(FAKE_RO, stops, GUARDS);
  expect(out).not.toBeNull();
  expect(out.orderedStops).toHaveLength(10);
  expect(out.orderedStops.slice(0, 2).map((s) => s.id)).toEqual(['A', 'B']);
});

test('unit: fewer than 2 stops is not a reorder problem', () => {
  expect(computeWindowFitOrder(FAKE_RO, [stop('only')], GUARDS)).toBeNull();
});

// ── Codex #4430 round 5 P1 ───────────────────────────────────────────────
// The repair ranks candidate orders by distance. Ranking them from HQ while
// the feasibility check and the reported figures start at the truck's real
// position picks a longer route over a shorter feasible one.
test('unit: candidate orders are scored from the supplied origin, not HQ', () => {
  const st = (id, lng) => stop(id, { technician_id: 't1', lng, estimated_duration_minutes: 30 });
  // From HQ (lng 0) visiting NEAR (lng 1) first is cheaper; from a truck
  // parked at lng 20 the cheaper loop starts with FAR (lng 19).
  const stops = [st('NEAR', 1), st('FAR', 19)];
  const fromHq = computeWindowFitOrder(RouteOptimizer, stops, GUARDS);
  const fromTruck = computeWindowFitOrder(RouteOptimizer, stops, GUARDS, { origin: { lat: 1, lng: 20 } });
  expect(fromHq.orderedStops.map((s) => s.id)).toEqual(['NEAR', 'FAR']);
  expect(fromTruck.orderedStops.map((s) => s.id)).toEqual(['FAR', 'NEAR']);
});

// ── PHANTOM-HOUR FIX (Sat 2026-09-12: customers A + B, each with a
// same-slot pest+lawn pair, visit_id NULL). The rows the prod defect was
// made of carry NO real estimate, so each one's workDuration falls back to
// its promised WINDOW SPAN — one hour EACH for a single one-hour promise.
// A chain of them is charged the sum of its REAL estimates, floored by the
// longest member's window-derived duration: the phantom hour disappears,
// but two rows that really do carry additive estimates still cost both
// (Codex #4435 r1 P1). Zero-travel model (RouteOptimizer mock above)
// isolates the effect to windows + durations. ──
describe('co-visit pair collapse', () => {
  // The prod shape: both rows promised 13:00-14:00, neither with a real
  // estimate, so workDuration = the 60-minute span for each. Merged = 60
  // → departs 840. Pre-fix (summed spans) = 120 → 900, past an 845 cutoff.
  const spanPair = (over = {}) => [
    stop('pest', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1 }),
    stop('lawn', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1, ...over }),
  ];

  test('(a) same-customer same-slot pair, no real estimates: one hour on site, not two', () => {
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, spanPair(), { dayEndMin: 845 });
    expect(sim).not.toBeNull();
    expect(sim.arrivals).toEqual([
      { id: 'pest', arrivalMin: 780, departureMin: 840 },
      { id: 'lawn', arrivalMin: 780, departureMin: 840 }, // pinned to the sibling's arrival — same stop
    ]);
  });

  test('(b) different customers in the identical slot are still charged BOTH spans (no merge)', () => {
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, spanPair({ customer_id: 'someone_else' }), { dayEndMin: 845 });
    expect(sim).toBeNull(); // 780 + 60 + 60 = 900 > the 845 cutoff
  });

  test('(d) a stop missing customer_id never merges — same numbers, behavior unchanged', () => {
    const stops = spanPair().map(({ customer_id, ...s }) => s);
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 });
    expect(sim).toBeNull(); // identical to the different-customer case above
  });

  test('(e) a visit_id on either row never merges — a real service_visits group keeps its SUM contract', () => {
    for (const idx of [0, 1]) {
      const stops = spanPair();
      stops[idx] = { ...stops[idx], visit_id: 'sv_1' };
      const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 });
      expect(sim).toBeNull(); // 900 > 845, exactly as pre-fix
    }
  });

  test('(f) a coordless side never merges — an ungeocoded row is not provably the same property', () => {
    for (const idx of [0, 1]) {
      const stops = spanPair();
      stops[idx] = { ...stops[idx], lat: null, lng: null };
      const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 });
      expect(sim).toBeNull();
    }
  });

  test('(h) two units at one parcel centroid never merge — identical coordinates are not one stop', () => {
    // Same customer, same slot, same pin (one building), DIFFERENT stamped
    // street lines: two physical stops that each need their own hour.
    const stops = spanPair({ service_address_line1: '100 Main St Apt 2' });
    stops[0] = { ...stops[0], service_address_line1: '100 Main St Apt 1' };
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 });
    expect(sim).toBeNull();
    // Both stamped the SAME unit ⇒ one stop again.
    stops[0] = { ...stops[0], service_address_line1: '100 Main St Apt 2' };
    expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 })).not.toBeNull();
  });

  test('(i) rows carrying REAL estimates are additive — the merge never under-counts genuine work', () => {
    // 45 + 40 minutes of actual work sharing one promise is 85 minutes on
    // site, not 45: the span floor (45) loses to the summed estimates.
    const stops = [
      stop('pest', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 45, lat: 1, lng: 1 }),
      stop('lawn', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 40, lat: 1, lng: 1 }),
    ];
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, {});
    expect(sim.arrivals).toEqual([
      { id: 'pest', arrivalMin: 780, departureMin: 840 }, // the 60-minute span floor
      { id: 'lawn', arrivalMin: 780, departureMin: 865 }, // 780 + max(60, 45 + 40)
    ]);
    expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 860 })).toBeNull();
  });

  test('(g) the extra minutes a co-visit adds past its sibling respect blockedIntervals and count as waiting', () => {
    // pest departs 840 (its 60-minute span); lawn's real 75-minute estimate
    // adds 15 more, 840→855, but a block covers 845-865, so the extra work
    // starts after it: clock 880, and the whole 25-minute postponement
    // (840→865) is recorded as on-site waiting.
    const stops = [
      stop('pest', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1 }),
      stop('lawn', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 75, lat: 1, lng: 1 }),
    ];
    const blockedIntervals = [{ startMin: 845, endMin: 865 }];
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { blockedIntervals });
    expect(sim).not.toBeNull();
    expect(sim.arrivals).toEqual([
      { id: 'pest', arrivalMin: 780, departureMin: 840 },
      { id: 'lawn', arrivalMin: 780, departureMin: 880 },
    ]);
    const free = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, {});
    expect(free.arrivals[1].departureMin).toBe(855); // 780 + max(60, 75)
    expect(sim.waitingMin - free.waitingMin).toBe(25); // the block's own postponement
  });

  // (c) Saturday shape: backbone 10:00 (ro=3) + 11:00 (ro=7); additions =
  // 11:00 lawn (customer A's co-visit twin of the 11:00 backbone stop), a
  // 13:00 pest+lawn pair (customer B, both additions) SEPARATED in the natural
  // id/window-start ordering by a third customer's own 13:00 addition
  // (proving the adjacency fix — without it the pair is split and the
  // merge never fires), a 15:00 single, and a 16:00-18:00 120-minute job.
  // Both pairs are span-only rows (the prod shape), so each pair costs its
  // one promised hour rather than two.
  test('(c) repair keeps every co-visit pair adjacent and returns an order for the Saturday shape', () => {
    const spanStop = (id, over) => stop(id, { estimated_duration_minutes: null, ...over });
    const stops = [
      spanStop('b10', { customer_id: 'c_other', route_order: 3, window_start: '10:00', window_end: '11:00', lat: 1, lng: 1 }),
      spanStop('a_pest', { customer_id: 'cust_a', route_order: 7, window_start: '11:00', window_end: '12:00', lat: 2, lng: 2 }),
      spanStop('a_lawn', { customer_id: 'cust_a', route_order: null, window_start: '11:00', window_end: '12:00', lat: 2, lng: 2 }),
      spanStop('b_pest', { customer_id: 'cust_b', route_order: null, window_start: '13:00', window_end: '14:00', lat: 3, lng: 3 }),
      // Sorts between b_pest and b_z_lawn by id alone (no route_order,
      // no created_at — currentOrder's final tiebreak) unless the sibling
      // adjacency fix pulls b_z_lawn ahead of it.
      // 100 real minutes: wedged between the pair (its natural id-tiebreak
      // position) it pushes b_z_lawn past its 15:00 deadline, so the
      // baseline is genuinely infeasible and a repair is required.
      stop('b_x_other', { customer_id: 'c_other2', route_order: null, window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 100, lat: 4, lng: 4 }),
      spanStop('b_z_lawn', { customer_id: 'cust_b', route_order: null, window_start: '13:00', window_end: '14:00', lat: 3, lng: 3 }),
      spanStop('sam_15', { customer_id: 'sam', route_order: null, window_start: '15:00', window_end: '16:00', lat: 5, lng: 5 }),
      spanStop('pat_16', { customer_id: 'pat', route_order: null, window_start: '16:00', window_end: '18:00', lat: 6, lng: 6 }),
    ];
    const repair = computeChronologicalRepair(RouteOptimizer, stops);
    expect(repair).not.toBeNull();
    // The adjacency fix pulls b_z_lawn ahead of b_x_other (its
    // id-only tiebreak position); every other stop keeps its natural
    // window-start order.
    expect(repair.orderedStops.map((s) => s.id)).toEqual([
      'b10', 'a_pest', 'a_lawn', 'b_pest', 'b_z_lawn', 'b_x_other', 'sam_15', 'pat_16',
    ]);
  });
});

// ── computeWindowFitOrder: same-start GROUP permutation must not split a
// co-visit pair away from its sibling — separating them costs (or here,
// genuinely BREAKS) the promise the merge exists to protect. FAKE_RO gives
// real travel (10 min/mile); P/L coincide so the pair costs 0 to traverse
// together, and visiting the 3rd stop X (a "spur" off-axis) BEFORE or
// BETWEEN P/L blows P or L's own 120-minute deadline — only X-after-the-pair
// is feasible at all, which keeps P and L adjacent by construction. ──
test('unit: computeWindowFitOrder never splits a co-visit pair away from its sibling', () => {
  const stops = [
    stop('P', { customer_id: 'cust_b', window_start: '09:00', lat: 1, lng: 5 }),
    stop('L', { customer_id: 'cust_b', window_start: '09:00', lat: 1, lng: 5 }),
    stop('X', { lat: 5, lng: 2 }), // untimed — no deadline of its own (lng ≠ 0: modelDistanceMeters treats a 0 coordinate as missing)
  ];
  const out = computeWindowFitOrder(FAKE_RO, stops, GUARDS);
  expect(out).not.toBeNull();
  const ids = out.orderedStops.map((s) => s.id);
  expect(Math.abs(ids.indexOf('P') - ids.indexOf('L'))).toBe(1);
  expect(out.afterMeters).toBe(18000);
});

// Round-0 fallback audit P1: a caller whose select carries no address column
// at all knows nothing about property identity, and unknown must not read as
// known-equal — coordinates alone are the two-units-at-one-parcel false merge.
test('unit: isCoVisitPair fails closed when the rows carry no address column', () => {
  const { isCoVisitPair } = require('../services/route-reorder-window-fit');
  const [a, b] = [
    stop('a', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', lat: 1, lng: 1 }),
    stop('b', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', lat: 1, lng: 1 }),
  ];
  expect(isCoVisitPair(effectiveWindowRange, a, b)).toBe(true); // both present-but-null
  const { service_address_line1: _dropA, ...aNoColumn } = a;
  const { service_address_line1: _dropB, ...bNoColumn } = b;
  expect(isCoVisitPair(effectiveWindowRange, aNoColumn, bNoColumn)).toBe(false);
  expect(isCoVisitPair(effectiveWindowRange, aNoColumn, b)).toBe(false);
  // Same rule for the visit_id veto: `undefined != null` is false in JS, so
  // an unselected column would otherwise no-op the one guard protecting
  // visit-groups' SUM contract.
  const { visit_id: _noVisitA, ...aNoVisit } = a;
  const { visit_id: _noVisitB, ...bNoVisit } = b;
  expect(isCoVisitPair(effectiveWindowRange, aNoVisit, bNoVisit)).toBe(false);
  expect(isCoVisitPair(effectiveWindowRange, aNoVisit, b)).toBe(false);
});

// ── Codex #4435 round 2 ──────────────────────────────────────────────────
describe('round-2 co-visit guards', () => {
  const premisePair = (over = {}) => [
    stop('pest', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1, service_address_line1: '100 Main St' }),
    stop('lawn', { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1, service_address_line1: '100 Main St', ...over }),
  ];

  test('two units of one building share a pin AND line 1 — the unit still separates them', () => {
    const { isCoVisitPair } = require('../services/route-reorder-window-fit');
    const same = premisePair();
    expect(isCoVisitPair(effectiveWindowRange, same[0], same[1])).toBe(true);
    // Unit in line 2 — premiseStampConflicts' own rule, the case a line-1
    // string match could not see.
    const units = premisePair({ service_address_line2: 'Apt 2' });
    units[0] = { ...units[0], service_address_line2: 'Apt 1' };
    expect(isCoVisitPair(effectiveWindowRange, units[0], units[1])).toBe(false);
    // Different zip likewise.
    const zips = premisePair({ service_address_zip: '34209' });
    zips[0] = { ...zips[0], service_address_zip: '34205' };
    expect(isCoVisitPair(effectiveWindowRange, zips[0], zips[1])).toBe(false);
  });

  test('a caller that pre-normalizes durations keeps its raw estimates — no phantom hour', () => {
    // arrival-route.js's evaluateArrivalPlacement rewrites every ungrouped
    // row's estimated_duration_minutes to workDuration(row) before
    // simulating. Reading THAT as a real estimate sums 60 + 60 = the phantom
    // hour; raw_estimate_minutes carries the truth (null ⇒ no estimate).
    const stops = premisePair().map((s) => ({ ...s, raw_estimate_minutes: s.estimated_duration_minutes, estimated_duration_minutes: 60 }));
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { dayEndMin: 845 });
    expect(sim).not.toBeNull();
    expect(sim.arrivals.map((a) => a.departureMin)).toEqual([840, 840]);
    // A row carrying a REAL estimate through the same rewrite still adds up.
    const real = stops.map((s, i) => (i === 1 ? { ...s, raw_estimate_minutes: 75 } : s));
    expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, real, {}).arrivals[1].departureMin).toBe(855);
  });

  test('a third member’s work survives a block that postponed the second', () => {
    // 1st: span 60 → departs 840. 2nd: 75 real minutes → +15, but a 845-865
    // block pushes the clock to 880. 3rd: +20 more real minutes → 95 total
    // work, so 20 minutes past 880 = 900. Measuring against the idle-carrying
    // clock instead of the work delta would have dropped all 20.
    const [a, b] = premisePair();
    const stops = [
      a,
      { ...b, id: 'lawn', raw_estimate_minutes: 75, estimated_duration_minutes: 75 },
      { ...b, id: 'extra', raw_estimate_minutes: 20, estimated_duration_minutes: 20 },
    ];
    const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, stops, { blockedIntervals: [{ startMin: 845, endMin: 865 }] });
    expect(sim).not.toBeNull();
    expect(sim.arrivals.map((s) => s.departureMin)).toEqual([840, 880, 900]);
  });
});

// ── Codex #4435 round 3 ──────────────────────────────────────────────────
test('unit: an UNSTAMPED row inherits the customer premise — it does not merge with a stamped sibling unit', () => {
  const { isCoVisitPair } = require('../services/route-reorder-window-fit');
  const slot = { customer_id: 'cust_b', window_start: '13:00', window_end: '14:00', estimated_duration_minutes: null, lat: 1, lng: 1 };
  // Both rows sit on the customer's own 100 Main St; one explicitly stamps a
  // DIFFERENT unit. Comparing bare stamps finds no conflict (one side has no
  // street line at all) — comparing effective premises does.
  const inherited = stop('inherited', slot);
  const stamped = stop('stamped', { ...slot, service_address_line1: '100 Main St', service_address_line2: 'Apt 2' });
  expect(isCoVisitPair(effectiveWindowRange, inherited, stamped)).toBe(false);
  // The same stamp naming the customer's OWN unit is one premise again.
  const sameUnit = stop('same', { ...slot, service_address_line1: '100 Main St' });
  expect(isCoVisitPair(effectiveWindowRange, inherited, sameUnit)).toBe(true);
  // And a premise that resolves to nothing at all (no stamp, no customer
  // address) is unknown, never known-equal.
  const blankA = { ...inherited, customer_address_line1: null };
  const blankB = { ...sameUnit, service_address_line1: null, customer_address_line1: null };
  expect(isCoVisitPair(effectiveWindowRange, blankA, blankB)).toBe(false);
});
