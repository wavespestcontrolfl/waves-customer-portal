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
  milesToDriveMinutes: () => 15,
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

  // Codex pre-push P1: "without this visit" quotes the day WITHOUT the visit. The visit inserted ahead of B
  // pushes B from 12:40 PM (160 min late) to 2 PM (240 min late); the sentence must say 12:40 PM, 160.
  test('"without this visit" uses the baseline arrival, not the candidate route\'s (audit case)', () => {
    const rows = [stop('A', '08:00', 240, { route_order: 1 }), stop('B', '08:00', 60, { route_order: 3 })];
    const saved = stop('T', '12:00', 60, { route_order: 2 });
    const fit = run(rows, saved, { detail: true }, { prospective: false });
    expect(fit.reason).toBe('arrival_window');
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 3 (8–10 AM window) would already arrive 12:40 PM, 160 min late without this visit.`);
    expect(fit.warning).not.toMatch(/2 PM|240/);
    expect(fit.diagnostics.lateStopIds).toEqual(['B']);
  });

  test('a stop the visit makes late quotes the route WITH the visit (its time is the candidate\'s)', () => {
    // Without T: A then B, B on time (arrives 12:20+20... B window 12:00 so fine). With T ahead of B, B is late.
    const rows = [stop('A', '08:00', 240, { route_order: 1 }), stop('B', '12:30', 60, { route_order: 3 })];
    const saved = stop('T', '12:00', 120, { route_order: 2 });
    const fit = run(rows, saved, { detail: true }, { prospective: false });
    // Baseline: B arrives 12:40 PM, inside its 12:30-2:30 window. With T ahead (12:40-2:40) B arrives 3 PM.
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 3 (12:30–2:30 PM window) would arrive 3 PM, 30 min late.`);
    expect(fit.warning).not.toMatch(/without this visit/);
  });

  test('day_overcommitted (capacity) names the stop already late, with its time from the day as it stands', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const rows = [stop('A', '08:00', 240, { route_order: 1 }), stop('B', '08:00', 60, { route_order: 2 })];
    const fit = run(rows, candidate('15:00', 60), { detail: true });
    expect(fit.reason).toBe('day_overcommitted');
    expect(fit.warning).toMatch(/^Route on 2027-03-01: Stop 2 \(8–10 AM window\) would already arrive \d+(:\d\d)? PM, \d+ min late without this visit\.$/);
    // The day without the visit: A 8:20-12:20, B arrives 12:40 (160 min past its 10 AM close).
    expect(fit.warning).toContain('12:40 PM, 160 min late');
  });

  // Codex pre-push P1: the stop under way is not in the simulated order, but it keeps its number, so every
  // later stop is one higher. Today's route, picker road check on (fromActiveStop), the stop continued from.
  // Codex pre-push P1: capacity mode collapses a shared stop's rows into one simulated entry, but the save
  // writes a route number to EACH member, so every stop after a group is numbered past all its members.
  describe('numbering behind a shared stop (capacity mode)', () => {
    const group = (id, order) => stop(id, '08:00', 60, { visit_id: 'V1', route_order: order });
    const lateCase = (extraRows = [], ctx = {}) => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      const rows = [group('A1', 1), group('A2', 2), stop('B', '08:00', 60, { route_order: 3 }), ...extraRows];
      return run(rows, candidate('15:00', 60), { detail: true }, ctx);
    };

    test('A1/A2 grouped as 1/2: the late stop B is "Stop 3"', () => {
      const fit = lateCase();
      expect(fit.reason).toBe('day_overcommitted');
      expect(fit.warning).toMatch(/^Route on 2027-03-01: Stop 3 \(8–10 AM window\) would already arrive /);
    });

    test('grouped plus a completed stop ahead: numbered behind all of them', () => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      const done = stop('D', '07:00', 30, { status: 'completed', route_order: 1, actual_end_time: `${DATE}T07:40:00-05:00` });
      const rows = [done, group('A1', 2), group('A2', 3), stop('B', '08:00', 60, { route_order: 4 })];
      const fit = run(rows, candidate('15:00', 60), { detail: true }, { now: new Date(`${DATE}T06:00:00-05:00`) });
      expect(fit.warning).toMatch(/Stop 4 \(8–10 AM window\) would already arrive /);
    });

    test('grouped behind a stop under way: numbered behind it and every member', () => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      const rows = [stop('U', '08:00', 30, { status: 'on_site', route_order: 1 }), group('A1', 2), group('A2', 3), stop('B', '08:00', 60, { route_order: 4 })];
      const fit = run(rows, candidate('15:00', 60), { detail: true },
        { now: new Date(`${DATE}T10:00:00-05:00`), activeStop: { id: 'U', arrived_at: `${DATE}T09:00:00-05:00` } });
      expect(fit.reason).toBe('day_overcommitted');
      // U is 1, the group is 2 and 3 (named by its first member), B is 4.
      expect(fit.warning).toContain('Stop 4 (8–10 AM window) would already arrive 12:40 PM, 160 min late');
      expect(fit.warning).toContain('Stop 2 (8–10 AM window) would already arrive 10:20 AM, 20 min late');
    });

    test('ungrouped stops are numbered as before', () => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      const rows = [stop('A1', '08:00', 60, { route_order: 1 }), stop('A2', '08:00', 60, { route_order: 2 }), stop('B', '08:00', 60, { route_order: 3 })];
      const fit = run(rows, candidate('15:00', 60), { detail: true });
      expect(fit.reason).toBe('day_overcommitted');
      expect(fit.warning).toContain('Stop 3 (8–10 AM window) would already arrive 11 AM, 60 min late');
    });
  });

  describe('numbering with a stop under way', () => {
    const NOW = new Date(`${DATE}T10:00:00-05:00`);
    const live = (status, stamps) => ({ prospective: false, now: NOW, activeStop: { id: 'U', ...stamps } });
    const under = (status) => stop('U', '08:00', 60, { status, route_order: 1 });

    test('on site: the saved visit at route_order 2 is "Stop 2", not "Stop 1"', () => {
      const fit = run([under('on_site')], stop('T', '08:00', 60, { route_order: 2 }), { detail: true },
        live('on_site', { arrived_at: `${DATE}T08:30:00-05:00` }));
      expect(fit.reason).toBe('arrival_window');
      expect(fit.warning).toBe(`Route on ${DATE}: Stop 2 (8–10 AM window) is this visit and would arrive 10:20 AM, 20 min late, so it cannot keep its own window.`);
    });

    test('en route: the same numbering', () => {
      const fit = run([under('en_route')], stop('T', '08:00', 60, { route_order: 2 }), { detail: true },
        live('en_route', { en_route_at: `${DATE}T09:50:00-05:00` }));
      expect(fit.reason).toBe('arrival_window');
      expect(fit.warning).toMatch(/^Route on 2027-03-01: Stop 2 \(8–10 AM window\) is this visit and would arrive/);
    });

    test('a stop made late after the active stop and a completed one is numbered behind both', () => {
      const done = stop('D', '07:00', 30, { status: 'completed', route_order: 1, actual_end_time: `${DATE}T07:40:00-05:00` });
      const rows = [done, stop('U', '08:00', 60, { status: 'on_site', route_order: 2 }), stop('B', '10:00', 60, { route_order: 4 })];
      const fit = run(rows, stop('T', '10:00', 120, { route_order: 3 }), { detail: true },
        live('on_site', { arrived_at: `${DATE}T08:30:00-05:00` }));
      expect(fit.reason).toBe('arrival_window');
      expect(fit.warning).toMatch(/^Route on 2027-03-01: Stop 4 \(10 AM–12 PM window\) would arrive/);
    });

    test('the tight later stop is numbered the same way', () => {
      process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
      const fit = run([stop('U', '07:00', 30, { status: 'on_site', route_order: 1 }), stop('B', '10:00', 60, { route_order: 2 })],
        candidate('08:00', 210), { detail: true, durationMinutes: 210 }, { now: new Date(`${DATE}T07:00:00-05:00`), activeStop: { id: 'U', arrived_at: `${DATE}T06:50:00-05:00` } });
      expect(fit.reason).toBe('arrival_margin');
      expect(fit.warning).toBe(`Route on ${DATE}: Stop 3 (10 AM–12 PM window) would arrive 11:50 AM, only 10 min before its window closes. Choose another window.`);
    });

    test('an unverified cause counts the stop under way too: the pinless stop behind it is "Stop 2"', () => {
      const rows = [under('on_site'), stop('P', '10:00', 60, { lat: null, route_order: 2 })];
      const fit = run(rows, stop('T', '13:00', 60, { route_order: 3 }), { detail: true },
        live('on_site', { arrived_at: `${DATE}T08:30:00-05:00` }));
      expect(fit.reason).toBe('route_unverified');
      expect(fit.warning).toBe(`Route on ${DATE}: Stop 2 (10 AM–12 PM window) has no map pin. Fix the address pin to check the route.`);
    });

    test('no stop under way: numbering is unchanged', () => {
      const fit = run([], stop('T', '08:00', 60, { route_order: 1 }), { detail: true, departureMin: 11 * 60 }, { prospective: false });
      expect(fit.warning).toContain('Stop 1 (8–10 AM window) is this visit');
    });
  });

  // Codex round 1 P2: a stop is "already late without this visit" only when EVERY baseline leaves it late.
  // Stored order A (10 AM) then B (8 AM) is stale; the clock-order baseline keeps both promises, so B is not
  // late without the visit and must not be quoted from the broken stored order.
  test('a stale stored order does not make a stop "already late" when the clock order keeps it on time', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const rows = [stop('A', '10:00', 60, { route_order: 1 }), stop('B', '08:00', 60, { route_order: 2 })];
    const fit = run(rows, candidate('08:00', 140), { detail: true, durationMinutes: 140 });
    expect(fit.reason).toBe('arrival_window');
    expect(fit.warning).not.toMatch(/without this visit/);
    expect(fit.warning).not.toMatch(/already/);
    // A (10 AM) is on time in the clock-order baseline; the visit's placement is what makes it late.
    expect(fit.warning).toBe(`Route on ${DATE}: Stop 3 (10 AM–12 PM window) would arrive 12:20 PM, 20 min late.`);
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
