/**
 * GATE_ROUTE_CHECK_LATE_DAYS on the staff picked-hour verdict (pre-push audit P1, PR #7041): the list offers
 * hours on an already-late day, so picking one of them must read as a fit (not "doesn't fit"). REAL evaluator,
 * REAL checkArrivalPlacement and scorePickedHour on an in-memory day (no DB, no Google). The save advisory
 * (findConflictingVisits -> checkArrivalPlacement without lateDays) is not touched.
 * Drive model: 20 minutes between different points, 0 between stops at one point.
 */
jest.mock('../models/db', () => {
  const state = { target: null };
  const makeChain = () => {
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereNot', 'whereNotIn', 'whereNull', 'orWhereNull', 'orderBy', 'whereRaw']) chain[m] = () => chain;
    chain.first = async () => state.target;
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  };
  const db = jest.fn(() => makeChain());
  db.state = state;
  return db;
});
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
jest.mock('../services/rain-out', () => ({ loadOccupancy: jest.fn(async () => ({})), conflictsForTarget: jest.fn(() => []) }));
jest.mock('../services/scheduling/find-time', () => ({ DAY_START_HOUR: 8, DAY_END_HOUR: 17 }));
jest.mock('../services/scheduling/window-rules', () => ({ ADMIN_DAY_END_MINUTES: 20 * 60 }));

const db = require('../models/db');
const { loadArrivalRouteContext, enumerateArrivalPlacements } = require('../services/scheduling/arrival-route');
const { scorePickedHour } = require('../services/scheduling/find-time-hints');

const DATE = '2099-03-01';
const P1 = { lat: 27.5, lng: -82.4 };
const P2 = { lat: 27.6, lng: -82.4 };
const row = (id, windowStart, windowEnd, minutes, point, over = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed', window_start: windowStart, window_end: windowEnd,
  estimated_duration_minutes: minutes, ...point, route_order: null, created_at: '2020-01-01T12:00:00Z', ...over,
});
// A is reached 08:20 and finished 11:42; B (promised 10:00, by 12:00) is reached 12:02: already 2 minutes late.
mockDayRows = [row('A', '08:00', '11:22', 202, P1, { route_order: 1 }), row('B', '10:00', '11:00', 60, P2, { route_order: 2 })];
// The visit being moved here lives on another day, at B's address, and takes 10 minutes.
const STORED = row('N', '09:00', '09:10', 10, P2, { scheduled_date: '2099-03-02' });

const GATES = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_STAFF_ROUTE_INSERTION', 'GATE_ROUTE_CHECK_LATE_DAYS', 'GATE_SCHEDULING_CAPACITY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));
  GATES.forEach((k) => { delete process.env[k]; });
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
  db.state.target = STORED;
});
afterEach(() => { GATES.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

const hh = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const pick = (start, spanMin = 10) => scorePickedHour({
  rawSlots: [], from: DATE, today: '2026-01-01', sameDayFloorMin: undefined, useArrivalWindows: true,
  pickedStart: start, pickedEnd: hh(Number(start.slice(0, 2)) * 60 + spanMin), spanMin,
  serviceId: 'N', technicianId: 'tech', excludeServiceIds: ['N'], excluded: ['N'], changes: {}, withReason: true, paidRoads: false,
});
async function offeredStarts(spanMin = 10) {
  const context = await loadArrivalRouteContext({ conn: db, serviceId: 'N', date: DATE, technicianId: 'tech' });
  const { placements } = enumerateArrivalPlacements(context, { durationMinutes: spanMin, earliestStartMin: 8 * 60,
    latestServiceEndMin: 19 * 60, lateDays: true });
  return placements.map((p) => p.windowStart);
}

test('the audit case: an hour the list offers on the already-late day is a fit when picked, and carries the day flag', async () => {
  const offered = await offeredStarts();
  expect(offered).toContain('11:00');
  expect(await pick('11:00')).toMatchObject({ start: '11:00', fits: true, day_already_late: true });
});

test('offer and pick agree on every hour of the day: offered = fits, not offered = does not fit', async () => {
  const offered = new Set(await offeredStarts());
  for (let hour = 8; hour <= 18; hour++) {
    const start = hh(hour * 60);
    const verdict = await pick(start);
    expect([start, verdict.fits]).toEqual([start, offered.has(start)]);
    if (verdict.fits === false) expect(verdict.reason).toBe('arrival_window');
  }
});

test('gate off: the pick keeps today\'s verdict, "does not fit" on that hour, with no flag', async () => {
  delete process.env.GATE_ROUTE_CHECK_LATE_DAYS;
  const verdict = await pick('11:00');
  expect(verdict).toEqual({ start: '11:00', fits: false, reason: 'arrival_window' });
});

test('an hour on the late day that would add a new late stop still does not fit', async () => {
  // A 38-minute visit at 11:00 pushes the 2-minute-late B to 40 minutes late: past the cap.
  const verdict = await pick('11:00', 38);
  expect(verdict).toMatchObject({ start: '11:00', fits: false, reason: 'arrival_window' });
  expect(verdict).not.toHaveProperty('day_already_late');
});
