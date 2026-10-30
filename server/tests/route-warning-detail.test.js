/**
 * GATE_ROUTE_WARNING_DETAIL (route-dispatcher audit, fix B): a staff route warning names the stop, its
 * window, the predicted arrival and the minutes; a route that cannot be verified names its cause and stop.
 * REAL evaluator on an in-memory route (no DB, no Google); only the drive model is fixed: every leg is
 * 20 minutes. Arrival promises are 2 hours from the window start. Gate unset = today's strings, byte for byte.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  fallbackLegMetrics: () => ({ minutes: 20 }),
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 20, source: 'conservative_model', reason: null }) }),
}));

const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { windowText, clockText, stopLabel } = require('../services/scheduling/route-warning-detail');

const DATE = '2027-03-01';
const hh = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
// Rows carry customer names and addresses on purpose: no warning may repeat any of them.
const stop = (id, windowStart, durationMinutes, extra = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: hh(Number(windowStart.slice(0, 2)) * 60 + Number(windowStart.slice(3)) + durationMinutes),
  estimated_duration_minutes: durationMinutes, lat: 27.5, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z',
  first_name: 'Zelda', last_name: 'Zebrowski', customer_name: 'Zelda Zebrowski', address_line1: '88 Quagmire Lane',
  ...extra,
});
const candidate = (windowStart, durationMinutes) => stop('__candidate__', windowStart, durationMinutes, { created_at: '2026-01-01T12:00:00Z' });
function context(rows, target, extra = {}) {
  return { date: DATE, now: new Date(`${DATE}T06:00:00-05:00`), target, rows, grouped: false,
    prospective: target.id === '__candidate__', travel: undefined, blocks: [], ...extra };
}
const run = (rows, target, opts = {}, ctx = {}) => evaluateArrivalPlacement(context(rows, target, ctx), {
  windowStart: target.window_start, windowEnd: target.window_end, durationMinutes: 60, ...opts });
const NAMES = /Zelda|Zebrowski|Quagmire/;

const GENERIC = `The route on ${DATE} cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.`;
const UNVERIFIED = `Could not verify the route's arrival windows on ${DATE}. Review the route before driving it.`;

const LATE_CASE = () => run([stop('A', '09:00', 120), stop('B', '10:30', 60)], candidate('10:00', 60), { detail: true });

beforeEach(() => {
  delete process.env.GATE_ROUTE_WARNING_DETAIL;
  delete process.env.GATE_STAFF_ROUTE_INSERTION;
  delete process.env.GATE_SCHEDULING_CAPACITY;
});
afterEach(() => {
  delete process.env.GATE_ROUTE_WARNING_DETAIL;
  delete process.env.GATE_STAFF_ROUTE_INSERTION;
  delete process.env.GATE_SCHEDULING_CAPACITY;
});

describe('the words', () => {
  test('clock, window and stop labels', () => {
    expect(clockText(16 * 60 + 12)).toBe('4:12 PM');
    expect(clockText(12 * 60)).toBe('12 PM');
    expect(clockText(0)).toBe('12 AM');
    expect(windowText({ startMin: 14 * 60, endMin: 16 * 60 })).toBe('2–4 PM');
    expect(windowText({ startMin: 11 * 60, endMin: 13 * 60 })).toBe('11 AM–1 PM');
    expect(windowText({ startMin: 8 * 60 + 30, endMin: 10 * 60 + 30 })).toBe('8:30–10:30 AM');
    expect(windowText(null)).toBe('');
    expect(stopLabel(6, { startMin: 14 * 60, endMin: 16 * 60 })).toBe('Stop 6 (2–4 PM window)');
    expect(stopLabel(6, null)).toBe('Stop 6');
  });
});

describe('gate off: every warning string is today\'s, byte for byte', () => {
  test('arrival_window with or without a staff save asking for detail', () => {
    for (const detail of [false, true]) {
      const fit = run([stop('A', '09:00', 120), stop('B', '10:30', 60)], candidate('10:00', 60), { detail });
      expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window', warning: GENERIC });
      expect(fit.baseWarning).toBeUndefined();
    }
  });

  test('route_unverified: no pin, no technician', () => {
    expect(run([], stop('T', '08:00', 60, { lat: null }), { detail: true }).warning).toBe(UNVERIFIED);
    expect(run([], stop('T', '08:00', 60, { technician_id: null }), { detail: true }).warning).toBe(UNVERIFIED);
    expect(run([stop('A', '08:00', 60, { lat: null })], stop('T', '10:00', 60), { detail: true }).warning).toBe(UNVERIFIED);
  });

  test('arrival_margin and without detail the result has no diagnostics at all', () => {
    process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
    const fit = run([stop('B', '10:00', 60)], candidate('08:00', 190), { durationMinutes: 190 });
    expect(fit.reason).toBe('arrival_margin');
    expect(fit.warning).toBe(`The route on ${DATE} fits this visit only by leaving a later stop less than 15 minutes before its arrival window closes. Choose another window.`);
    expect(fit).not.toHaveProperty('diagnostics');
  });

  test('a staff save asking for detail with the gate off still gets the log diagnostics, and the old sentence', () => {
    const fit = LATE_CASE();
    expect(fit.warning).toBe(GENERIC);
    expect(fit.diagnostics).toEqual({ placement: 'none', travelSource: 'conservative_model', lateStopIds: [] });
  });
});

describe('gate on: arrival_window names the stop', () => {
  beforeEach(() => { process.env.GATE_ROUTE_WARNING_DETAIL = 'true'; });

  test('a stop made late: its number, window, predicted arrival and minutes', () => {
    const fit = LATE_CASE();
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 3 (10:30 AM–12:30 PM window) would arrive 12:40 PM, 10 min late.`);
    expect(fit.baseWarning).toBe(GENERIC);
    expect(fit.diagnostics).toEqual({ placement: 'none', travelSource: 'conservative_model', lateStopIds: ['B'] });
  });

  test('the visit itself cannot reach its own window: its own sentence, nobody else blamed', () => {
    const fit = run([], candidate('08:00', 60), { detail: true, departureMin: 11 * 60 });
    expect(fit.reason).toBe('arrival_window');
    expect(fit.warning).toBe(`Route on ${DATE}: This new visit (8–10 AM window) would arrive 11:20 AM, 80 min late, so it cannot keep its own window.`);
    expect(fit.diagnostics.lateStopIds).toEqual(['new']);
  });

  test('a saved visit that is late names its own stop number', () => {
    const saved = stop('T', '08:00', 60);
    const fit = run([], saved, { detail: true, departureMin: 11 * 60 }, { prospective: false });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) is this visit and would arrive 11:20 AM, 80 min late, so it cannot keep its own window.`);
  });

  test('the route runs past the end of the day: its own sentence', () => {
    const fit = run([stop('A', '09:00', 60)], candidate('19:00', 120), { detail: true });
    expect(fit.warning).toBe(`Route on ${DATE}: The route would run past 8 PM, the end of the workday.`);
  });

  test('a day already late without the visit says so, with the stop and minutes', () => {
    const fit = run([stop('A', '08:00', 240), stop('B', '08:30', 60)], candidate('15:00', 60), { detail: true });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 2 (8:30–10:30 AM window) would already arrive 12:40 PM, 130 min late without this visit.`);
    expect(fit.diagnostics.lateStopIds).toEqual(['B']);
  });

  test('a day already late in several places: at most two stops are named', () => {
    const rows = [stop('A', '08:00', 240), stop('B', '08:20', 30), stop('C', '08:40', 30), stop('D', '09:00', 30), stop('E', '09:20', 30)];
    const fit = run(rows, candidate('15:00', 60), { detail: true });
    // All are late with or without the visit, so they are the day's own lateness.
    expect(fit.warning).toMatch(/would already arrive/);
    expect((fit.warning.match(/would already arrive/g) || []).length).toBeLessThanOrEqual(2);
  });

  test('the tightest later stop for an arrival_margin answer (staff route insertion)', () => {
    process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
    const fit = run([stop('B', '10:00', 60)], candidate('08:00', 190), { detail: true, durationMinutes: 190 });
    expect(fit.reason).toBe('arrival_margin');
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 2 (10 AM–12 PM window) would arrive 11:50 AM, only 10 min before its window closes. Choose another window.`);
    expect(fit.diagnostics.placement).toBe('move');
  });

  test('a placement that fits is untouched', () => {
    const fit = run([stop('A', '09:00', 60)], candidate('13:00', 60), { detail: true });
    expect(fit.feasible).toBe(true);
    expect(fit).not.toHaveProperty('warning');
  });

  test('without a staff save asking for detail the sentence stays generic even with the gate on', () => {
    const fit = run([stop('A', '09:00', 120), stop('B', '10:30', 60)], candidate('10:00', 60));
    expect(fit.warning).toBe(GENERIC);
    expect(fit).not.toHaveProperty('diagnostics');
  });

  test('no customer name, address or phone in any sentence, for any caller', () => {
    const sentences = [
      LATE_CASE().warning,
      run([], candidate('08:00', 60), { detail: true, departureMin: 11 * 60 }).warning,
      run([stop('A', '08:00', 240), stop('B', '08:30', 60)], candidate('15:00', 60), { detail: true }).warning,
      run([stop('A', '08:00', 60, { lat: null })], stop('T', '10:00', 60), { detail: true }).warning,
      run([], stop('T', '08:00', 60, { lat: null }), { detail: true }).warning,
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(NAMES);
      expect(sentence).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);
    }
  });
});

describe('gate on: route_unverified names the cause and the stop', () => {
  beforeEach(() => { process.env.GATE_ROUTE_WARNING_DETAIL = 'true'; });

  test('the Oct 30 case: a stop with no map pin and no route number is named', () => {
    const fit = run([], stop('T', '08:00', 60, { lat: null, lng: null }), { detail: true }, { prospective: false });
    expect(fit).toMatchObject({ feasible: false, reason: 'route_unverified' });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) has no map pin. Fix the address pin to check the route.`);
    expect(fit.diagnostics).toEqual({ cause: 'no_pin' });
  });

  test('another stop on the day has no pin: that stop is named, not the saved visit', () => {
    const fit = run([stop('A', '08:00', 60, { lat: null }), stop('C', '12:00', 60)], stop('T', '10:00', 60), { detail: true }, { prospective: false });
    expect(fit.reason).toBe('route_unverified');
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) has no map pin. Fix the address pin to check the route.`);
  });

  test('several stops with no pin: each by number, capped at three and a count', () => {
    const rows = ['08:00', '09:00', '10:00', '11:00', '12:00'].map((start, i) => stop(`P${i}`, start, 30, { lat: null }));
    const fit = run(rows, stop('T', '15:00', 60), { detail: true }, { prospective: false });
    expect(fit.warning).toContain('Stop 1 (8–10 AM window) has no map pin.');
    expect(fit.warning).toContain('Stop 3 (10 AM–12 PM window) has no map pin.');
    expect(fit.warning).toContain('2 more stops also have no map pin.');
    expect(fit.warning).not.toContain('Stop 4');
  });

  test('no technician', () => {
    const fit = run([], stop('T', '08:00', 60, { technician_id: null }), { detail: true }, { prospective: false });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) has no technician, so its route cannot be checked.`);
  });

  test('a new visit with no pin is not numbered', () => {
    const fit = run([], stop('__candidate__', '08:00', 60, { lat: null }), { detail: true });
    expect(fit.warning).toBe(`Route on ${DATE}: This new visit (8–10 AM window) has no map pin. Fix the address pin to check the route.`);
  });

  test('a visit that shares its stop with another service', () => {
    const fit = run([], stop('T', '08:00', 60), { detail: true }, { prospective: false, grouped: true });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) is booked with another service at the same stop, so its route cannot be checked.`);
  });

  test('a stop under way today that the check cannot continue from', () => {
    const today = new Date(`${DATE}T10:00:00-05:00`);
    const rows = [stop('U', '08:00', 60, { status: 'on_site' })];
    const fit = run(rows, stop('T', '13:00', 60), { detail: true }, { prospective: false, now: today });
    expect(fit.reason).toBe('route_unverified');
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) is under way and its live position is not available, so the rest of the day cannot be checked.`);
    expect(fit.diagnostics.cause).toBe('under_way');
  });

  test('a completed stop with no finish time', () => {
    const today = new Date(`${DATE}T10:00:00-05:00`);
    const rows = [stop('D', '08:00', 60, { status: 'completed' })];
    const fit = run(rows, stop('T', '13:00', 60), { detail: true }, { prospective: false, now: today });
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 AM window) is marked completed with no finish time, so the route cannot be checked.`);
  });

  test('outside the shift hours (capacity mode)', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const fit = run([], stop('T', '20:00', 60), { detail: true, windowStart: '20:00', windowEnd: '21:00' }, { prospective: false });
    expect(fit.reason).toBe('route_unverified');
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 1 (8–10 PM window) starts outside the technician's shift hours, so its route cannot be checked.`);
  });
});
