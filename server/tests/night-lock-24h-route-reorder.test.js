// GATE_NIGHT_LOCK_24H (owner 2026-11-03) in the 04:20 route-reorder pass: the
// cron entry (runRouteReorderIfEnabled) reads the gate once and hands it down
// as opts.nightLock24h. On, a tech-day is frozen only when a stop starts
// within 24 hours or its 24-hour reminder was sent (skip codes WITHIN_72H and
// REMINDER_SENT_FROZEN are unchanged), the commit-time fence uses the same
// rule, and the ledger's freeze_hours records 24. Anything that does not pass
// the option (repair runs, the cleanup script, direct calls) keeps 72 hours.
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
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const {
  runRouteReorder, runRouteRepairAfterChange, runRouteReorderIfEnabled, writeTechDayOrder,
} = require('../services/route-reorder');

// Fixed clock: 2026-08-13 04:10 ET (08:10Z). Band = 2026-08-14 .. 2026-08-19.
const NOW = new Date('2026-08-13T08:10:00Z');

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


afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_ROUTE_REORDER;
  delete process.env.GATE_NIGHT_LOCK_24H;
});

const ledgerOf = () => JSON.parse(ledgerInserts[0].result);
const skipReasons = (ledger) => Object.fromEntries(ledger.skips.map((s) => [s.date, s.reason]));

describe('opts.nightLock24h on (the nightly pass with the gate on)', () => {
  test('a day whose stops are all 29+ h out is reorderable; a day with a stop 20 h out is frozen', async () => {
    // NOW is 04:10 ET 08-13. 08-14 09:00 ET is ~29 h out; 08-14 00:30 ET ~20 h out.
    stopsByDate['2026-08-14'] = backtrackDay('a'); // 09:00 stops -> reorderable
    stopsByDate['2026-08-15'] = backtrackDay('b');
    stopsByDate['2026-08-16'] = [...backtrackDay('c'), stop('early', { window_start: '00:30', lng: 4, route_order: 4 })];
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(2);
    expect(ledgerOf().reorders.map((r) => r.date)).toEqual(['2026-08-14', '2026-08-15']);
  });

  test('a stop 20 h out freezes its day with the existing WITHIN_72H code', async () => {
    stopsByDate['2026-08-14'] = [...backtrackDay('c'), stop('early', { window_start: '00:30', lng: 4, route_order: 4 })];
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(0);
    expect(skipReasons(ledgerOf())['2026-08-14']).toBe('WITHIN_72H');
  });

  test('the SAME 29 h day is frozen when the option is absent (72-hour rule, gate off)', async () => {
    stopsByDate['2026-08-14'] = backtrackDay('a');
    const res = await runRouteReorder({ now: NOW });
    expect(res.applied).toBe(0);
    expect(skipReasons(ledgerOf())['2026-08-14']).toBe('WITHIN_72H');
    // false behaves like absent
    ledgerInserts = [];
    expect((await runRouteReorder({ now: NOW, nightLock24h: false })).applied).toBe(0);
  });

  test('a 24-hour reminder sent freezes the day (REMINDER_SENT_FROZEN); the freeze is read with the lock24h option', async () => {
    stopsByDate['2026-08-14'] = backtrackDay('a');
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set(['aA']) });
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(0);
    expect(skipReasons(ledgerOf())['2026-08-14']).toBe('REMINDER_SENT_FROZEN');
    expect(routeTiers.loadReminderFreeze).toHaveBeenCalledWith(expect.anything(), ['aA', 'aB', 'aC'], NOW, undefined, { lock24h: true });
  });

  test('gate off: the freeze read is the pre-gate call, argument for argument', async () => {
    stopsByDate['2026-08-16'] = backtrackDay('a');
    await runRouteReorder({ now: NOW });
    for (const call of routeTiers.loadReminderFreeze.mock.calls) expect(call).toHaveLength(3);
  });

  test('an unreadable reminder status still freezes the day and degrades the run (fail closed)', async () => {
    stopsByDate['2026-08-14'] = backtrackDay('a');
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: true, frozen: new Set() });
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(0);
    expect(res.status).toBe('completed_with_errors');
  });

  test('the ledger records the hours actually used: 24 on (with night_lock_24h), 72 off', async () => {
    await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(JSON.parse(ledgerInserts[0].constraints)).toMatchObject({ freeze_hours: 24, night_lock_24h: true });
    ledgerInserts = [];
    await runRouteReorder({ now: NOW });
    const off = JSON.parse(ledgerInserts[0].constraints);
    expect(off.freeze_hours).toBe(72);
    expect(off).not.toHaveProperty('night_lock_24h');
  });

  test('commit-time fence: a day that entered the 24-hour window during the run rolls back; 29 h does not', async () => {
    stopsByDate['2026-08-14'] = backtrackDay('a');
    // Clean at day load (29 h), then the clock at commit is 23 h from the stops.
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(1);
    const techStops = stopsByDate['2026-08-14'];
    const lateNow = new Date('2026-08-14T03:00:00Z'); // 23:00 ET on 08-13 -> the 09:00 stops are 10 h out
    const err = await writeTechDayOrder(db, {
      dateStr: '2026-08-14', techId: 't1', techStops, finalOrdered: techStops, repair: null, opts: { now: lateNow, nightLock24h: true }, now: NOW, repairGates: [],
    }).catch((e) => e);
    expect(err.code).toBe('STALE_TECH_DAY');
    expect(err.message).toBe('day entered the 24h freeze window during the run');
    // 29 h out at commit: passes under 24 h, stale under the 72-hour rule.
    const ok = await writeTechDayOrder(db, {
      dateStr: '2026-08-14', techId: 't1', techStops, finalOrdered: techStops, repair: null, opts: { now: NOW, nightLock24h: true }, now: NOW, repairGates: [],
    }).catch((e) => e);
    expect(ok).not.toBeInstanceOf(Error);
    const stale72 = await writeTechDayOrder(db, {
      dateStr: '2026-08-14', techId: 't1', techStops, finalOrdered: techStops, repair: null, opts: { now: NOW }, now: NOW, repairGates: [],
    }).catch((e) => e);
    expect(stale72.message).toBe('day entered the 72h freeze window during the run');
  });

  test('a 24-hour reminder sent during the run rolls the commit back, naming 24h', async () => {
    stopsByDate['2026-08-14'] = backtrackDay('a');
    routeTiers.loadReminderFreeze
      .mockResolvedValueOnce({ failed: false, frozen: new Set() })
      .mockResolvedValueOnce({ failed: false, frozen: new Set(['aA']) });
    const res = await runRouteReorder({ now: NOW, nightLock24h: true });
    expect(res.applied).toBe(0);
    expect(ledgerOf().skips).toContainEqual(expect.objectContaining({ date: '2026-08-14', reason: 'STALE_TECH_DAY', detail: 'a 24h reminder was sent during the run' }));
  });
});

describe('the cron entry reads the gate once and passes it down', () => {
  const frozenClock = () => jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'],
  });

  test('gate on: runRouteReorderIfEnabled applies the 24-hour lock', async () => {
    frozenClock();
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    stopsByDate['2026-08-14'] = backtrackDay('a'); // ~29 h out
    const res = await runRouteReorderIfEnabled();
    expect(res.applied).toBe(1);
    expect(JSON.parse(ledgerInserts[0].constraints).freeze_hours).toBe(24);
  });

  test('gate off or unset: the same night keeps the 72-hour lock', async () => {
    frozenClock();
    process.env.GATE_ROUTE_REORDER = 'true';
    stopsByDate['2026-08-14'] = backtrackDay('a');
    const res = await runRouteReorderIfEnabled();
    expect(res.applied).toBe(0);
    expect(JSON.parse(ledgerInserts[0].constraints).freeze_hours).toBe(72);
  });

  test('a flip during the run does not mix rules: the commit fence still uses the run\'s 24-hour read', async () => {
    frozenClock();
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    stopsByDate['2026-08-14'] = backtrackDay('a');
    RouteOptimizer.optimizeRoute.mockImplementationOnce(async (stops) => {
      delete process.env.GATE_NIGHT_LOCK_24H; // pulled while the optimizer runs
      return { orderedStops: [...stops].sort((p, q) => p.lng - q.lng), totalDistanceMeters: 1, totalDurationSeconds: 1, unoptimizedDistanceMeters: 1, source: 'google_routes_api' };
    });
    const res = await runRouteReorderIfEnabled();
    expect(res.applied).toBe(1);
  });

  test('the repair-after-change entry never opts in', async () => {
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    try {
      stopsByDate['2026-08-14'] = backtrackDay('a');
      await runRouteRepairAfterChange({ dates: ['2026-08-14'], now: NOW });
      expect(JSON.parse(ledgerInserts[0].constraints).freeze_hours).toBe(72);
    } finally {
      delete process.env.GATE_ROUTE_REORDER_REPAIR;
      delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    }
  });
});
