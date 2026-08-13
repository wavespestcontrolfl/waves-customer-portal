// ROUTE-TIERS nightly reorder pass: band day selection (tomorrow .. today+6),
// the 72h clock + reminder-sent day freezes (incl. fail-closed), the >25-stop
// Google-cap skip (logged, never truncated), same-model savings vs the
// min-savings floor, the window-chronology guard, commit-time revalidation
// (membership/windows/freeze under the transaction), and the planner-runs
// ledger row shape.
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
const logger = require('../services/logger');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { runRouteReorder, runRouteReorderIfEnabled, recordSkippedTick } = require('../services/route-reorder');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
const NOW = new Date('2026-08-13T08:10:00Z');
const BAND = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'];

function stop(id, over = {}) {
  return { id, technician_id: 't1', route_order: null, window_start: '09:00', time_window: null, service_type: 'pest', zone: null, lat: 1, lng: 1, ...over };
}

// A tech-day whose CURRENT order backtracks (B@lng3 first, then A@lng1, C@lng2
// → model 8000 m); sorting by lng (A,C,B → 6000 m) saves 2000 m ≥ the 805 m
// floor. optimizeRoute's default mock returns the lng-sorted order.
function backtrackDay(prefix = '', over = {}) {
  return [
    stop(`${prefix}A`, { lng: 1, route_order: 2, ...over }),
    stop(`${prefix}B`, { lng: 3, route_order: 1, ...over }),
    stop(`${prefix}C`, { lng: 2, route_order: 3, ...over }),
  ];
}

let stopsByDate;
let ledgerInserts;
let trxUpdates;
let trxRawCalls;
let liveRowsOverride; // null ⇒ derive live rows from stopsByDate (unchanged day)
let adRunRow; // auto_dispatch_runs .first() result
let dbCalls; // captured where/whereIn/orderBy calls per table

function tableChain(table) {
  const c = { _table: table };
  ['where', 'whereIn', 'orderBy', 'limit'].forEach((m) => {
    c[m] = (...args) => { dbCalls.push({ table, method: m, args }); return c; };
  });
  c.select = () => c;
  c.first = async () => (table === 'auto_dispatch_runs' ? adRunRow || null : null);
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
  trxRawCalls = [];
  liveRowsOverride = null;
  adRunRow = null;
  dbCalls = [];
  dayStopsQuery.mockImplementation(async (_db, { dateStr }) => stopsByDate[dateStr] || []);
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
  db.mockImplementation((table) => tableChain(table));
  db.transaction.mockImplementation(async (cb) => {
    const attempted = [];
    let membershipRead = false;
    const trx = () => {
      const filters = {};
      const c = {
        where: (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[String(a).replace('scheduled_services.', '')] = b; return c; },
        whereNotIn: () => c,
        forUpdate: () => c,
        leftJoin: () => c,
        select: async () => {
          membershipRead = true;
          if (liveRowsOverride) return liveRowsOverride;
          // Unchanged tech-day: mirror the loaded stops for this date+tech.
          return (stopsByDate[filters.scheduled_date] || [])
            .filter((s) => s.technician_id === filters.technician_id)
            .map((s) => ({ id: s.id, window_start: s.window_start, route_order: s.route_order, lat: s.lat, lng: s.lng }));
        },
        update: async (u) => { attempted.push({ id: filters.id, ...u }); return 1; },
      };
      return c;
    };
    trx.raw = async (...args) => {
      trxRawCalls.push({ args, beforeMembershipRead: !membershipRead });
    };
    // Commit semantics: only surface the writes if the callback didn't throw.
    const out = await cb(trx);
    trxUpdates.push(...attempted);
    return out;
  });
  // Default optimizer: order stops by lng ascending (the "good" route).
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: [...stops].sort((p, q) => p.lng - q.lng),
    totalDistanceMeters: 12345, // deliberately NOT what savings are computed from
    totalDurationSeconds: 600,
    unoptimizedDistanceMeters: 99999,
    source: 'google_routes_api',
  }));
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
  stopsByDate['2026-08-16'] = backtrackDay();
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  const ledger = JSON.parse(ledgerInserts[0].result);
  const skipReasons = Object.fromEntries(ledger.skips.map((s) => [s.date, s.reason]));
  expect(skipReasons['2026-08-14']).toBe('WITHIN_72H');
  expect(skipReasons['2026-08-15']).toBe('WITHIN_72H');
  expect(ledger.reorders[0]).toMatchObject({ date: '2026-08-16', technician_id: 't1' });
});

test('a reminder-sent visit freezes its whole day', async () => {
  stopsByDate['2026-08-16'] = backtrackDay();
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set(['C']) });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-16', reason: 'REMINDER_SENT_FROZEN' }));
});

test('FAIL CLOSED + FAIL LOUD: unreadable reminder status freezes the day AND degrades run status', async () => {
  stopsByDate['2026-08-17'] = backtrackDay();
  routeTiers.loadReminderFreeze.mockResolvedValue({ failed: true, frozen: new Set() });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(res.failed).toBe(1);
  expect(res.status).toBe('completed_with_errors'); // never a green run on a guard outage
  expect(ledgerInserts[0].failed_count).toBe(1);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.failures).toContainEqual(expect.objectContaining({ date: '2026-08-17', reason: 'REMINDER_STATUS_UNKNOWN' }));
});

test('>25 geocoded stops for one tech-day is SKIPPED and LOGGED, never truncated', async () => {
  stopsByDate['2026-08-18'] = Array.from({ length: 26 }, (_, i) => stop(`s${i}`, { lng: i + 1 }));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('25-waypoint cap'));
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'OVER_WAYPOINT_CAP', geocoded: 26 }));
});

test('savings are computed under ONE model — an order no shorter than the current one applies nothing', async () => {
  // Two stops at the same point: any order has equal model distance, so even
  // though the optimizer "reports" huge unoptimized-vs-optimized numbers,
  // model savings are 0 and nothing is written.
  stopsByDate['2026-08-18'] = [stop('g'), stop('h')];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ reason: 'BELOW_MIN_SAVINGS', saved_meters: 0 }));
});

test('savings above the floor rewrite route_order transactionally in optimized order', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  // Phantom-proofing: the write transaction must run SERIALIZABLE so a stop
  // inserted/reassigned into the tech-day mid-run aborts it (40001).
  expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
  expect(trxUpdates).toEqual([
    { id: 'A', route_order: 1 },
    { id: 'C', route_order: 2 },
    { id: 'B', route_order: 3 },
  ]);
  // Baseline order fed to the optimizer is the CURRENT running order
  // (route_order asc): B(1), A(2), C(3).
  const fed = RouteOptimizer.optimizeRoute.mock.calls[0][0].map((s) => s.id);
  expect(fed).toEqual(['B', 'A', 'C']);
});

test('an order violating window chronology is SKIPPED, never written', async () => {
  // The lng-sorted route puts C (13:00 window) before B (09:00 window) —
  // distance says yes, the promised windows say no.
  stopsByDate['2026-08-18'] = [
    stop('A', { lng: 1, route_order: 2, window_start: '09:00' }),
    stop('B', { lng: 3, route_order: 1, window_start: '09:00' }),
    stop('C', { lng: 2, route_order: 3, window_start: '13:00' }),
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'WINDOW_ORDER_CONFLICT' }));
});

test('window-respecting order (ties + null windows) still applies', async () => {
  stopsByDate['2026-08-18'] = backtrackDay('', {}).map((s, i) => ({ ...s, window_start: i === 2 ? null : '09:00' }));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
});

test('commit-time revalidation: a changed tech-day rolls back untouched (STALE_TECH_DAY)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // Staff moved stop B off the day while the optimizer ran.
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 2, lat: 1, lng: 1 },
    { id: 'C', window_start: '09:00', route_order: 3, lat: 1, lng: 2 },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(res.failed).toBe(0); // a superseded day is a skip, not a failure
  expect(trxUpdates).toEqual([]); // nothing committed
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('commit-time revalidation: a changed window_start rolls back untouched', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 2, lat: 1, lng: 1 },
    { id: 'B', window_start: '14:00', route_order: 1, lat: 1, lng: 3 }, // staff changed the window mid-run
    { id: 'C', window_start: '09:00', route_order: 3, lat: 1, lng: 2 },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('the shared slot-reserve writer fence is taken BEFORE the membership read', async () => {
  // Booking/reschedule writers (rebooker kept-tech lock, slot-reservation
  // reserves, createSelfBooking) all serialize on
  // pg_advisory_xact_lock(hashtext('slot-reserve'), hashtext('tech:date')).
  // The reorder transaction must take the SAME lock, and take it before it
  // reads membership, or the fence proves nothing.
  stopsByDate['2026-08-18'] = backtrackDay();
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  expect(trxRawCalls).toHaveLength(1);
  const fence = trxRawCalls[0];
  expect(fence.args[0]).toContain('pg_advisory_xact_lock');
  expect(fence.args[1]).toEqual(['slot-reserve', 't1:2026-08-18']);
  expect(fence.beforeMembershipRead).toBe(true);
});

test('commit-time reminder-guard OUTAGE fails LOUD: rollback + failure + degraded status', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // Day-level pre-check clean; the in-transaction commit re-check errors out.
  routeTiers.loadReminderFreeze
    .mockResolvedValueOnce({ failed: false, frozen: new Set() })
    .mockResolvedValueOnce({ failed: true, frozen: new Set() });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(res.failed).toBe(1); // a guard outage is a FAILURE, not a quiet skip
  expect(res.status).toBe('completed_with_errors');
  expect(trxUpdates).toEqual([]); // rolled back
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.failures).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'REMINDER_STATUS_UNKNOWN' }));
});

test('ledger pairs with that night\'s CRON auto-dispatch run, never a later manual run', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // The .first() row is whatever the filtered query returns; the assertion
  // that matters is the FILTERS: triggered_by='cron' with NO status filter —
  // a manual/dry_run started after 4:10 can never be selected, and a FAILED
  // cron run stays visible in the ledger instead of vanishing (run:null) or
  // being shadowed by an earlier successful run.
  adRunRow = {
    id: 'AD-CRON-1', status: 'completed', mode: 'apply', total_evaluated: 10, total_skipped: 2,
    total_recommended: 1, total_changed: 3, total_failed: 0, created_at: '2026-08-13T08:12:00Z',
  };
  await runRouteReorder({ now: NOW });
  const runFilters = dbCalls.filter((c) => c.table === 'auto_dispatch_runs');
  expect(runFilters).toContainEqual(expect.objectContaining({ method: 'where', args: ['triggered_by', 'cron'] }));
  expect(runFilters).not.toContainEqual(expect.objectContaining({ method: 'whereIn', args: ['status', expect.anything()] }));
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.auto_dispatch.run).toMatchObject({ id: 'AD-CRON-1', mode: 'apply', changed: 3 });
});

test('a FAILED cron run is paired and its failure preserved in the ledger', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  adRunRow = {
    id: 'AD-CRON-FAIL', status: 'failed', mode: 'apply', total_evaluated: 4, total_skipped: 0,
    total_recommended: 1, total_changed: 0, total_failed: 4, created_at: '2026-08-13T08:12:00Z',
  };
  await runRouteReorder({ now: NOW });
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.auto_dispatch.run).toMatchObject({ id: 'AD-CRON-FAIL', status: 'failed', failed: 4 });
});

test('a cron run from a PREVIOUS day is not paired (date guard)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  adRunRow = {
    id: 'AD-OLD', status: 'completed', mode: 'apply', total_changed: 9, created_at: '2026-08-12T08:12:00Z',
  };
  await runRouteReorder({ now: NOW });
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.auto_dispatch.run).toBeNull();
});

test('recordSkippedTick ledgers a lease-held tick as skipped, never successful', async () => {
  const id = await recordSkippedTick('lease_held', NOW);
  expect(id).toBe('ledger-1');
  expect(ledgerInserts).toHaveLength(1);
  expect(ledgerInserts[0]).toMatchObject({
    run_type: 'route_tiers_nightly',
    status: 'skipped',
    start_date: '2026-08-14',
    end_date: '2026-08-19',
    applied_count: 0,
  });
  expect(JSON.parse(ledgerInserts[0].result)).toMatchObject({ skip_reason: 'lease_held' });
});

test('a tech-day containing a coordless stop is skipped whole (no guessed placement)', async () => {
  stopsByDate['2026-08-18'] = [...backtrackDay(), stop('D', { lat: null, lng: null, route_order: 4 })];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'COORDLESS_STOPS', geocoded: 3 }));
});

test('commit-time revalidation: changed coordinates mid-run roll back untouched', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 2, lat: 1, lng: 1 },
    { id: 'B', window_start: '09:00', route_order: 1, lat: 2, lng: 5 }, // address corrected mid-run
    { id: 'C', window_start: '09:00', route_order: 3, lat: 1, lng: 2 },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('a serialization conflict (40001 — phantom membership change) is a skip, not a failure', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  db.transaction.mockImplementationOnce(async () => {
    throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
  });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(res.failed).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('commit-time revalidation: a MANUAL reorder mid-run wins — autonomous write rolls back', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // Dispatcher hand-reordered while the optimizer ran: same stops, same
  // windows, different route_order. The operator's newer order must survive.
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 1, lat: 1, lng: 1 },
    { id: 'B', window_start: '09:00', route_order: 3, lat: 1, lng: 3 },
    { id: 'C', window_start: '09:00', route_order: 2, lat: 1, lng: 2 },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('commit-time revalidation: a reminder sent DURING the run rolls back untouched', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // First read (day pre-check) clean; second read (inside the trx) frozen.
  routeTiers.loadReminderFreeze
    .mockResolvedValueOnce({ failed: false, frozen: new Set() })
    .mockResolvedValueOnce({ failed: false, frozen: new Set(['A']) });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('per-tech grouping: two techs on one day are reordered independently', async () => {
  stopsByDate['2026-08-19'] = [...backtrackDay('x'), ...backtrackDay('y', { technician_id: 't2' })];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(2);
  expect(RouteOptimizer.optimizeRoute).toHaveBeenCalledTimes(2);
});

test('ledger row shape: one route_optimization_planner_runs row per run', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
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
    stops: 3,
    before_distance_meters: 10000, // model distance of the current order B,A,C
    after_distance_meters: 8000,   // model distance of the optimized order A,C,B
    saved_meters: 2000,
    source: 'google_routes_api',
  });
  expect(result).toHaveProperty('auto_dispatch');
});

test('a failed ledger insert degrades the run status (audit record is part of the contract)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  db.mockImplementation((table) => {
    const c = tableChain(table);
    if (table === 'route_optimization_planner_runs') {
      c.insert = () => { throw new Error('insert failed'); };
    }
    return c;
  });
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1); // the reorder itself committed
  expect(res.ledgerId).toBeNull();
  expect(res.status).toBe('completed_with_errors'); // but the run is not green
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
