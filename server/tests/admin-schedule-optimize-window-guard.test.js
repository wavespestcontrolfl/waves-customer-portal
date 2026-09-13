/**
 * The trusted admin route-optimize buttons (POST /schedule/optimize and
 * /schedule/optimize-route in admin-schedule.js) must never write an order
 * that violates a promised arrival window — verified in prod by a read-only
 * preview on 2026-09-12/13/14 that showed Google's shortest-loop order
 * putting a 16:00-promised stop FIRST and a 10:00 stop SIXTH (5-19 mi WORSE
 * than window order) while the endpoint reported it as a "savings". Both
 * endpoints now run the SAME chooseWindowSafeOrder guard chain the nightly
 * route-reorder pass runs (server/services/route-reorder.js): Google's order
 * passes chronology + feasibility ⇒ written unchanged; it fails and the
 * window-fit fallback (GATE_ROUTE_REORDER_WINDOW_FIT +
 * GATE_DRIVE_TIME_CALIBRATION) is on ⇒ the best LEGAL order is written
 * instead, source 'window_constrained'; it fails and no legal repair exists,
 * or the gates are off ⇒ nothing is written, 409 + a reason.
 *
 * /optimize handles multiple technicians on one call — the guard chain runs
 * PER TECH-DAY, and a tech-day that cannot be made legal fails the WHOLE
 * request (no partial write of another tech's otherwise-fine segment).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
// Deterministic geometry — same shared model the route-reorder test suites
// use: HQ at the origin, manhattan-degree "miles", 1000 m/mile, 0-minute legs.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 0, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2),
  fallbackLegMetrics: (miles) => ({ meters: Math.round(miles * 1000), minutes: 0 }),
  optimizeRoute: jest.fn(),
}));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/scheduling/quality-after-change', () => ({ refreshScheduleQualityAfterChange: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));

const express = require('express');
const db = require('../models/db');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const adminScheduleRouter = require('../routes/admin-schedule');

const DATE = '2026-09-20';

function stop(id, over = {}) {
  return {
    id, technician_id: 't1', route_order: null, window_start: null, window_end: null, time_window: null,
    estimated_duration_minutes: 60, service_type: 'pest', zone: 'z1', lat: 1, lng: 1,
    city: 'Bradenton', zip: '34205', customer_name: 'Test Customer', created_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

// Same fixture route-reorder-window-fit.test.js uses: T1 promised 09:00 far
// out (lng 10), T2 promised 13:00 near (lng 1), U untimed (lng 2). Current
// running order U,T2,T1 = 24000 m. Google's distance order T2,T1,U = 22000 m
// (illegal — 13:00 before 09:00). Best LEGAL order T1,U,T2 = 22000 m.
function chronologyDay(techId = 't1') {
  return [
    stop('T1', { technician_id: techId, window_start: '09:00', lng: 10, route_order: 3 }),
    stop('T2', { technician_id: techId, window_start: '13:00', lng: 1, route_order: 2 }),
    stop('U', { technician_id: techId, lng: 2, route_order: 1 }),
  ];
}

// No legal order exists: T1 09:00 (deadline 11:00) and T2 11:00 (deadline
// 13:00), each 300 minutes — whichever runs first blows the other's window.
function infeasibleDay(techId = 't1') {
  return [
    stop('T1', { technician_id: techId, window_start: '09:00', estimated_duration_minutes: 300, lng: 5, route_order: 3 }),
    stop('T2', { technician_id: techId, window_start: '11:00', estimated_duration_minutes: 300, lng: 1, route_order: 2 }),
    stop('U', { technician_id: techId, lng: 6, route_order: 1 }),
  ];
}

let stopsByDate;
let completedByDate;
let trxUpdates;

function trxTable() {
  const filters = {};
  let idsIn = null;
  const c = {};
  c.where = (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[String(a).replace('scheduled_services.', '')] = b; return c; };
  c.whereNull = (col) => { filters[col] = null; return c; };
  c.whereIn = (col, vals) => { if (String(col).endsWith('id')) idsIn = new Set(vals); return c; };
  c.leftJoin = () => c;
  c.modify = (fn) => { fn(c); return c; };
  c.update = async (u) => { trxUpdates.push({ ...filters, ...u }); return 1; };
  // The post-lock guard-input re-read. Reads stopsByDate LIVE, so a test that
  // mutates a row inside the lockTechDays mock is mutating it in the same gap
  // the fence exists to catch.
  c.whereNotNull = () => c;
  c.forUpdate = () => c;
  const rows = () => {
    // The completed-origin re-read inside the transaction (see
    // assertTechDayOriginsFresh) reads the same fixtures the pre-lock load did.
    if (filters.status === 'completed') {
      return (completedByDate[filters.scheduled_date] || [])
        .filter((row) => !filters.technician_id || row.technician_id === filters.technician_id);
    }
    return (stopsByDate[filters.scheduled_date] || [])
      .filter((row) => !idsIn || idsIn.has(row.id));
  };
  // Chainable AND thenable, as knex's builder is.
  c.select = () => c;
  c.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return c;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_ROUTE_REORDER_WINDOW_FIT;
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  stopsByDate = {};
  trxUpdates = [];
  db.raw = jest.fn((sql) => sql);
  completedByDate = {};
  // The origin loader reads today's COMPLETED stops directly (they are
  // excluded from every day query) — a thin chain over the same fixtures.
  db.mockImplementation(() => {
    const filters = {};
    const c = {};
    c.leftJoin = () => c;
    c.where = (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[String(a).replace('scheduled_services.', '')] = b; return c; };
    c.whereNotNull = () => c;
    c.modify = (fn) => { fn(c); return c; };
    c.forUpdate = () => c;
    // knex's .select() returns the BUILDER (the loader chains .modify() after
    // it and awaits the result), so the mock stays chainable and thenable.
    c.select = () => c;
    c.then = (resolve, reject) => Promise.resolve((completedByDate[filters.scheduled_date] || [])
      .filter((r) => !filters.technician_id || r.technician_id === filters.technician_id)).then(resolve, reject);
    return c;
  });
  // dayStopsQuery returns a knex builder in production — the post-lock fence
  // chains .forUpdate() onto it, so the mock has to be thenable AND chainable.
  dayStopsQuery.mockImplementation((_db, { dateStr, technicianId, select }) => {
    // PROJECT to the requested select list, as the real query does: a column
    // the production code forgets to ask for must be missing here too, or the
    // harness silently proves nothing (the co-visit identity columns are the
    // case in point).
    const keys = new Set(['id', 'lat', 'lng', 'city', 'zip', 'customer_name']);
    for (const entry of select || []) {
      if (typeof entry === 'string') keys.add(entry.split('.').pop());
      else if (entry && typeof entry === 'object' && !entry.sql) Object.keys(entry).forEach((k) => keys.add(k));
    }
    const rows = (stopsByDate[dateStr] || [])
      .filter((s) => !technicianId || s.technician_id === technicianId)
      .map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => keys.has(k))));
    const builder = Promise.resolve(rows);
    builder.forUpdate = () => builder;
    return builder;
  });
  db.transaction.mockImplementation(async (cb) => cb((table) => trxTable(table)));
});

const mockOptimizerOrder = (ids, extra = {}) => {
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: ids.map((id) => stops.find((s) => s.id === id)),
    totalDistanceMeters: 12345,
    totalDurationSeconds: 600,
    unoptimizedDistanceMeters: 99999,
    // Google returns a real duration per leg; the guard only lets live road
    // durations stand in for the calibrated model, so the default fixture
    // supplies them (zero minutes, matching this harness's travel model).
    legs: ids.map(() => ({ durationMinutes: 0 })),
    source: 'google_routes_api',
    ...extra,
  }));
};

async function optimizeRoute(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/optimize-route`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function optimizeAll(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/optimize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /schedule/optimize-route (single tech-day)', () => {
  test('(d) a legal Google order is written exactly as before', async () => {
    stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
    mockOptimizerOrder(['A', 'B']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.source).toBe('google_routes_api');
    expect(body.reason).toBeUndefined();
    expect(body.order.map((o) => o.id)).toEqual(['A', 'B']);
    expect(trxUpdates).toEqual([
      { id: 'A', scheduled_date: DATE, technician_id: 't1', route_order: 1 },
      { id: 'B', scheduled_date: DATE, technician_id: 't1', route_order: 2 },
    ]);
  });

  test('(a) a chronology-violating Google order is repaired and written with source window_constrained', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    stopsByDate[DATE] = chronologyDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.source).toBe('window_constrained');
    expect(body.order.map((o) => o.id)).toEqual(['T1', 'U', 'T2']);
    expect(trxUpdates).toEqual([
      { id: 'T1', scheduled_date: DATE, technician_id: 't1', route_order: 1 },
      { id: 'U', scheduled_date: DATE, technician_id: 't1', route_order: 2 },
      { id: 'T2', scheduled_date: DATE, technician_id: 't1', route_order: 3 },
    ]);
  });

  test('(b) gates on but no legal order exists: 409, reason NO_FEASIBLE_IMPROVEMENT, nothing written', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    stopsByDate[DATE] = infeasibleDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, reason: 'NO_FEASIBLE_IMPROVEMENT', conflict: 'WINDOW_ORDER_CONFLICT' });
    expect(trxUpdates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('(c) window-fit gate off: 409, reason WINDOW_FIT_GATE_OFF, nothing written', async () => {
    stopsByDate[DATE] = chronologyDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, reason: 'WINDOW_FIT_GATE_OFF', conflict: 'WINDOW_ORDER_CONFLICT' });
    expect(trxUpdates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('calibration gate off (window-fit gate alone is not enough): 409, reason WINDOW_FIT_GATE_OFF', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    stopsByDate[DATE] = chronologyDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body.reason).toBe('WINDOW_FIT_GATE_OFF');
    expect(trxUpdates).toEqual([]);
  });
});

describe('POST /schedule/optimize (multi tech-day)', () => {
  test('per-tech-day guard chain: t1 is repaired, t2 (legal) is left exactly as Google ordered it', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    const t2 = [stop('X', { technician_id: 't2', lng: 20, route_order: 1 }), stop('Y', { technician_id: 't2', lng: 21, route_order: 2 })];
    stopsByDate[DATE] = [...chronologyDay('t1'), ...t2];
    // Google's flat order interleaves both techs — only the multi-tech case
    // where legs cannot be trusted per tech (legsAlignToTech = null).
    mockOptimizerOrder(['T2', 'X', 'T1', 'Y', 'U']);
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.source).toBe('window_constrained');
    // t1's slots (wherever they sat in the flat order) now hold its legal
    // order T1,U,T2; t2's slots are untouched (X,Y exactly as Google had them).
    const ids = body.order.map((o) => o.id);
    const t1Positions = ids.filter((id) => ['T1', 'T2', 'U'].includes(id));
    const t2Positions = ids.filter((id) => ['X', 'Y'].includes(id));
    expect(t1Positions).toEqual(['T1', 'U', 'T2']);
    expect(t2Positions).toEqual(['X', 'Y']);
    expect(trxUpdates.find((u) => u.id === 'T1').route_order).toBeLessThan(trxUpdates.find((u) => u.id === 'U').route_order);
    expect(trxUpdates.find((u) => u.id === 'U').route_order).toBeLessThan(trxUpdates.find((u) => u.id === 'T2').route_order);
    expect(trxUpdates).toHaveLength(5);
  });

  test('repaired multi-tech figures are summed PER TECH-DAY, never scored as one flat route', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    const t2 = [stop('X', { technician_id: 't2', lng: 20, route_order: 1 }), stop('Y', { technician_id: 't2', lng: 21, route_order: 2 })];
    stopsByDate[DATE] = [...chronologyDay('t1'), ...t2];
    mockOptimizerOrder(['T2', 'X', 'T1', 'Y', 'U']);
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(200);
    // t1: current U,T2,T1 = 24000 m → legal T1,U,T2 = 22000 m. t2: X,Y is
    // legal and unchanged = 44000 m both before and after. Scoring the flat
    // five-stop list as one route would chain t1's last stop to t2's first
    // (a leg nobody drives) and report a different, fictitious number.
    const { modelDistanceMeters } = require('../services/route-reorder')._internals;
    const flatBefore = modelDistanceMeters(RouteOptimizer, [...stopsByDate[DATE]].sort((a, b) => a.route_order - b.route_order));
    expect(body.unoptimizedDistanceMeters).toBe(24000 + 44000);
    expect(body.totalDistanceMeters).toBe(22000 + 44000);
    expect(body.unoptimizedDistanceMeters).not.toBe(flatBefore);
    expect(body.savedDistanceMeters).toBe(2000);
  });

  test('one tech + unassigned stops: Google legs are NOT trusted for the tech slice (misaligned)', async () => {
    // Flat Google order N,A,B with N unassigned: legs[0]=HQ→N, legs[1]=N→A,
    // legs[2]=A→B. Sliced to the tech (A,B) those legs no longer line up.
    // If trusted positionally, the 1000-minute HQ→N leg would land on A and
    // blow its 09:00 window → a 409 for an order that is perfectly legal
    // under the shared model. Nothing may be repaired or refused here.
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    stopsByDate[DATE] = [
      stop('N', { technician_id: null, lng: 3, route_order: 1 }),
      stop('A', { technician_id: 't1', window_start: '09:00', lng: 1, route_order: 2 }),
      stop('B', { technician_id: 't1', lng: 2, route_order: 3 }),
    ];
    mockOptimizerOrder(['N', 'A', 'B'], { legs: [{ durationMinutes: 1000 }, { durationMinutes: 1000 }, { durationMinutes: 1000 }] });
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(200);
    expect(body.source).toBe('google_routes_api');
    expect(body.order.map((o) => o.id)).toEqual(['N', 'A', 'B']);
  });

  test('one unrepairable tech-day fails the WHOLE request — no partial write of the other tech', async () => {
    // t1 legal (two untimed stops); t2 has a chronology conflict and the
    // window-fit gate is off — the whole call must refuse, not write t1 alone.
    // Calibration is ON here: a multi-tech call has no usable Google legs, so
    // without it the guard refuses earlier (see the MODEL_UNCALIBRATED case).
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    const t1 = [stop('A', { technician_id: 't1', lng: 1, route_order: 1 }), stop('B', { technician_id: 't1', lng: 2, route_order: 2 })];
    stopsByDate[DATE] = [...t1, ...chronologyDay('t2')];
    mockOptimizerOrder(['A', 'T2', 'T1', 'U', 'B']);
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, reason: 'WINDOW_FIT_GATE_OFF', conflict: 'WINDOW_ORDER_CONFLICT', technicianId: 't2' });
    expect(trxUpdates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('every tech-day legal: response stays byte-identical to the pre-guard shape', async () => {
    const t1 = [stop('A', { technician_id: 't1', lng: 1, route_order: 2 }), stop('B', { technician_id: 't1', lng: 2, route_order: 1 })];
    stopsByDate[DATE] = t1;
    mockOptimizerOrder(['A', 'B'], { totalDistanceMeters: 4000, unoptimizedDistanceMeters: 5000, totalDurationSeconds: 300 });
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true, source: 'google_routes_api',
      totalDistanceMeters: 4000, unoptimizedDistanceMeters: 5000, savedDistanceMeters: 1000, savedPercent: 20,
    });
    expect(body.reason).toBeUndefined();
  });
});

// ── Codex round 1 ────────────────────────────────────────────────────────
describe('round-1 guards', () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');

  test('a stop without usable coordinates fails closed: 409 COORDLESS_STOPS, nothing written', async () => {
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    // Same chronology conflict as (a), but T1 never geocoded: both the
    // feasibility simulation and the distance model would treat its travel
    // as zero, so no repair built on it is trustworthy.
    stopsByDate[DATE] = chronologyDay().map((s) => (s.id === 'T1' ? { ...s, lat: null, lng: null } : s));
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, reason: 'COORDLESS_STOPS', conflict: 'WINDOW_ORDER_CONFLICT' });
    expect(trxUpdates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a window edited between the day load and the tech-day lock aborts the write (409)', async () => {
    stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
    mockOptimizerOrder(['A', 'B']);
    // Re-promised inside the lock gap: the order that is about to commit was
    // validated against A having no window at all.
    lockTechDays.mockImplementation(async () => {
      stopsByDate[DATE] = stopsByDate[DATE].map((s) => (s.id === 'A' ? { ...s, window_start: '09:00', window_end: '10:00' } : s));
    });
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body.error).toMatch(/reload and retry/i);
    expect(trxUpdates).toEqual([]);
  });

  test('an untouched day still commits — the fence is not a blanket abort', async () => {
    stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
    mockOptimizerOrder(['A', 'B']);
    lockTechDays.mockImplementation(async () => {});
    const { status } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(200);
    expect(trxUpdates.map((u) => u.id)).toEqual(['A', 'B']);
  });

  describe("today's route is already in progress", () => {
    // 15:30 ET on the day being optimized. T1's 09:00-10:00 promise is long
    // gone; T2's 16:00-17:00 is still keepable. Pre-fix, the guard simulated
    // from 08:00 with BOTH windows binding, so Google's T2-first order read
    // as a chronology violation and the repair drove the overdue T1 first —
    // losing the one promise still in play.
    const TODAY = '2026-09-20';
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-09-20T19:30:00Z')); // 15:30 ET
    });
    afterEach(() => { jest.useRealTimers(); });

    const elapsedDay = () => [
      stop('T1', { window_start: '09:00', window_end: '10:00', lng: 10, route_order: 1 }),
      stop('T2', { window_start: '16:00', window_end: '17:00', lng: 1, route_order: 2 }),
    ];

    test('an elapsed window no longer dictates order: Google’s T2-first order is written unchanged', async () => {
      process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
      process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
      stopsByDate[TODAY] = elapsedDay();
      mockOptimizerOrder(['T2', 'T1']);
      const { status, body } = await optimizeRoute({ technicianId: 't1' }); // no date ⇒ today
      expect(status).toBe(200);
      expect(body.source).toBe('google_routes_api');
      expect(trxUpdates.map((u) => u.id)).toEqual(['T2', 'T1']);
    });

    test('the same day on a FUTURE date still binds both windows and repairs to T1 first', async () => {
      process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
      process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
      const FUTURE = '2026-09-21';
      stopsByDate[FUTURE] = elapsedDay();
      mockOptimizerOrder(['T2', 'T1']);
      const { status, body } = await optimizeRoute({ technicianId: 't1', date: FUTURE });
      expect(status).toBe(200);
      expect(body.source).toBe('window_constrained');
      expect(trxUpdates.map((u) => u.id)).toEqual(['T1', 'T2']);
    });
  });
});


// Round-0 fallback audit P1: the current running order is a guard INPUT (the
// window-fit repair's backbone and the reported unoptimizedDistanceMeters),
// so an operator drag landing between the day load and the lock has to abort
// the write the same way a re-promised window does — the nightly fence
// snapshots route_order for exactly this reason.
test('a manual reorder landing between the day load and the lock aborts the write (409)', async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
  mockOptimizerOrder(['A', 'B']);
  lockTechDays.mockImplementation(async () => {
    stopsByDate[DATE] = stopsByDate[DATE].map((s) => (s.id === 'A' ? { ...s, route_order: 1 } : { ...s, route_order: 2 }));
  });
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(409);
  expect(body.error).toMatch(/reload and retry/i);
  expect(trxUpdates).toEqual([]);
});

// ── Codex round 2 ────────────────────────────────────────────────────────
describe('round-2 in-progress clock guards', () => {
  beforeEach(() => {
    // Earlier describes leave a mutating lockTechDays implementation behind
    // (clearAllMocks keeps implementations).
    require('../services/scheduling/tech-day-lock').lockTechDays.mockImplementation(async () => {});
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  });
  afterEach(() => { jest.useRealTimers(); });

  test('before 08:00 ET, today simulates from the day open — not from the current minute', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-20T11:00:00Z')); // 07:00 ET
    const TODAY = '2026-09-20';
    // X is 150 minutes of untimed work; Y is promised 08:00 (arrival
    // deadline 10:00 = 600). Simulated from an unavailable 07:00 the truck
    // finishes X at 570 and Y "fits"; from the real 08:00 day open it
    // finishes at 630 and Y's promise is blown — so X-first must be refused.
    stopsByDate[TODAY] = [
      stop('X', { estimated_duration_minutes: 150, lng: 2, route_order: 1 }),
      stop('Y', { window_start: '08:00', window_end: '09:00', estimated_duration_minutes: 30, lng: 1, route_order: 2 }),
    ];
    mockOptimizerOrder(['X', 'Y']);
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(200);
    expect(body.source).toBe('window_constrained');
    expect(trxUpdates.map((u) => u.id)).toEqual(['Y', 'X']);
  });

  test('a promise that has NOT elapsed at the real clock still binds, even before 08:00', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-20T11:00:00Z')); // 07:00 ET
    const TODAY = '2026-09-20';
    // A 06:00-07:30 promise (arrival deadline 08:00) is still keepable at
    // 07:00: judging "elapsed" on the clamped 08:00 clock instead of the raw
    // minute would throw it away. Google's order breaks it; the repair must
    // still put it first rather than treating it as unconstrained.
    stopsByDate[TODAY] = [
      stop('LATE', { window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 30, lng: 5, route_order: 1 }),
      stop('EARLY', { window_start: '06:00', window_end: '07:30', estimated_duration_minutes: 30, lng: 1, route_order: 2 }),
    ];
    mockOptimizerOrder(['LATE', 'EARLY']);
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(200);
    expect(body.source).toBe('window_constrained');
    expect(trxUpdates.map((u) => u.id)).toEqual(['EARLY', 'LATE']);
  });

  test('an elapsed window keeps its service duration — only the arrival deadline is relaxed', () => {
    const { chooseWindowSafeOrder } = require('../services/route-reorder');
    // A 09:00-12:00 job (no estimate ⇒ workDuration is its 180-minute span)
    // that is overdue at 12:30, then two still-keepable promises. Relaxing
    // the arrival constraint must NOT shrink the overdue job: at 180 minutes
    // it has to go LAST, and only a shrunken one could lead.
    const stops = [
      { id: 'OVERDUE', technician_id: 't1', status: 'confirmed', route_order: 1, window_start: '09:00', window_end: '12:00', estimated_duration_minutes: null, lat: 1, lng: 1 },
      { id: 'LATER', technician_id: 't1', status: 'confirmed', route_order: 2, window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 30, lat: 1, lng: 1 },
      { id: 'THIRD', technician_id: 't1', status: 'confirmed', route_order: 3, window_start: '14:00', window_end: '15:00', estimated_duration_minutes: 30, lat: 1, lng: 1 },
    ];
    const out = chooseWindowSafeOrder({
      RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api', startMin: 12 * 60 + 30,
    });
    expect(out.orderedStops.map((s) => s.id)).toEqual(['LATER', 'THIRD', 'OVERDUE']);
    // And the returned rows are the STORED ones — the relaxed copies exist
    // only inside the simulation, so nothing downstream can be told this
    // appointment has no promised window.
    const overdue = out.orderedStops.find((s) => s.id === 'OVERDUE');
    expect(overdue.window_start).toBe('09:00');
    expect(overdue.window_end).toBe('12:00');
  });
});

// ── Codex round 3 ────────────────────────────────────────────────────────
describe('round-3 guards', () => {
  beforeEach(() => {
    require('../services/scheduling/tech-day-lock').lockTechDays.mockImplementation(async () => {});
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  });
  afterEach(() => { jest.useRealTimers(); });

  test("today's route with a stop already in progress is refused, not re-simulated from HQ", async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-20T17:00:00Z')); // 13:00 ET
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = chronologyDay().map((s) => (s.id === 'T1' ? { ...s, status: 'on_site' } : s));
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(body.reason).toBe('LIVE_STOP_IN_PROGRESS');
    expect(body.error).toMatch(/already in progress/i);
    expect(trxUpdates).toEqual([]);
  });

  test('the same live stop on a FUTURE date is not in progress and optimizes normally', async () => {
    stopsByDate[DATE] = chronologyDay().map((s) => (s.id === 'T1' ? { ...s, status: 'on_site' } : s));
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(200);
    expect(body.source).toBe('window_constrained');
  });

  test('a coordinate change between the day load and the lock aborts the write', async () => {
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
    mockOptimizerOrder(['A', 'B']);
    // Re-geocoded in the lock gap: the order was computed for the old pin.
    lockTechDays.mockImplementation(async () => {
      stopsByDate[DATE] = stopsByDate[DATE].map((s) => (s.id === 'A' ? { ...s, lat: 9, lng: 9 } : s));
    });
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(409);
    expect(body.error).toMatch(/reload and retry/i);
    expect(trxUpdates).toEqual([]);
  });
});

// Round-0 codex audit P1s on the same head: a stop ADDED to the tech-day in
// the lock gap has no position in the order about to be written, and an
// ungeocoded stop makes the whole day unsimulatable whatever the guards said.
test('a stop added to the tech-day between the day load and the lock aborts the write', async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 2 }), stop('B', { lng: 2, route_order: 1 })];
  mockOptimizerOrder(['A', 'B']);
  lockTechDays.mockImplementation(async () => {
    stopsByDate[DATE] = [...stopsByDate[DATE], stop('C', { lng: 3, route_order: 3 })];
  });
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(409);
  expect(body.error).toMatch(/reload and retry/i);
  expect(trxUpdates).toEqual([]);
  lockTechDays.mockImplementation(async () => {});
});

test('an ungeocoded stop refuses the day even when Google’s order breaks no window', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Chronologically fine (A then B), but B has no pin: its travel counts as
  // zero in both simulations, so "feasible" is not knowable.
  stopsByDate[DATE] = [
    stop('A', { window_start: '09:00', lng: 1, route_order: 1 }),
    stop('B', { window_start: '13:00', lat: null, lng: null, route_order: 2 }),
  ];
  mockOptimizerOrder(['A', 'B']);
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(409);
  expect(body.reason).toBe('COORDLESS_STOPS');
  expect(body.conflict).toBeNull();
  expect(trxUpdates).toEqual([]);
});

// ── Codex round 4 ────────────────────────────────────────────────────────
describe('round-4 guards', () => {
  beforeEach(() => {
    require('../services/scheduling/tech-day-lock').lockTechDays.mockImplementation(async () => {});
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  });

  test('a legacy "4:00 PM" time_window is an afternoon promise, not a 4am one', () => {
    const { effectiveWindowStart, effectiveWindowRange } = require('../services/route-reorder')._internals;
    expect(effectiveWindowStart({ window_start: null, time_window: '4:00 PM' })).toBe('16:00');
    expect(effectiveWindowStart({ window_start: null, time_window: '9 AM' })).toBe('09:00');
    expect(effectiveWindowStart({ window_start: null, time_window: '12:00 AM' })).toBe('00:00');
    expect(effectiveWindowStart({ window_start: null, time_window: '12:00 PM' })).toBe('12:00');
    expect(effectiveWindowStart({ window_start: null, time_window: '14:30' })).toBe('14:30');
    expect(effectiveWindowStart({ window_start: null, time_window: 'any' })).toBeNull();
    expect(effectiveWindowRange({ window_start: null, time_window: '4:00 PM' })).toEqual({ startMin: 960, endMin: 1080 });
  });

  test('a terminal (no_show) stop without coordinates does not disable the whole day', async () => {
    stopsByDate[DATE] = [
      ...chronologyDay(),
      // Left on the board from an earlier attempt: never geocoded, not driven.
      stop('GHOST', { status: 'no_show', lat: null, lng: null, route_order: 9 }),
    ];
    mockOptimizerOrder(['T2', 'T1', 'U', 'GHOST']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
    expect(status).toBe(200);
    expect(body.source).toBe('window_constrained');
    // The live stops are repaired; the terminal row keeps its own slot.
    // The live stops are repaired; the terminal row is not rewritten at all.
    expect(trxUpdates.map((u) => u.id)).toEqual(['T1', 'U', 'T2']);
  });

  test('a repaired day counts an unassigned stop’s legs in the reported totals', async () => {
    stopsByDate[DATE] = [...chronologyDay(), stop('FREE', { technician_id: null, lng: 7, route_order: 4 })];
    mockOptimizerOrder(['T2', 'T1', 'U', 'FREE']);
    const { status, body } = await optimizeAll({ date: DATE });
    expect(status).toBe(200);
    // t1's repaired 22000/24000 m plus the unassigned stop's own bucket,
    // which is identical on both sides (its sequence is untouched, so no
    // saving is claimed for it) and non-zero (its legs ARE driven).
    const unassignedMeters = body.totalDistanceMeters - 22000;
    expect(unassignedMeters).toBeGreaterThan(0);
    expect(body.unoptimizedDistanceMeters).toBe(24000 + unassignedMeters);
  });
});

// Codex round 4 P1: legs are positional against the sequence the optimizer
// returned, so once a terminal stop is filtered out of it they no longer line
// up — one stop's travel must never be read as another's.
test('an interleaved terminal stop makes Google’s legs untrustworthy, not misaligned', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  stopsByDate[DATE] = [
    stop('A', { window_start: '09:00', lng: 1, route_order: 1 }),
    stop('DEAD', { status: 'skipped', lng: 2, route_order: 2 }),
    stop('B', { window_start: '13:00', lng: 3, route_order: 3 }),
  ];
  // A 600-minute leg sits at index 1 — DEAD's slot. Indexed positionally
  // after filtering it would be charged to B and blow its promise.
  mockOptimizerOrder(['A', 'DEAD', 'B'], {
    legs: [{ durationMinutes: 0 }, { durationMinutes: 600 }, { durationMinutes: 0 }],
  });
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(200);
  expect(body.reason).toBeUndefined();
  // Google's order is accepted as-is. Reading the misaligned 600-minute leg
  // as B's travel would blow B's promise and force a "repair" of an order
  // that was already legal.
  expect(body.source).toBe('google_routes_api');
  expect(trxUpdates.map((u) => u.id)).toEqual(['A', 'B']);
});

// Codex round 4 P1: the unassigned bucket must contribute its driving TIME as
// well as its mileage — reporting one without the other understates the day.
test('a repaired day counts the unassigned stop’s drive minutes too', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  // Non-zero travel for this case only: 1 "mile" per degree, 2 min per mile.
  const realLegs = RouteOptimizer.fallbackLegMetrics;
  RouteOptimizer.fallbackLegMetrics = (miles) => ({ meters: Math.round(miles * 1000), minutes: Math.round(miles * 2) });
  try {
    // Same board twice — the only difference is one UNASSIGNED stop, which
    // belongs to no tech-day and so changes nothing else.
    stopsByDate[DATE] = chronologyDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const withoutFree = (await optimizeAll({ date: DATE })).body;

    trxUpdates.length = 0;
    stopsByDate[DATE] = [...chronologyDay(), stop('FREE', { technician_id: null, lng: 7, route_order: 4 })];
    mockOptimizerOrder(['T2', 'T1', 'U', 'FREE']);
    const withFree = (await optimizeAll({ date: DATE })).body;

    expect(withoutFree.source).toBe('window_constrained');
    // FREE alone is HQ→(1,7)→HQ = 16 "miles" = 32 minutes of driving, and
    // 16000 m — both must land in the totals, not just the mileage.
    expect(withFree.totalDistanceMeters - withoutFree.totalDistanceMeters).toBe(16000);
    expect(withFree.totalDurationMinutes - withoutFree.totalDurationMinutes).toBe(32);
  } finally {
    RouteOptimizer.fallbackLegMetrics = realLegs;
  }
});

// ── Codex round 5 ────────────────────────────────────────────────────────
describe('round-5 origin guards', () => {
  const TODAY = '2026-09-20';
  beforeEach(() => {
    require('../services/scheduling/tech-day-lock').lockTechDays.mockImplementation(async () => {});
    process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-20T13:00:00Z')); // 09:00 ET
  });
  afterEach(() => { jest.useRealTimers(); });

  test("the remaining route is simulated from the truck's last completed stop, not HQ", async () => {
    // A repaired day reports OUR model's figures, so they expose the origin.
    // Same board twice: once with the truck still at HQ, once after it has
    // finished a stop 30 "miles" out.
    stopsByDate[TODAY] = chronologyDay();
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const fromHq = (await optimizeRoute({ technicianId: 't1' })).body;

    trxUpdates.length = 0;
    stopsByDate[TODAY] = chronologyDay();
    completedByDate[TODAY] = [{ id: 'DONE', technician_id: 't1', route_order: 0, lat: 1, lng: 30, check_out_time: '2026-09-20T12:50:00Z' }];
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const fromTruck = (await optimizeRoute({ technicianId: 't1' })).body;

    expect(fromHq.source).toBe('window_constrained');
    expect(fromTruck.source).toBe('window_constrained');
    // The first leg now starts 30 units away instead of at HQ, so both the
    // before and after figures grow by that real distance.
    expect(fromTruck.unoptimizedDistanceMeters).toBeGreaterThan(fromHq.unoptimizedDistanceMeters);
    expect(fromTruck.totalDistanceMeters).toBeGreaterThan(fromHq.totalDistanceMeters);
  });

  test('a started day whose last completed stop has no pin is refused, not modelled from HQ', async () => {
    stopsByDate[TODAY] = chronologyDay();
    completedByDate[TODAY] = [{ id: 'DONE', technician_id: 't1', route_order: 0, lat: null, lng: null }];
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const single = await optimizeRoute({ technicianId: 't1' });
    expect(single.status).toBe(409);
    expect(single.body.reason).toBe('PROGRESS_ORIGIN_UNKNOWN');
    // The board-wide endpoint refuses through the shared resolver too.
    trxUpdates.length = 0;
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const board = await optimizeAll({ date: TODAY });
    expect(board.status).toBe(409);
    expect(board.body.reason).toBe('PROGRESS_ORIGIN_UNKNOWN');
    expect(trxUpdates).toEqual([]);
  });

  test('a future date never loads an origin — every route starts at HQ', async () => {
    // DATE is today under this block's clock, so use a genuinely later day.
    const FUTURE = '2026-09-21';
    stopsByDate[FUTURE] = chronologyDay();
    completedByDate[FUTURE] = [{ id: 'DONE', technician_id: 't1', route_order: 0, lat: null, lng: null }];
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1', date: FUTURE });
    expect(status).toBe(200);
    expect(body.source).toBe('window_constrained');
  });
});

// Codex round 5 P1 follow-ons: Google measures its legs FROM HQ, and the
// truck's position is wherever its LATEST completion was — not wherever it
// last had a pin.
test('a truck origin discards Google’s HQ-measured legs', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T13:00:00Z')); // 09:00 ET
  const realLegs = RouteOptimizer.fallbackLegMetrics;
  RouteOptimizer.fallbackLegMetrics = (miles) => ({ meters: Math.round(miles * 1000), minutes: Math.round(miles * 2) });
  try {
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = [
      stop('A', { window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 30, lng: 1, route_order: 1 }),
      stop('B', { window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 30, lng: 2, route_order: 2 }),
    ];
    // The truck finished 400 units away — hours from A's 11:00 deadline.
    // Google's legs claim a free first drive because it measured from HQ.
    completedByDate[TODAY] = [{ id: 'DONE', technician_id: 't1', route_order: 0, lat: 1, lng: 400, check_out_time: '2026-09-20T12:55:00Z' }];
    mockOptimizerOrder(['A', 'B'], { legs: [{ durationMinutes: 0 }, { durationMinutes: 0 }] });
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    // Trusting those legs would have written this day as perfectly fine.
    expect(status).toBe(409);
    expect(body.reason).toBe('NO_FEASIBLE_IMPROVEMENT');
    expect(trxUpdates).toEqual([]);
  } finally {
    RouteOptimizer.fallbackLegMetrics = realLegs;
    jest.useRealTimers();
  }
});

test('the truck is at its LATEST completion — an older pinned stop is not a fallback', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T13:00:00Z'));
  try {
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = chronologyDay();
    completedByDate[TODAY] = [
      { id: 'EARLIER', technician_id: 't1', route_order: 0, lat: 1, lng: 5, check_out_time: '2026-09-20T12:00:00Z' },
      // Most recent, and unpinned: the truck's position is unknown.
      { id: 'LATEST', technician_id: 't1', route_order: 1, lat: null, lng: null, check_out_time: '2026-09-20T12:50:00Z' },
    ];
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(body.reason).toBe('PROGRESS_ORIGIN_UNKNOWN');
  } finally {
    jest.useRealTimers();
  }
});

// Codex round 5 P1: Google's totals and legs describe the route IT scored —
// every stop, starting at HQ. Once a terminal stop drops out or the truck's
// position replaces HQ, they describe a drive nobody takes, even when no
// window repair was needed.
test('a dropped terminal stop makes Google’s own totals stale, repair or not', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  stopsByDate[DATE] = [
    stop('A', { lng: 1, route_order: 1 }),
    stop('B', { lng: 2, route_order: 2 }),
    stop('GHOST', { status: 'no_show', lng: 50, route_order: 3 }),
  ];
  mockOptimizerOrder(['A', 'B', 'GHOST']);
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(200);
  // No repair was needed, but GHOST is not driven — so the response reports
  // our model (a short A→B loop), not Google's mocked 12345/99999 figures
  // for a route that includes a 50-unit detour.
  expect(body.source).toBe('google_routes_api');
  expect(body.totalDistanceMeters).not.toBe(12345);
  expect(body.unoptimizedDistanceMeters).not.toBe(99999);
  expect(body.legs).toEqual([]);
});

// Codex round 5: the completed rows an origin is derived from are NOT in the
// live-day freshness fence, so a time-on-site correction landing in the lock
// gap can change which completion is latest — and the order was certified
// from the old one.
test('a completed-stop correction in the lock gap aborts the write', async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T13:00:00Z')); // 09:00 ET
  try {
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = [stop('A', { lng: 1, route_order: 1 }), stop('B', { lng: 2, route_order: 2 })];
    completedByDate[TODAY] = [
      { id: 'D1', technician_id: 't1', route_order: 0, lat: 1, lng: 5, check_out_time: '2026-09-20T12:30:00Z' },
      { id: 'D2', technician_id: 't1', route_order: 0, lat: 1, lng: 9, check_out_time: '2026-09-20T12:50:00Z' },
    ];
    mockOptimizerOrder(['A', 'B']);
    // An operator corrects D1's time-on-site while the optimizer runs: D1 is
    // now the latest completion, so the truck is somewhere else entirely.
    lockTechDays.mockImplementation(async () => {
      completedByDate[TODAY] = [
        { id: 'D1', technician_id: 't1', route_order: 0, lat: 1, lng: 5, check_out_time: '2026-09-20T12:55:00Z' },
        { id: 'D2', technician_id: 't1', route_order: 0, lat: 1, lng: 9, check_out_time: '2026-09-20T12:50:00Z' },
      ];
    });
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/reload and retry/i);
    expect(trxUpdates).toEqual([]);
  } finally {
    lockTechDays.mockImplementation(async () => {});
    jest.useRealTimers();
  }
});

test('an unstamped completion makes the origin unprovable — the day refuses', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T13:00:00Z'));
  try {
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = chronologyDay();
    completedByDate[TODAY] = [
      { id: 'D1', technician_id: 't1', route_order: 1, lat: 1, lng: 5, check_out_time: '2026-09-20T12:30:00Z' },
      // No completion time at all: which of these is last cannot be proven,
      // and route_order is commonly null on real rows.
      { id: 'D2', technician_id: 't1', route_order: null, lat: 1, lng: 9 },
    ];
    mockOptimizerOrder(['T2', 'T1', 'U']);
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(body.reason).toBe('PROGRESS_ORIGIN_UNKNOWN');
  } finally {
    jest.useRealTimers();
  }
});

// Post-merge with #4435: the admin path must feed the co-visit merge its
// identity inputs, or a customer's two same-slot rows at one property count
// as two full visits and a legal day is refused.
test('a same-property bundled-service day is not counted as separate visits', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  const bundled = (id, over = {}) => stop(id, {
    customer_id: 'cust_pair', service_address_line1: '100 Main St',
    customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, window_start: '13:00', window_end: '14:00',
    estimated_duration_minutes: null, lat: 1, lng: 1, ...over,
  });
  // Pest + lawn + mosquito in ONE promised hour at one property, then a
  // different customer promised the same 13:00-14:00 slot (arrival deadline
  // 15:00). Counted separately the bundle eats three hours and that last
  // promise is provably missed; as one physical stop it is one hour.
  stopsByDate[DATE] = [
    bundled('PEST', { route_order: 1 }),
    bundled('LAWN', { route_order: 2 }),
    bundled('MOSQ', { route_order: 3 }),
    stop('OTHER', {
      customer_id: 'cust_other', service_address_line1: '900 Other Rd',
      customer_address_line1: '900 Other Rd', customer_city: 'Bradenton', customer_zip: '34205',
      visit_id: null, window_start: '13:00', window_end: '14:00',
      estimated_duration_minutes: null, lng: 1, route_order: 4,
    }),
  ];
  mockOptimizerOrder(['PEST', 'LAWN', 'MOSQ', 'OTHER']);
  const { status, body } = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(status).toBe(200);
  expect(body.reason).toBeUndefined();
  expect(trxUpdates.map((u) => u.id)).toEqual(['PEST', 'LAWN', 'MOSQ', 'OTHER']);
});

// Codex round 5 P1: relaxing an elapsed arrival deadline clears the window
// fields, and isCoVisitPair keys on the shared promise — so without carrying
// that identity across, an OVERDUE bundle counts as separate full visits
// again and eats hours the truck does not spend.
test('an overdue bundled stop is still one physical stop', () => {
  const { chooseWindowSafeOrder } = require('../services/route-reorder');
  const bundled = (id) => ({
    id, technician_id: 't1', status: 'confirmed', route_order: id === 'PEST' ? 1 : 2,
    customer_id: 'cust_pair', service_address_line1: '100 Main St',
    customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, window_start: '09:00', window_end: '10:00', time_window: null,
    estimated_duration_minutes: null, lat: 1, lng: 1,
  });
  // Both overdue at 12:30, and a 12:00-13:00 promise (deadline 14:00) after
  // them. As ONE stop the pair costs its promised hour and that later
  // arrival is reachable; as two it eats 120 minutes and is not.
  const stops = [bundled('PEST'), bundled('LAWN'), {
    id: 'NEXT', technician_id: 't1', status: 'confirmed', route_order: 3,
    customer_id: 'cust_next', service_address_line1: '900 Other Rd',
    customer_address_line1: '900 Other Rd', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, window_start: '12:00', window_end: '13:00', time_window: null,
    estimated_duration_minutes: 30, lat: 1, lng: 1,
  }];
  const out = chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api', startMin: 12 * 60 + 30,
  });
  expect(out.orderedStops).not.toBeNull();
  expect(out.orderedStops.map((s) => s.id)).toEqual(['PEST', 'LAWN', 'NEXT']);
  // And the rows handed back are the STORED ones — the relaxed copies, key
  // and all, never leave the simulation.
  expect(out.orderedStops[0].window_start).toBe('09:00');
  expect(out.orderedStops[0].co_visit_window_key).toBeUndefined();
});

// Codex round 5 P1: relaxing an overdue promise must keep the row's REAL
// estimate. Two genuine 60-minute services at one property are 120 minutes of
// work whether or not their deadline has passed.
test('an overdue bundle with real estimates still costs both of them', () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  const { chooseWindowSafeOrder } = require('../services/route-reorder');
  const bundled = (id, ro) => ({
    id, technician_id: 't1', status: 'confirmed', route_order: ro,
    customer_id: 'cust_pair', service_address_line1: '100 Main St',
    customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, window_start: '09:00', window_end: '10:00', time_window: null,
    estimated_duration_minutes: 60, lat: 1, lng: 1,
  });
  // Overdue at 12:30 — 120 real minutes of work would push a 12:00-13:00
  // promise (arrival deadline 14:00) sitting behind them out of reach, so
  // the legal order serves that promise FIRST and the overdue bundle after.
  // Counting the bundle as 60 minutes leaves the board order looking fine.
  const stops = [bundled('PEST', 1), bundled('LAWN', 2), {
    id: 'NEXT', technician_id: 't1', status: 'confirmed', route_order: 3,
    customer_id: 'cust_next', service_address_line1: '900 Other Rd',
    customer_address_line1: '900 Other Rd', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, window_start: '12:00', window_end: '13:00', time_window: null,
    estimated_duration_minutes: 30, lat: 1, lng: 1,
  }];
  const out = chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api', startMin: 12 * 60 + 30,
  });
  expect(out.orderedStops).not.toBeNull();
  expect(out.orderedStops.map((st) => st.id)).toEqual(['NEXT', 'PEST', 'LAWN']);
  expect(out.source).toBe('window_constrained');
});

// Codex round 5 P1: the accepted order is SCORED as well as guarded, and
// advanceSim reads the co-visit identity off the rows it is handed — so the
// scoring simulation has to see the relaxed rows too, or an overdue bundle
// looks like separate visits, the simulation fails, and that truck's whole
// drive time is reported as zero.
test('an accepted overdue bundle reports real drive minutes, not zero', () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  const realLegs = RouteOptimizer.fallbackLegMetrics;
  RouteOptimizer.fallbackLegMetrics = (miles) => ({ meters: Math.round(miles * 1000), minutes: Math.round(miles * 2) });
  try {
    const { chooseWindowSafeOrder } = require('../services/route-reorder');
    const bundled = (id, ro) => ({
      id, technician_id: 't1', status: 'confirmed', route_order: ro,
      customer_id: 'cust_pair', service_address_line1: '100 Main St',
      customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
      visit_id: null, window_start: '09:00', window_end: '10:00', time_window: null,
      estimated_duration_minutes: null, lat: 1, lng: 1,
    });
    // A three-service overdue bundle (one promised hour, relaxed) and a LIVE
    // 13:00-14:00 promise behind it. The guard merges the bundle and accepts
    // the order; scoring it without the merge would charge three hours, miss
    // that promise, and report the truck's whole drive as zero.
    const stops = [bundled('PEST', 1), bundled('LAWN', 2), bundled('MOSQ', 3), {
      id: 'NEXT', technician_id: 't1', status: 'confirmed', route_order: 4,
      customer_id: 'cust_next', service_address_line1: '900 Other Rd',
      customer_address_line1: '900 Other Rd', customer_city: 'Bradenton', customer_zip: '34205',
      visit_id: null, window_start: '13:00', window_end: '14:00', time_window: null,
      estimated_duration_minutes: 30, lat: 1, lng: 5,
    }];
    const out = chooseWindowSafeOrder({
      RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api', startMin: 12 * 60 + 30,
    });
    expect(out.orderedStops).not.toBeNull();
    expect(out.source).toBe('google_routes_api');
    expect(out.afterSeconds).not.toBeNull();
    expect(out.afterSeconds).toBeGreaterThan(0);
  } finally {
    RouteOptimizer.fallbackLegMetrics = realLegs;
  }
});

// Codex round 5 P1: a pass certified WITHOUT Google's legs rests entirely on
// the in-house model, and the fallback's own ruling requires that model to be
// calibrated. These buttons WRITE, so an uncalibrated "legal" is refused
// rather than committed.
test('a multi-tech call refuses while drive-time calibration is off', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  // Two techs, both perfectly legal — but a multi-tech slice has no usable
  // legs, so the only travel truth available is the uncalibrated model.
  stopsByDate[DATE] = [
    stop('A', { technician_id: 't1', lng: 1, route_order: 1 }),
    stop('B', { technician_id: 't1', lng: 2, route_order: 2 }),
    stop('C', { technician_id: 't2', lng: 3, route_order: 1 }),
    stop('D', { technician_id: 't2', lng: 4, route_order: 2 }),
  ];
  mockOptimizerOrder(['A', 'B', 'C', 'D']);
  const { status, body } = await optimizeAll({ date: DATE });
  expect(status).toBe(409);
  expect(body.reason).toBe('MODEL_UNCALIBRATED');
  expect(body.error).toMatch(/calibration is off/i);
  expect(trxUpdates).toEqual([]);

  // With calibration on, the same board writes.
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  mockOptimizerOrder(['A', 'B', 'C', 'D']);
  const ok = await optimizeAll({ date: DATE });
  expect(ok.status).toBe(200);
  expect(trxUpdates.map((u) => u.id)).toEqual(['A', 'B', 'C', 'D']);
});

// Codex round 5 P1: today's minute is sampled BEFORE the Routes API call, and
// the call plus a contended tech-day lock cost real time — an order that
// barely made a remaining promise at request start can be past it by commit.
test("today's order is re-checked at the current minute under the write locks", async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T17:00:00Z')); // 13:00 ET
  try {
    const TODAY = '2026-09-20';
    // A 16:00-17:00 promise (arrival deadline 18:00) behind a five-hour job:
    // starting at 13:00 the truck just makes it; starting at 15:00 it cannot,
    // and the legal order becomes promise-first.
    stopsByDate[TODAY] = [
      stop('LONG', { estimated_duration_minutes: 300, lng: 1, route_order: 1 }),
      stop('PROMISE', { window_start: '16:00', window_end: '17:00', estimated_duration_minutes: 30, lng: 2, route_order: 2 }),
    ];
    mockOptimizerOrder(['LONG', 'PROMISE']);
    // The lock is contended: two hours pass before the write.
    lockTechDays.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-09-20T19:00:00Z')); // 15:00 ET
    });
    const { status, body } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/reload and retry/i);
    expect(trxUpdates).toEqual([]);
  } finally {
    lockTechDays.mockImplementation(async () => {});
    jest.useRealTimers();
  }
});

// Codex round 5 P1: presence of a `legs` array does not mean Google measured
// it — the nearest-neighbour fallback and single_stop return MODEL legs, and
// an empty array is truthy. Only live road durations may stand in for the
// calibrated model.
test('model-derived legs do not satisfy the calibration requirement', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  stopsByDate[DATE] = [stop('A', { lng: 1, route_order: 1 }), stop('B', { lng: 2, route_order: 2 })];

  // Nearest-neighbour fallback: legs look real, but the optimizer modelled them.
  mockOptimizerOrder(['A', 'B'], { source: 'nearest_neighbor' });
  const modelled = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(modelled.status).toBe(409);
  expect(modelled.body.reason).toBe('MODEL_UNCALIBRATED');

  // An EMPTY leg list from Google is not live data either.
  mockOptimizerOrder(['A', 'B'], { legs: [] });
  const empty = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(empty.status).toBe(409);
  expect(empty.body.reason).toBe('MODEL_UNCALIBRATED');

  // Real Google durations: the day is certified without the gate.
  mockOptimizerOrder(['A', 'B']);
  const live = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(live.status).toBe(200);
  expect(trxUpdates.map((u) => u.id)).toEqual(['A', 'B']);
});

// Codex round 5 P1: the commit-time recheck advances the CLOCK but must keep
// the elapsed-window cutoff the decision was made under — otherwise a promise
// lost while waiting for locks quietly becomes unconstrained and passes.
test('a promise that expires during lock contention is not silently relaxed', async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T17:00:00Z')); // 13:00 ET
  try {
    const TODAY = '2026-09-20';
    // PROMISE is 13:00-14:00 (arrival deadline 15:00) and LONG is five hours
    // of work: at 13:00 only promise-first is legal, which is what Google
    // returns and what gets approved.
    stopsByDate[TODAY] = [
      stop('PROMISE', { window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 30, lng: 2, route_order: 1 }),
      stop('LONG', { estimated_duration_minutes: 300, lng: 1, route_order: 2 }),
    ];
    mockOptimizerOrder(['PROMISE', 'LONG']);
    // Two hours vanish waiting for the lock. PROMISE's deadline (15:00) is
    // now gone; judged at the LATER cutoff it would look unconstrained and
    // the stale order would sail through.
    lockTechDays.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-09-20T19:30:00Z')); // 15:30 ET
    });
    const { status } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(409);
    expect(trxUpdates).toEqual([]);
  } finally {
    lockTechDays.mockImplementation(async () => {});
    jest.useRealTimers();
  }
});

// Codex round 5 P1: /optimize-route's order is terminal-filtered while the
// board-wide resolver keeps those ids in place, so the commit-time recheck
// has to compare the DRIVEN subsequence — otherwise every minute boundary
// turns an unchanged, feasible route into a 409.
test('a terminal stop does not make the commit-time recheck reject a good route', async () => {
  const { lockTechDays } = require('../services/scheduling/tech-day-lock');
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-20T17:00:00Z')); // 13:00 ET
  try {
    const TODAY = '2026-09-20';
    stopsByDate[TODAY] = [
      stop('A', { lng: 1, route_order: 1 }),
      stop('GHOST', { status: 'skipped', lng: 9, route_order: 2 }),
      stop('B', { lng: 2, route_order: 3 }),
    ];
    mockOptimizerOrder(['A', 'GHOST', 'B']);
    // One minute passes — enough to trigger the recheck, not enough to change
    // anything real.
    lockTechDays.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-09-20T17:01:00Z'));
    });
    const { status } = await optimizeRoute({ technicianId: 't1' });
    expect(status).toBe(200);
    expect(trxUpdates.map((u) => u.id)).toEqual(['A', 'B']);
  } finally {
    lockTechDays.mockImplementation(async () => {});
    jest.useRealTimers();
  }
});

// Codex round 5 P2: a promise is still keepable AT its deadline minute (the
// feasibility rule lets a stop START at endMin), so relaxing it there would
// hand its slot to another stop and commit a late arrival.
test('a promise is not relaxed on its deadline minute', () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  const { chooseWindowSafeOrder } = require('../services/route-reorder');
  const at = (id, ro, over = {}) => ({
    id, technician_id: 't1', status: 'confirmed', route_order: ro,
    customer_id: `c_${id}`, service_address_line1: `${id} St`, customer_address_line1: `${id} St`,
    visit_id: null, time_window: null, lat: 1, lng: 1, estimated_duration_minutes: 30, ...over,
  });
  // DUE is promised 09:00-10:00, arrival deadline 11:00. At exactly 11:00 it
  // still binds, so Google's attempt to put the untimed stop first is a
  // chronology/feasibility problem rather than a free choice.
  const stops = [at('FREE', 1), at('DUE', 2, { window_start: '09:00', window_end: '10:00' })];
  const out = chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: stops, sourceStops: stops, googleSource: 'google_routes_api',
    startMin: 11 * 60, requireCalibratedModel: false,
  });
  // Still constrained: Google's untimed-first order is a conflict, and the
  // repair puts the promised stop back in front. Relaxed, it would simply be
  // accepted as written.
  expect(out.conflict).not.toBeNull();
  expect(out.orderedStops.map((s) => s.id)).toEqual(['DUE', 'FREE']);
});

// Codex round 5 P1: a nonempty leg list is not live evidence if it is SHORTER
// than the geocoded stop count — violatesWindowFeasibility refuses such a list
// and silently falls back to the model, so it must not buy a calibration
// bypass either.
test('a short leg list does not count as live evidence', async () => {
  process.env.GATE_ROUTE_REORDER_WINDOW_FIT = 'true';
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  stopsByDate[DATE] = [
    stop('A', { lng: 1, route_order: 1 }),
    stop('B', { lng: 2, route_order: 2 }),
    stop('C', { lng: 3, route_order: 3 }),
  ];
  // Google answered with one leg for three geocoded stops.
  mockOptimizerOrder(['A', 'B', 'C'], { legs: [{ durationMinutes: 4 }] });
  const short = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(short.status).toBe(409);
  expect(short.body.reason).toBe('MODEL_UNCALIBRATED');

  // A full list is live evidence and certifies the day without the gate.
  mockOptimizerOrder(['A', 'B', 'C']);
  const full = await optimizeRoute({ technicianId: 't1', date: DATE });
  expect(full.status).toBe(200);
});
