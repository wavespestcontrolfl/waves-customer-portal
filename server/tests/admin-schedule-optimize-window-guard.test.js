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
let trxUpdates;

function trxTable() {
  const filters = {};
  const c = {};
  c.where = (a, b) => { if (typeof a === 'object') Object.assign(filters, a); else filters[a] = b; return c; };
  c.whereNull = (col) => { filters[col] = null; return c; };
  c.modify = (fn) => { fn(c); return c; };
  c.update = async (u) => { trxUpdates.push({ ...filters, ...u }); return 1; };
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
  dayStopsQuery.mockImplementation(async (_db, { dateStr, technicianId }) => (stopsByDate[dateStr] || [])
    .filter((s) => !technicianId || s.technician_id === technicianId));
  db.transaction.mockImplementation(async (cb) => cb((table) => trxTable(table)));
});

const mockOptimizerOrder = (ids, extra = {}) => {
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: ids.map((id) => stops.find((s) => s.id === id)),
    totalDistanceMeters: 12345,
    totalDurationSeconds: 600,
    unoptimizedDistanceMeters: 99999,
    legs: [],
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
    const { modelDistanceMeters } = require('../services/route-reorder');
    const flatBefore = modelDistanceMeters(RouteOptimizer, [...stopsByDate[DATE]].sort((a, b) => a.route_order - b.route_order));
    expect(body.unoptimizedDistanceMeters).toBe(24000 + 44000);
    expect(body.totalDistanceMeters).toBe(22000 + 44000);
    expect(body.unoptimizedDistanceMeters).not.toBe(flatBefore);
    expect(body.savedDistanceMeters).toBe(2000);
  });

  test('one unrepairable tech-day fails the WHOLE request — no partial write of the other tech', async () => {
    // t1 legal (two untimed stops); t2 has a chronology conflict and the
    // window-fit gate is off — the whole call must refuse, not write t1 alone.
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
