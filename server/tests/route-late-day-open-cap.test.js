/**
 * GATE_ROUTE_CHECK_LATE_DAYS cap: a stop that is already late may not arrive more than
 * INSERTION_MARGIN_MINUTES (15) LATER than it does without the new visit. REAL evaluator, in-memory route.
 * Drive model: 20 minutes between different points, 0 between stops at the same point, so a new visit at
 * the late stop's own address adds only its work minutes to that stop's wait.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: (la1, lo1, la2, lo2) => (la1 === la2 && lo1 === lo2 ? 0 : 1),
  fallbackLegMetrics: (distance) => ({ minutes: distance === 0 ? 0 : 20 }),
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 20, source: 'conservative_model', reason: null }) }),
}));

const { evaluateArrivalPlacement, INSERTION_MARGIN_MINUTES } = require('../services/scheduling/arrival-route');

const DATE = '2027-03-01';
const hh = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const P1 = { lat: 27.5, lng: -82.4 };
const P2 = { lat: 27.6, lng: -82.4 };
const stop = (id, windowStart, durationMinutes, point, extra = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: hh(minOf(windowStart) + durationMinutes),
  estimated_duration_minutes: durationMinutes, ...point, route_order: null, created_at: '2020-01-01T12:00:00Z', ...extra,
});
// A: 08:20 to 11:42. B (promised 10:00, arrive by 12:00) is reached at 12:02: already 2 minutes late.
const ROWS = [stop('A', '08:00', 202, P1), stop('B', '10:00', 60, P2)];
const evaluate = (windowStart, durationMinutes, extra = {}) => {
  const target = stop('__candidate__', windowStart, durationMinutes, P2, { created_at: '2026-01-01T12:00:00Z' });
  const context = { date: DATE, now: new Date(`${DATE}T06:00:00-05:00`), target, rows: ROWS, grouped: false, prospective: true, blocks: [] };
  return evaluateArrivalPlacement(context, { windowStart, windowEnd: hh(minOf(windowStart) + durationMinutes), durationMinutes, ...extra });
};
const lateMinutesOfB = (fit) => minOf(fit.arrivals.find((a) => a.id === 'B').arrival) - 12 * 60;

beforeEach(() => { process.env.GATE_STAFF_ROUTE_INSERTION = 'true'; delete process.env.GATE_SCHEDULING_CAPACITY; });
afterEach(() => { delete process.env.GATE_STAFF_ROUTE_INSERTION; });

test('the cap is the insertion margin', () => {
  expect(INSERTION_MARGIN_MINUTES).toBe(15);
});

test('without the option the late day refuses the hour (gate off, unchanged)', () => {
  const fit = evaluate('11:00', 8);
  expect(Object.keys(fit).sort()).toEqual(['feasible', 'reason', 'target', 'warning']);
  expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
});

test('an hour that pushes the 2-minute-late stop to 10 minutes late is listed and flagged', () => {
  const fit = evaluate('11:00', 8, { lateDays: true });
  expect(fit).toMatchObject({ feasible: true, dayAlreadyLate: true });
  expect(fit.arrivals.map((a) => a.id)).toEqual(['A', '__candidate__', 'B']);
  expect(lateMinutesOfB(fit)).toBe(10);
});

test('the edge: exactly baseline + 15 (17 minutes late) is listed', () => {
  const fit = evaluate('11:00', 15, { lateDays: true });
  expect(fit).toMatchObject({ feasible: true, dayAlreadyLate: true });
  expect(lateMinutesOfB(fit)).toBe(17);
});

test('an hour that would push the 2-minute-late stop to 40 minutes late is refused', () => {
  const fit = evaluate('11:00', 38, { lateDays: true });
  expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  expect(fit).not.toHaveProperty('dayAlreadyLate');
});

test('one minute past the cap (18 minutes late) is refused', () => {
  expect(evaluate('11:00', 16, { lateDays: true })).toMatchObject({ feasible: false, reason: 'arrival_window' });
});
