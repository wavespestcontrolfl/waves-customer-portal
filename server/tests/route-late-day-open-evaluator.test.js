/**
 * GATE_ROUTE_CHECK_LATE_DAYS (owner 2026-10-29, route-dispatcher audit fix A): the REAL evaluator
 * (evaluateArrivalPlacement / enumerateArrivalPlacements) on an in-memory route, no DB, no Google.
 * A day whose existing stops already arrive late must still list the hours that add no NEW late stop,
 * flagged `dayAlreadyLate`; the option is `lateDays` (find-time.js passes it under the gate). Without
 * it the result is exactly what it was. Every leg is 20 minutes; arrival promises are 2 hours.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  fallbackLegMetrics: () => ({ minutes: 20 }),
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 20, source: 'conservative_model', reason: null }) }),
}));

const { evaluateArrivalPlacement, enumerateArrivalPlacements } = require('../services/scheduling/arrival-route');

const DATE = '2027-03-01';
const hh = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const stop = (id, windowStart, durationMinutes, extra = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: hh(minOf(windowStart) + durationMinutes),
  estimated_duration_minutes: durationMinutes, lat: 27.5, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z', ...extra,
});
const prospective = (windowStart, durationMinutes) => stop('__candidate__', windowStart, durationMinutes, { created_at: '2026-01-01T12:00:00Z' });
function context(rows, target) {
  return { date: DATE, now: new Date(`${DATE}T06:00:00-05:00`), target, rows, grouped: false, prospective: true, travel: undefined, blocks: [] };
}
const evaluate = (rows, windowStart, durationMinutes, extra = {}) => {
  const target = prospective(windowStart, durationMinutes);
  return evaluateArrivalPlacement(context(rows, target), {
    windowStart, windowEnd: hh(minOf(windowStart) + durationMinutes), durationMinutes, ...extra,
  });
};

beforeEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; delete process.env.GATE_STAFF_ROUTE_INSERTION; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; delete process.env.GATE_STAFF_ROUTE_INSERTION; });

// A takes four hours, so B (promised 08:30, arrive by 10:30) is late with or without a new visit.
const LATE_DAY = [stop('A', '08:00', 240), stop('B', '08:30', 60)];

describe('lateDays off (the default): a day with an already-late stop is refused, byte for byte', () => {
  test('the refusal is exactly the old result, with no flag', () => {
    const fit = evaluate(LATE_DAY, '15:00', 60);
    expect(Object.keys(fit).sort()).toEqual(['feasible', 'reason', 'target', 'warning']);
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('lateDays: false is the same as leaving it out', () => {
    expect(evaluate(LATE_DAY, '15:00', 60, { lateDays: false })).toEqual(evaluate(LATE_DAY, '15:00', 60));
  });

  test('every hour of the late day is refused, so the staff list reads full', () => {
    const { placements, rejections } = enumerateArrivalPlacements(context(LATE_DAY, prospective('09:00', 60)),
      { durationMinutes: 60, earliestStartMin: 8 * 60, latestServiceEndMin: 19 * 60 });
    expect(placements).toEqual([]);
    expect(rejections).toEqual({ arrival_window: 11 });
  });

  test('a day with no late stop is unchanged by the option: same feasible fit, no flag', () => {
    const rows = [stop('A', '09:00', 60)];
    const plain = evaluate(rows, '13:00', 60);
    const withOption = evaluate(rows, '13:00', 60, { lateDays: true });
    expect(plain.feasible).toBe(true);
    expect(withOption).toEqual(plain);
    expect(withOption).not.toHaveProperty('dayAlreadyLate');
  });
});

describe('lateDays on: the hours that add no new late stop are listed and flagged', () => {
  test('the late day lists the afternoon hours, each flagged, with the usual fit fields', () => {
    const fit = evaluate(LATE_DAY, '15:00', 60, { lateDays: true });
    expect(fit).toMatchObject({ feasible: true, dayAlreadyLate: true });
    expect(fit.estimatedArrival).toBe('15:00');
    expect(fit.arrivals.map((a) => a.id)).toEqual(['A', 'B', '__candidate__']);
    expect(fit.arrivalDelayMinutes).toBeLessThanOrEqual(0);
  });

  test('the whole-day enumeration is no longer empty, and every placement carries the flag', () => {
    const { placements } = enumerateArrivalPlacements(context(LATE_DAY, prospective('09:00', 60)),
      { durationMinutes: 60, earliestStartMin: 8 * 60, latestServiceEndMin: 19 * 60, lateDays: true });
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every((p) => p.fit.dayAlreadyLate === true)).toBe(true);
    expect(placements.map((p) => p.windowStart)).toContain('15:00');
  });

  test('an hour that would make an on-time stop late stays refused', () => {
    // Z2 is already late (baseline). Z1 and C are on time without the new 12:00 visit for 150 minutes;
    // at every placement that keeps the new visit inside its own window, Z1 or C turns late.
    const rows = [stop('Z1', '08:00', 180), stop('Z2', '08:30', 60), stop('C', '13:00', 60)];
    const fit = evaluate(rows, '12:00', 150, { lateDays: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit).not.toHaveProperty('dayAlreadyLate');
    // The same day still lists a later hour that crowds nobody.
    expect(evaluate(rows, '16:00', 60, { lateDays: true })).toMatchObject({ feasible: true, dayAlreadyLate: true });
  });

  test('the visit\'s own window is still enforced: a van that cannot reach it in time is refused', () => {
    // The van leaves at 11:00; the new visit is promised 08:00-10:00, so it is late at every position.
    const fit = evaluate(LATE_DAY, '08:00', 60, { lateDays: true, departureMin: 11 * 60 });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('a stop that is already late is not made a reason to refuse by being after the new visit', () => {
    // The new 09:00 visit goes first at one position; B stays late either way. The hour is listed
    // only if no on-time stop turns late; here A is on time before and after, B is late before and after.
    const fit = evaluate([stop('A', '10:00', 240), stop('B', '10:30', 60)], '08:00', 60, { lateDays: true });
    // A (10:00-12:00) takes 4 hours, B is late in the baseline; the visit at 08:00 is first and keeps A on time.
    expect(fit).toMatchObject({ feasible: true, dayAlreadyLate: true });
  });

  test('a day with no already-late stop keeps its refusal, unflagged: the visit itself is the cause', () => {
    const rows = [stop('A', '09:00', 120), stop('B', '10:30', 60)];
    const fit = evaluate(rows, '10:00', 60, { lateDays: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit).not.toHaveProperty('dayAlreadyLate');
  });

  test('a late day that also runs past the day end keeps the day-end refusal', () => {
    const fit = evaluate(LATE_DAY, '19:00', 120, { lateDays: true });
    expect(fit.feasible).toBe(false);
  });

  test('the customer route check\'s explain: true is unaffected by the option', () => {
    const plain = evaluate(LATE_DAY, '15:00', 60, { explain: true });
    expect(plain.feasible).toBe(false);
    expect(plain.lateness.baselineLateStopIds).toEqual(['B']);
    expect(plain.lateness.newlyLateStopIds).toEqual([]);
  });
});

describe('the insertion margin (GATE_STAFF_ROUTE_INSERTION) on a late day', () => {
  const { _internals } = require('../services/scheduling/arrival-route');

  test('every place is tried: the hour that puts the visit first is listed, the hours that make A late are not', () => {
    process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
    const { placements } = enumerateArrivalPlacements(context(LATE_DAY, prospective('09:00', 60)),
      { durationMinutes: 60, earliestStartMin: 8 * 60, latestServiceEndMin: 19 * 60, lateDays: true });
    const starts = placements.map((p) => p.windowStart);
    // At 08:00 the visit goes ahead of A and B; B (already late) lands far past its window, which the
    // 15 minute insertion margin would refuse if an already-late stop counted.
    expect(starts).toContain('08:00');
    expect(starts).not.toContain('09:00');
    expect(starts).not.toContain('10:00');
    expect(placements.find((p) => p.windowStart === '08:00').fit.routeOrder.slice(0, 3)).toEqual(['__candidate__', 'A', 'B']);
    // Without the option the same insertion check lists nothing on this day.
    const plain = enumerateArrivalPlacements(context(LATE_DAY, prospective('09:00', 60)),
      { durationMinutes: 60, earliestStartMin: 8 * 60, latestServiceEndMin: 19 * 60 });
    expect(plain.placements).toEqual([]);
  });

  test('laterStopTooTight skips only the ids it is given: an on-time stop inside the margin still counts', () => {
    const simulation = { arrivals: [{ id: 'T', arrivalMin: 500 }, { id: 'B', arrivalMin: 840 }, { id: 'C', arrivalMin: 715 }] };
    const order = [{ id: 'T' }, { id: 'B' }, { id: 'C' }];
    const ranges = { T: { endMin: 620 }, B: { endMin: 630 }, C: { endMin: 720 } };
    const rangeFor = (row) => ranges[row.id];
    expect(_internals.laterStopTooTight(simulation, order, 'T', rangeFor, 15)).toBe(true);
    expect(_internals.laterStopTooTight(simulation, order, 'T', rangeFor, 15, new Set(['B']))).toBe(true); // C: 720 - 715 = 5 < 15
    expect(_internals.laterStopTooTight(simulation, order, 'T', rangeFor, 15, new Set(['B', 'C']))).toBe(false);
  });
});
