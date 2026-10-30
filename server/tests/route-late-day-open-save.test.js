/**
 * GATE_ROUTE_CHECK_LATE_DAYS on a staff save (Codex round 1, PR #7041, P1): the hour a picker offered by
 * inserting a visit ahead of an already-late stop must also be the order the save writes, or the visit keeps a
 * null route_order and sorts last (arriving past its own promise). placeMovedVisit takes `lateDays` from the
 * staff saves only; automatic writers, the gate off, and every other caller keep today's answer (null).
 * REAL evaluator and the real placeMovedVisit on an in-memory day (no DB, no Google).
 * Drive model: 20 minutes between different points, 0 between stops at one point.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: (la1, lo1, la2, lo2) => (la1 === la2 && lo1 === lo2 ? 0 : 1),
  fallbackLegMetrics: (distance) => ({ minutes: distance === 0 ? 0 : 20 }),
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 20, source: 'conservative_model', reason: null }) }),
}));
let mockDayRows = [];
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: () => {
    const q = { where: () => q, then: (resolve, reject) => Promise.resolve(mockDayRows).then(resolve, reject) };
    return q;
  },
  guardedCoordSelects: () => [],
  serviceLocationSelects: () => [],
  resolveServiceLocation: async (row) => ({ lat: row.lat, lng: row.lng }),
}));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => true) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const { placeMovedVisit } = require('../services/scheduling/arrival-route');
const { placeStaffSavedVisit, placeAutoSavedVisit } = require('../services/scheduling/staff-save-route-check');

const DATE = '2099-03-01';
const P1 = { lat: 27.5, lng: -82.4 };
const P2 = { lat: 27.6, lng: -82.4 };
const row = (id, windowStart, windowEnd, minutes, point, over = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed', window_start: windowStart, window_end: windowEnd,
  estimated_duration_minutes: minutes, ...point, route_order: null, created_at: '2020-01-01T12:00:00Z', ...over,
});
// A is reached 08:20 and finished 11:42; B (promised 10:00, by 12:00) is reached at 12:02, already 2 minutes late.
const A = row('A', '08:00', '11:22', 202, P1, { route_order: 1 });
const B = row('B', '10:00', '11:00', 60, P2, { route_order: 2 });
// The new visit at B's address, saved at 11:00 for 10 minutes: only A -> new -> B keeps it inside its promise.
const NEW = row('N', '11:00', '11:10', 10, P2);

function fakeConn(target) {
  const updates = [];
  const makeChain = (table) => {
    const state = {};
    const chain = {};
    for (const m of ['leftJoin', 'whereNot', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy', 'whereRaw']) chain[m] = () => chain;
    chain.where = (arg) => { if (arg && typeof arg === 'object' && arg.id) state.id = arg.id; if (arg === 'scheduled_services.id') state.byId = true; return chain; };
    chain.first = async () => (table === 'scheduled_services' ? target : null);
    chain.update = async (values) => { updates.push([state.id, values.route_order]); return 1; };
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  };
  const sp = jest.fn((table) => makeChain(table));
  sp.isTransaction = true;
  const conn = jest.fn((table) => makeChain(table));
  conn.isTransaction = true;
  conn.transaction = async (callback) => callback(sp);
  return { conn, updates };
}

const GATES = ['GATE_STAFF_ROUTE_INSERTION', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_ROUTE_CHECK_LATE_DAYS', 'GATE_ROUTE_CHECK_STAFF_SAVES',
  'GATE_ROUTE_CHECK_AUTO_SAVES', 'GATE_SCHEDULING_CAPACITY', 'GATE_SAVE_ROAD_TIMES'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));
  GATES.forEach((k) => { delete process.env[k]; });
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
  mockDayRows = [A, B, NEW];
});
afterEach(() => { GATES.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

const WRITTEN = [['A', 1], ['N', 2], ['B', 3]];

test('the audit reproduction: the offered 11:00 hour is saved in the order A, new visit, B', async () => {
  const { conn, updates } = fakeConn(NEW);
  await expect(placeMovedVisit(conn, { serviceId: 'N', staffSave: true, lateDays: true })).resolves.toEqual(['A', 'N', 'B']);
  expect(updates).toEqual(WRITTEN);
});

test('the same save without lateDays keeps today\'s answer: nothing certified, nothing written', async () => {
  const { conn, updates } = fakeConn(NEW);
  await expect(placeMovedVisit(conn, { serviceId: 'N', staffSave: true })).resolves.toBeNull();
  expect(updates).toEqual([]);
});

test('lateDays with the gate off is today\'s answer', async () => {
  delete process.env.GATE_ROUTE_CHECK_LATE_DAYS;
  const { conn, updates } = fakeConn(NEW);
  await expect(placeMovedVisit(conn, { serviceId: 'N', staffSave: true, lateDays: true })).resolves.toBeNull();
  expect(updates).toEqual([]);
});

test('the staff save writer passes it; the automatic writer does not', async () => {
  process.env.GATE_ROUTE_CHECK_STAFF_SAVES = 'true';
  process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true';
  const staff = fakeConn(NEW);
  await expect(placeStaffSavedVisit(staff.conn, { serviceId: 'N' })).resolves.toEqual(['A', 'N', 'B']);
  expect(staff.updates).toEqual(WRITTEN);
  const auto = fakeConn(NEW);
  await expect(placeAutoSavedVisit(auto.conn, { serviceId: 'N' })).resolves.toBeNull();
  expect(auto.updates).toEqual([]);
});

test('the cap holds on a save too: a visit that pushes the late stop 40 minutes later is not numbered', async () => {
  const long = row('N', '11:00', '11:38', 38, P2);
  mockDayRows = [A, B, long];
  const { conn, updates } = fakeConn(long);
  await expect(placeMovedVisit(conn, { serviceId: 'N', staffSave: true, lateDays: true })).resolves.toBeNull();
  expect(updates).toEqual([]);
});
