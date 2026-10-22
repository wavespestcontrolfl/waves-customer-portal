/**
 * Intelligence Bar optimize_tech_route with GATE_TECH_START_POINTS (part 3,
 * owner 2026-10-22): one technician per call, so the route starts and ends at
 * that tech's start point (the office when unset, invalid, or the gate is
 * off). optimize_all_routes mixes every truck into one flat route and keeps
 * the office. The point is staff-only: it is never in the card.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 0, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.abs(lat1 - lat2) + Math.abs(lng1 - lng2),
  fallbackLegMetrics: (miles) => ({ meters: Math.round(miles * 1000), minutes: 0 }),
  optimizeRoute: jest.fn(),
}));
jest.mock('../services/route-reorder', () => {
  const actual = jest.requireActual('../services/route-reorder');
  return {
    ...actual,
    loadTechDayOrigins: jest.fn(async () => ({ origins: new Map(), unknown: new Set() })),
    resolveWindowSafeOrderByTechDay: jest.fn(actual.resolveWindowSafeOrderByTechDay),
  };
});

const db = require('../models/db');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');
const routeReorder = require('../services/route-reorder');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const DATE = '2035-03-06';
const ENV = {
  start: process.env.GATE_TECH_START_POINTS,
  cal: process.env.GATE_DRIVE_TIME_CALIBRATION,
};
let techRow;

function stop(id, lng, over = {}) {
  return { id, technician_id: 'tech-1', route_order: null, window_start: null, window_end: null, time_window: null,
    estimated_duration_minutes: 60, service_type: 'pest', lat: 1, lng, first_name: 'Test', last_name: id, city: 'Bradenton',
    status: 'scheduled', service_address_line1: null, visit_id: null, customer_id: `c-${id}`, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  techRow = { id: 'tech-1', name: 'Test Tech', start_lat: '5', start_lng: '5' };
  db.mockImplementation((table) => {
    const q = {};
    q.whereILike = () => q;
    q.first = async () => (table === 'technicians' ? techRow : null);
    return q;
  });
  dayStopsQuery.mockImplementation(async () => [stop('A', 1, { route_order: 2 }), stop('B', 2, { route_order: 1 })]);
  RouteOptimizer.optimizeRoute.mockImplementation(async (stops) => ({
    orderedStops: stops, totalDistanceMeters: 4000, totalDurationSeconds: 120, unoptimizedDistanceMeters: 5000,
    legs: stops.map(() => ({ durationMinutes: 0 })), source: 'google_routes_api',
  }));
});
afterEach(() => {
  if (ENV.start === undefined) delete process.env.GATE_TECH_START_POINTS;
  else process.env.GATE_TECH_START_POINTS = ENV.start;
  if (ENV.cal === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = ENV.cal;
});

const startOf = () => {
  const [, options] = RouteOptimizer.optimizeRoute.mock.calls[0];
  return [options.startLat, options.startLng];
};
const run = (tool, input) => executeScheduleTool(tool, { date: DATE, technician_name: 'Test', ...input });

test('gate off: the office, and the guard is given the office for that tech', async () => {
  delete process.env.GATE_TECH_START_POINTS;
  const out = await run('optimize_tech_route');
  expect(out.proposal).toBe(true);
  expect(startOf()).toEqual([0, 0]);
  const { techHomes } = routeReorder.resolveWindowSafeOrderByTechDay.mock.calls[0][0];
  expect(techHomes.get('tech-1')).toBe(RouteOptimizer.HQ);
});

test('gate on: the tech start point drives both the optimizer and the window guard; the card never carries it', async () => {
  process.env.GATE_TECH_START_POINTS = 'true';
  const out = await run('optimize_tech_route');
  expect(out.proposal).toBe(true);
  expect(startOf()).toEqual([5, 5]);
  const { techHomes } = routeReorder.resolveWindowSafeOrderByTechDay.mock.calls[0][0];
  expect(techHomes.get('tech-1')).toEqual({ lat: 5, lng: 5 });
  expect(JSON.stringify(out)).not.toMatch(/start_lat|start_lng|startLat|startLng/);
});

test('gate on, tech with no start point or a bad one: the office', async () => {
  process.env.GATE_TECH_START_POINTS = 'true';
  techRow = { id: 'tech-1', name: 'Test Tech', start_lat: null, start_lng: null };
  await run('optimize_tech_route');
  expect(startOf()).toEqual([0, 0]);
  RouteOptimizer.optimizeRoute.mockClear();
  techRow = { id: 'tech-1', name: 'Test Tech', start_lat: 'x', start_lng: '5' };
  await run('optimize_tech_route');
  expect(startOf()).toEqual([0, 0]);
});

test('gate on: optimize_all_routes mixes every truck into one route and stays at the office', async () => {
  process.env.GATE_TECH_START_POINTS = 'true';
  await run('optimize_all_routes');
  expect(startOf()).toEqual([0, 0]);
});
