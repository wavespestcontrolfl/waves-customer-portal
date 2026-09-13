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
// Lazily required by runScheduleQualityAlertsOnly — no existing test in this
// file sets GATE_SCHEDULE_QUALITY_ALERTS, so the real module is never
// otherwise exercised here.
jest.mock('../services/scheduling/quality-alerts', () => ({
  refreshScheduleQualityAlerts: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
const {
  runRouteReorder, runRouteRepairAfterChange, runRouteReorderIfEnabled, recordSkippedTick,
  runScheduleQualityAlertsOnly,
} = require('../services/route-reorder');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
const NOW = new Date('2026-08-13T08:10:00Z');
const BAND = ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'];

function stop(id, over = {}) {
  // service_address_line1 present-but-null, as the day-load select returns
  // it for a row that inherits the customer's address.
  return { id, technician_id: 't1', route_order: null, window_start: '09:00', time_window: null, service_type: 'pest', zone: null, lat: 1, lng: 1, service_address_line1: null, visit_id: null,
    // A real row: unstamped, so its premise is the customer's own
    // primary address (the columns the day load aliases).
    customer_address_line1: '100 Main St', customer_address_line2: null,
    customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34205', ...over };
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
let loadWhereRaws; // whereRaw sql chained onto the day-load builder
let commitWhereRaws; // whereRaw sql on the commit-time re-read
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
  loadWhereRaws = [];
  commitWhereRaws = [];
  // Real dayStopsQuery returns a knex builder (chainable thenable) — the
  // caller chains .whereRaw(live-hold predicate) onto it, so the mock must
  // expose that surface too (mock ≠ prod export rule).
  dayStopsQuery.mockImplementation((_db, { dateStr }) => {
    const builder = {
      whereRaw: (sql) => { loadWhereRaws.push({ dateStr, sql }); return builder; },
      then: (resolve, reject) => Promise.resolve(stopsByDate[dateStr] || []).then(resolve, reject),
    };
    return builder;
  });
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
        whereRaw: (sql) => { commitWhereRaws.push(sql); return c; },
        forUpdate: () => c,
        leftJoin: () => c,
        select: async () => {
          membershipRead = true;
          if (liveRowsOverride) return liveRowsOverride;
          // Unchanged tech-day: mirror the loaded stops for this date+tech.
          return (stopsByDate[filters.scheduled_date] || [])
            .filter((s) => s.technician_id === filters.technician_id)
            .map((s) => ({ id: s.id, window_start: s.window_start, window_end: s.window_end, visit_id: s.visit_id, time_window: s.time_window, estimated_duration_minutes: s.estimated_duration_minutes, auto_dispatch_locked: s.auto_dispatch_locked, auto_dispatch_excluded: s.auto_dispatch_excluded, route_order: s.route_order, lat: s.lat, lng: s.lng,
              // The commit fence hashes the EFFECTIVE premise, so the live
              // read projects the same columns the day load selected.
              service_address_line1: s.service_address_line1, service_address_line2: s.service_address_line2,
              service_address_city: s.service_address_city, service_address_zip: s.service_address_zip,
              customer_id: s.customer_id,
              customer_address_line1: s.customer_address_line1, customer_address_line2: s.customer_address_line2,
              customer_city: s.customer_city, customer_state: s.customer_state, customer_zip: s.customer_zip }));
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

describe('near-term null-position repair', () => {
  const repairDay = () => [
    stop('one', { route_order: 1, window_start: '13:00', estimated_duration_minutes: 60 }),
    stop('later', { route_order: 2, window_start: '15:00', window_end: '17:00', estimated_duration_minutes: 60 }),
    stop('new', { route_order: null, window_start: '14:00', estimated_duration_minutes: 60 }),
  ];
  beforeEach(() => {
    process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    stopsByDate[BAND[0]] = repairDay();
  });
  afterEach(() => {
    delete process.env.GATE_ROUTE_REORDER_REPAIR;
    delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    delete process.env.GATE_ROUTE_REORDER;
  });

  test('restores arrival feasibility inside 72 hours with no mileage gain, using stored work duration', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set(['later']) });
    const result = await runRouteReorder({ now: NOW });
    expect(result.applied).toBe(1);
    expect(trxUpdates).toEqual([{ id: 'one', route_order: 1 }, { id: 'new', route_order: 2 }, { id: 'later', route_order: 3 }]);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(JSON.parse(ledgerInserts[0].result).reorders[0]).toMatchObject({ source: 'chronological_repair',
      saved_meters: 0, distance_change_meters: 0, before_window_feasible: false, after_window_feasible: true });
  });

  test.each([false, true])('repairs every stop beyond the Google cap without calling Google (event mode: %s)', async eventMode => {
    process.env.GATE_ROUTE_REORDER = 'true';
    const early = Array.from({ length: 23 }, (_, index) => stop(`early-${index}`, {
      route_order: index + 1, window_start: '08:00', estimated_duration_minutes: 5,
    }));
    stopsByDate[BAND[0]] = [...early, ...repairDay().map(row => ({
      ...row, route_order: row.route_order == null ? null : row.route_order + early.length,
    }))];
    const result = eventMode ? await runRouteRepairAfterChange({ dates: [BAND[0]], now: NOW }) : await runRouteReorder({ now: NOW });
    expect(result.applied).toBe(1);
    expect(trxUpdates.map(row => row.id)).toEqual([...early.map(row => row.id), 'one', 'new', 'later']);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  });

  test.each(['GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'])('%s off retains the near-term freeze', async gate => {
    delete process.env[gate];
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });

  test.each([{ auto_dispatch_locked: true }, { auto_dispatch_excluded: true }, { lat: null }, { visit_id: 'group' },
    { estimated_duration_minutes: null }, { estimated_duration_minutes: -10 },
    { estimated_duration_minutes: Infinity }])('refuses protected or unverifiable work: %j', async change => {
    Object.assign(stopsByDate[BAND[0]][0], change);
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });

  test('does not replace an intentionally nonchronological existing order', async () => {
    stopsByDate[BAND[0]][0].route_order = 2;
    stopsByDate[BAND[0]][1].route_order = 1;
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
  });

  test('does not normalize a route whose existing order still fits every promise', async () => {
    stopsByDate[BAND[0]][1].window_end = '16:00';
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
  });

  test('rechecks duration and membership under the existing write fence', async () => {
    liveRowsOverride = repairDay();
    liveRowsOverride[1].window_end = '18:00';
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    expect(trxRawCalls[0].beforeMembershipRead).toBe(true);
  });

  test('a duration cleared during the run cannot regain the legacy fallback at commit', async () => {
    liveRowsOverride = repairDay();
    liveRowsOverride[0].estimated_duration_minutes = null;
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });

  test('an unreadable reminder state still fails closed', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: true, frozen: new Set() });
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });

  test('a repair gate revoked at commit prevents every write', async () => {
    routeTiers.loadReminderFreeze.mockImplementation(async (conn) => {
      if (conn !== db) delete process.env.GATE_ROUTE_REORDER_REPAIR;
      return { failed: false, frozen: new Set() };
    });
    expect((await runRouteReorder({ now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });

  test('event mode only repairs the affected future dates and never invokes the distance optimizer', async () => {
    process.env.GATE_ROUTE_REORDER = 'true';
    stopsByDate['2026-08-24'] = repairDay();
    stopsByDate['2026-08-25'] = backtrackDay();
    const result = await runRouteRepairAfterChange({ dates: ['2026-08-13', '2026-08-24', '2026-08-24', '2026-08-25', '2026-09-13', 'bad'], now: NOW });
    expect(result.applied).toBe(1);
    expect(dayStopsQuery.mock.calls.map(([, args]) => args.dateStr)).toEqual(['2026-08-24', '2026-08-25']);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(ledgerInserts[0].run_type).toBe('route_repair_change');
    expect(JSON.parse(ledgerInserts[0].result)).toMatchObject({ auto_dispatch: null,
      skips: [expect.objectContaining({ date: '2026-08-25', reason: 'NO_SAFE_INSERTION' })] });
    expect(dbCalls.some(call => call.table === 'auto_dispatch_runs')).toBe(false);
  });

  test.each(['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'])('event mode requires %s at entry and commit', async gate => {
    process.env.GATE_ROUTE_REORDER = 'true';
    delete process.env[gate];
    expect(await runRouteRepairAfterChange({ dates: [BAND[0]], now: NOW })).toEqual({ status: 'gate_off' });
    expect(dayStopsQuery).not.toHaveBeenCalled();
    process.env[gate] = 'true';
    routeTiers.loadReminderFreeze.mockImplementation(async conn => {
      if (conn !== db) delete process.env[gate];
      return { failed: false, frozen: new Set() };
    });
    expect((await runRouteRepairAfterChange({ dates: [BAND[0]], now: NOW })).applied).toBe(0);
    expect(trxUpdates).toEqual([]);
  });
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

test('quality measurements capture frozen routes in the existing ledger without changing them', async () => {
  process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
  try {
    stopsByDate[BAND[0]] = [stop('first', { window_start: '08:00' }), stop('next', { window_start: '11:00' })];
    const result = await runRouteReorder({ now: NOW });
    expect(result.applied).toBe(0);
    expect(trxUpdates).toEqual([]);
    const measurement = JSON.parse(ledgerInserts[0].result).route_quality[0];
    expect(measurement).toMatchObject({ date: BAND[0], technician_id: 't1', serviceMinutes: 120,
      grossGapMinutes: 120, remainingServiceBudgetMinutes: null });
    expect(JSON.stringify(measurement)).not.toMatch(/"lat"|"lng"|customer_name|address/);
  } finally {
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  }
});

test('revoking measurement collection before the ledger write omits the collected snapshots', async () => {
  process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
  try {
    stopsByDate['2026-08-18'] = backtrackDay();
    routeTiers.loadReminderFreeze.mockImplementation(async () => {
      delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
      return { failed: false, frozen: new Set() };
    });
    expect((await runRouteReorder({ now: NOW })).applied).toBe(1);
    expect(JSON.parse(ledgerInserts[0].result)).not.toHaveProperty('route_quality');
    expect(JSON.parse(ledgerInserts[0].constraints)).not.toHaveProperty('day_quality_version');
  } finally {
    delete process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS;
  }
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

test.each([false, true])('>25 stops without a safe repair are never sent to Google (repair gate: %s)', async repairGate => {
  if (repairGate) {
    process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  }
  stopsByDate['2026-08-18'] = Array.from({ length: 26 }, (_, i) => stop(`s${i}`, { lng: i + 1 }));
  try {
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(0);
    expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('25-waypoint cap'));
    const ledger = JSON.parse(ledgerInserts[0].result);
    expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'OVER_WAYPOINT_CAP', geocoded: 26 }));
  } finally {
    delete process.env.GATE_ROUTE_REORDER_REPAIR;
    delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  }
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

test('legacy time_window bands participate in the chronology guard (afternoon never before morning)', async () => {
  // No window_start anywhere — only legacy bands. The lng-sorted route puts
  // A (afternoon) before M (morning); the band promise says no.
  stopsByDate['2026-08-18'] = [
    stop('M', { lng: 3, route_order: 1, window_start: null, time_window: 'morning' }),
    stop('A', { lng: 1, route_order: 2, window_start: null, time_window: 'afternoon' }),
    stop('N', { lng: 2, route_order: 3, window_start: null, time_window: null }),
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'WINDOW_ORDER_CONFLICT' }));
});

test('optimizer result that is not an exact permutation FAILS the tech-day loud, never writes', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  // External API returned a truncated waypoint list — one stop missing.
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: [...stops].sort((p, q) => p.lng - q.lng).slice(0, 2),
    totalDistanceMeters: 1,
    totalDurationSeconds: 1,
    source: 'google_routes_api',
  }));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(res.failed).toBe(1);
  expect(res.status).toBe('completed_with_errors');
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.failures).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'OPTIMIZER_RESULT_MISMATCH' }));
});

test('optimizer result with a duplicated stop FAILS the tech-day (same guard)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => {
    const sorted = [...stops].sort((p, q) => p.lng - q.lng);
    return { orderedStops: [sorted[0], sorted[0], sorted[1]], totalDistanceMeters: 1, totalDurationSeconds: 1, source: 'google_routes_api' };
  });
  const res = await runRouteReorder({ now: NOW });
  expect(res.failed).toBe(1);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('savings baseline mirrors the dispatch display order: windowless last, created_at ties — NOT time_window', () => {
  const { currentOrder } = require('../services/route-reorder')._internals;
  const day = [
    stop('w9', { route_order: null, window_start: '09:00', created_at: '2026-08-01T00:00:00Z' }),
    stop('none', { route_order: null, window_start: null, time_window: 'morning', created_at: '2026-08-01T00:00:00Z' }),
    stop('tieB', { route_order: null, window_start: '13:00', created_at: '2026-08-02T00:00:00Z' }),
    stop('tieA', { route_order: null, window_start: '13:00', created_at: '2026-08-01T00:00:00Z' }),
    stop('r1', { route_order: 1, window_start: null, created_at: '2026-08-03T00:00:00Z' }),
  ];
  // COALESCE(route_order,999), COALESCE(window_start,'23:59'), created_at —
  // 'none' has time_window 'morning' but the board shows it LAST, so the
  // baseline must too.
  expect(currentOrder(day).map((s) => s.id)).toEqual(['r1', 'w9', 'tieA', 'tieB', 'none']);
});

test('feasibility guard: untimed stops wedged between fixed windows that provably cannot fit SKIP the day', async () => {
  // Baseline (route_order): B(10:00) first, then A(09:00), then 3 untimed —
  // long route. Optimizer's lng-sort proposes A, U1, U2, U3, B — chronology
  // passes (09:00 before 10:00) and saves distance, but three 60-minute
  // untimed stops between the windows push B's start to 13:00, past its
  // 10:00–12:00 promise. The day must be skipped, never written.
  stopsByDate['2026-08-18'] = [
    stop('B', { lng: 5, route_order: 1, window_start: '10:00' }),
    stop('A', { lng: 1, route_order: 2, window_start: '09:00' }),
    stop('U1', { lng: 2, route_order: 3, window_start: null }),
    stop('U2', { lng: 3, route_order: 4, window_start: null }),
    stop('U3', { lng: 4, route_order: 5, window_start: null }),
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(db.transaction).not.toHaveBeenCalled();
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'WINDOW_FIT_CONFLICT' }));
});

test('feasibility guard semantics: one untimed stop between windows FITS (the promise is time+2h)', () => {
  const { violatesWindowFeasibility } = require('../services/route-reorder')._internals;
  const RO = require('../services/route-optimizer');
  const a = stop('a', { window_start: '09:00' });
  const u = stop('u', { window_start: null });
  const b = stop('b', { window_start: '10:00' });
  // 09:00 (60m) → untimed (60m) → b starts 11:00 ≤ 12:00 arrival deadline: feasible.
  expect(violatesWindowFeasibility(RO, [a, u, b], [a, u, b])).toBe(false);
  // Custom durations count: a 150-minute untimed job blows the default window.
  const uLong = stop('u', { window_start: null, estimated_duration_minutes: 150 });
  expect(violatesWindowFeasibility(RO, [a, uLong, b], [a, uLong, b])).toBe(true);
});

test('feasibility uses the optimizer\'s ACTUAL leg durations when aligned (fallback model only otherwise)', () => {
  const { violatesWindowFeasibility } = require('../services/route-reorder')._internals;
  const RO = require('../services/route-optimizer');
  const a = stop('a', { window_start: '09:00', lat: 1, lng: 1 });
  const b = stop('b', { window_start: '10:00', lat: 1, lng: 2 });
  // Fallback model (test mock: 0 minutes/leg): 09:00+60 → b starts 10:00 — fits.
  expect(violatesWindowFeasibility(RO, [a, b], [a, b])).toBe(false);
  // Real Google legs say the drive to b takes 130 minutes: 10:00 + 2:10 =
  // 12:10 > 12:00 arrival deadline — the same order is provably undriveable.
  const legs = [
    { from: 'HQ', to: 'a', distanceMeters: 1, durationMinutes: 0 },
    { from: 'a', to: 'b', distanceMeters: 1, durationMinutes: 130 },
    { from: 'b', to: 'HQ', distanceMeters: 1, durationMinutes: 0 },
  ];
  expect(violatesWindowFeasibility(RO, [a, b], [a, b], legs)).toBe(true);
  // Misaligned/partial legs are never trusted — falls back to the model.
  expect(violatesWindowFeasibility(RO, [a, b], [a, b], [legs[0]])).toBe(false);
});

test('feasibility guard: a same-customer same-slot pair merges into one stop (phantom-hour fix, Sat 2026-09-12); a different customer does not', () => {
  // Mirrors advanceSim's co-visit branch (route-reorder-window-fit.js) but
  // exercises violatesWindowFeasibility's OWN inline simulation loop
  // directly — it does not call simulateArrivalRoute, so it needed its own
  // co-visit check. a+b share the 09:00-11:00 promise (arrival deadline
  // 11:00) and carry no real estimate, so each falls back to its 120-minute
  // window span: summed, the pair's four phantom hours blow c's own 10:30
  // deadline (12:30); merged (same customer_id) it is the one promised
  // block and fits. Unmerged (different customer_id, i.e. two genuinely different
  // visits) it does not — and a chain that really does carry additive
  // estimates is charged both (see route-reorder-window-fit's (i)).
  const { violatesWindowFeasibility } = require('../services/route-reorder')._internals;
  const RO = require('../services/route-optimizer');
  const a = stop('a', { customer_id: 'cust_b', window_start: '09:00', window_end: '11:00', estimated_duration_minutes: null, lat: 1, lng: 1 });
  const b = stop('b', { customer_id: 'cust_b', window_start: '09:00', window_end: '11:00', estimated_duration_minutes: null, lat: 1, lng: 1 });
  const c = stop('c', { window_start: '10:30' });
  expect(violatesWindowFeasibility(RO, [a, b, c], [a, b, c])).toBe(false);
  const bOtherCustomer = { ...b, customer_id: 'someone_else' };
  expect(violatesWindowFeasibility(RO, [a, bOtherCustomer, c], [a, bOtherCustomer, c])).toBe(true);
});

test('the day load selects customer_id — required for the co-visit collapse (phantom-hour fix)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  await runRouteReorder({ now: NOW });
  const [, args] = dayStopsQuery.mock.calls.find(([, a]) => a.dateStr === '2026-08-18');
  expect(args.select).toContain('scheduled_services.customer_id');
});

test('effectiveWindowRange: arrival deadline is ALWAYS start+120 (stored window_end = service end, ignored), real band ends', () => {
  const { effectiveWindowRange } = require('../services/route-reorder')._internals;
  // A 3-hour 09:00 job has a noon window_end, but the promised ARRIVAL
  // deadline is 11:00 — same rule as the SMS formatter's arrivalWindowRange.
  expect(effectiveWindowRange({ window_start: '09:00:00', window_end: '12:00:00' })).toEqual({ startMin: 540, endMin: 660 });
  expect(effectiveWindowRange({ window_start: '09:00' })).toEqual({ startMin: 540, endMin: 660 });
  expect(effectiveWindowRange({ window_start: null, time_window: 'morning' })).toEqual({ startMin: 480, endMin: 720 });
  expect(effectiveWindowRange({ window_start: null, time_window: 'afternoon' })).toEqual({ startMin: 720, endMin: 1020 });
  expect(effectiveWindowRange({ window_start: null, time_window: null })).toBeNull();
});

test('a tech-day containing an auto_dispatch_locked or _excluded stop is skipped whole', async () => {
  stopsByDate['2026-08-18'] = backtrackDay().map((s, i) => (i === 1 ? { ...s, auto_dispatch_locked: true } : s));
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(RouteOptimizer.optimizeRoute).not.toHaveBeenCalled();
  let ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'LOCKED_STOP' }));

  jest.clearAllMocks();
  ledgerInserts.length = 0;
  db.mockImplementation((table) => tableChain(table));
  stopsByDate['2026-08-18'] = backtrackDay().map((s, i) => (i === 2 ? { ...s, auto_dispatch_excluded: true } : s));
  const res2 = await runRouteReorder({ now: NOW });
  expect(res2.applied).toBe(0);
  ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'LOCKED_STOP' }));
});

test('effectiveWindowStart: window_start wins, legacy bands map, free text is unconstrained', () => {
  const { effectiveWindowStart } = require('../services/route-reorder')._internals;
  expect(effectiveWindowStart({ window_start: '09:00:00', time_window: 'afternoon' })).toBe('09:00');
  expect(effectiveWindowStart({ window_start: null, time_window: 'morning' })).toBe('08:00');
  expect(effectiveWindowStart({ window_start: null, time_window: 'Afternoon' })).toBe('12:00');
  expect(effectiveWindowStart({ window_start: null, time_window: '9:30' })).toBe('09:30');
  expect(effectiveWindowStart({ window_start: null, time_window: 'any' })).toBeNull();
  expect(effectiveWindowStart({ window_start: null, time_window: null })).toBeNull();
});

test('expired estimate holds are excluded: live-hold predicate on the day load AND the commit re-read', async () => {
  stopsByDate['2026-08-18'] = backtrackDay();
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(1);
  // Every day-load carries the occupancy live-hold predicate…
  expect(loadWhereRaws.length).toBe(BAND.length);
  for (const { sql } of loadWhereRaws) expect(sql).toContain('reservation_expires_at');
  // …and the commit-time membership re-read uses the SAME predicate, so the
  // two reads agree on membership (an expired-at-load hold must not resurface
  // as a phantom "joined the tech-day" stale abort).
  expect(commitWhereRaws.some((sql) => String(sql).includes('reservation_expires_at'))).toBe(true);
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

// With GATE_ROUTE_REORDER off, runRouteReorder (and the nightly alert
// reconciliation folded into it) never runs — so with the measurement +
// alert gates ON, existing route-quality defects never got an initial card
// and no card ever expired. runScheduleQualityAlertsOnly is the standalone
// nightly trigger for exactly that case (codex #4295 r2 P2).
describe('runScheduleQualityAlertsOnly (reorder off, quality gates own the nightly reconciliation)', () => {
  const GATES = ['GATE_SCHEDULE_QUALITY_MEASUREMENTS', 'GATE_SCHEDULE_QUALITY_ALERTS'];
  let saved;
  beforeEach(() => {
    jest.clearAllMocks();
    saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
    for (const g of GATES) delete process.env[g];
  });
  afterEach(() => {
    for (const g of GATES) {
      if (saved[g] === undefined) delete process.env[g];
      else process.env[g] = saved[g];
    }
  });

  test('either gate off ⇒ gate_off, no reconciliation call', async () => {
    const res = await runScheduleQualityAlertsOnly(NOW);
    expect(res).toEqual({ status: 'gate_off' });
    process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
    const res2 = await runScheduleQualityAlertsOnly(NOW);
    expect(res2).toEqual({ status: 'gate_off' });
    expect(refreshScheduleQualityAlerts).not.toHaveBeenCalled();
  });

  test('both gates on ⇒ reconciles the same six-date band the full nightly pass would use', async () => {
    process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    refreshScheduleQualityAlerts.mockResolvedValue({ status: 'reconciled', created: 1, resolved: 2 });

    const res = await runScheduleQualityAlertsOnly(NOW, db);

    expect(res).toEqual({ status: 'reconciled', created: 1, resolved: 2 });
    expect(refreshScheduleQualityAlerts).toHaveBeenCalledTimes(1);
    expect(refreshScheduleQualityAlerts).toHaveBeenCalledWith({ dates: BAND, now: NOW }, db);
    // No repair, no distance optimization, no planner-runs ledger row — this
    // path skips everything runRouteReorder's writer side owns.
    expect(dayStopsQuery).not.toHaveBeenCalled();
    expect(ledgerInserts).toHaveLength(0);
  });
});

// ── Round-0 fallback audit P1 ────────────────────────────────────────────
// chooseWindowSafeOrder relaxes a window whose promised deadline has already
// passed relative to `startMin` (the admin "today, mid-route" clock), so an
// overdue stop no longer dictates order. Every figure it returns has to be
// measured under that SAME relaxed view: re-simulating the accepted order
// against the true, now-unreachable deadline returns null, and the multi-tech
// /optimize response sums `afterSeconds || 0` — charging that whole truck
// zero drive time.
test('chooseWindowSafeOrder: a legal order whose promise already elapsed still reports afterSeconds', () => {
  const { chooseWindowSafeOrder } = require('../services/route-reorder');
  const stops = [
    // 09:00-10:00 promise, deadline 10:00 — long past a 15:30 startMin.
    { id: 'E1', technician_id: 't1', route_order: 1, window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, lat: 1, lng: 3 },
    { id: 'E2', technician_id: 't1', route_order: 2, window_start: null, window_end: null, estimated_duration_minutes: 60, lat: 1, lng: 1 },
  ];
  const out = chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api', startMin: 15 * 60 + 30,
  });
  expect(out.orderedStops.map((s) => s.id)).toEqual(['E1', 'E2']);
  expect(out.source).toBe('google_routes_api');
  // 0 (this harness's legs are 0-minute), never null — null is the bug.
  expect(out.afterSeconds).toBe(0);
});

// ── Codex #4435 round 2 ──────────────────────────────────────────────────
// The commit-time fence hashed workDuration, which is max(window span, real
// estimate) — so a pair of 60-minute-span rows could go from 20+20 to 20+50
// real minutes with every workDuration still 60 and the fence none the wiser,
// committing an order certified against a 60-minute stop that is now 70. The
// signature carries the RAW estimate (and the merge's own customer/premise
// inputs) for exactly that.
test('commit-time revalidation: a raw estimate change that leaves workDuration alone still rolls back', async () => {
  stopsByDate['2026-08-18'] = backtrackDay('', { window_end: '10:00', estimated_duration_minutes: 20 });
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 20, route_order: 2, lat: 1, lng: 1 },
    // 20 → 50: still under the 60-minute span, so workDuration is unchanged.
    { id: 'B', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 50, route_order: 1, lat: 1, lng: 3 },
    { id: 'C', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 20, route_order: 3, lat: 1, lng: 2 },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

test('commit-time revalidation: a premise re-stamp mid-run rolls back (it is a merge input)', async () => {
  stopsByDate['2026-08-18'] = backtrackDay('', { service_address_line1: '100 Main St' });
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 2, lat: 1, lng: 1, service_address_line1: '100 Main St' },
    { id: 'B', window_start: '09:00', route_order: 1, lat: 1, lng: 3, service_address_line1: '100 Main St', service_address_line2: 'Apt 2' },
    { id: 'C', window_start: '09:00', route_order: 3, lat: 1, lng: 2, service_address_line1: '100 Main St' },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});

// ── Codex #4435 round 4 ──────────────────────────────────────────────────
// isCoVisitPair resolves an UNSTAMPED row's premise from the customer's
// primary address, so that address is a merge input: edited mid-run it
// changes the workload the order was certified against, while every stamped
// column and coordinate stays exactly where it was.
test('commit-time revalidation: a CUSTOMER address change mid-run rolls back', async () => {
  stopsByDate['2026-08-18'] = backtrackDay('', { customer_address_line1: '100 Main St' });
  liveRowsOverride = [
    { id: 'A', window_start: '09:00', route_order: 2, lat: 1, lng: 1, customer_address_line1: '100 Main St' },
    // Re-stamped on the customer record — the service rows are untouched.
    { id: 'B', window_start: '09:00', route_order: 1, lat: 1, lng: 3, customer_address_line1: '200 Oak Ave' },
    { id: 'C', window_start: '09:00', route_order: 3, lat: 1, lng: 2, customer_address_line1: '100 Main St' },
  ];
  const res = await runRouteReorder({ now: NOW });
  expect(res.applied).toBe(0);
  expect(trxUpdates).toEqual([]);
  const ledger = JSON.parse(ledgerInserts[0].result);
  expect(ledger.skips).toContainEqual(expect.objectContaining({ date: '2026-08-18', reason: 'STALE_TECH_DAY' }));
});
