/**
 * evaluateArrivalPlacement `explain: true` (customer route check): on an arrival_window
 * failure it says WHY — another stop made late, the new visit itself late, a day
 * already late without it, or a route past the day end. REAL evaluator and real
 * simulation on an in-memory route (no DB, no Google); only the drive model is fixed:
 * every leg is 20 minutes. Arrival promises are 2 hours from the window start.
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
const { filterOfferedSlots } = require('../services/scheduling/customer-route-check');

const DATE = '2027-03-01';
const hh = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const stop = (id, windowStart, durationMinutes, extra = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: hh(Number(windowStart.slice(0, 2)) * 60 + Number(windowStart.slice(3)) + durationMinutes),
  estimated_duration_minutes: durationMinutes, lat: 27.5, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z', ...extra,
});
// A new visit (the offered slot) placed at `windowStart` for `durationMinutes`.
const prospective = (windowStart, durationMinutes) => stop('__candidate__', windowStart, durationMinutes, { created_at: '2026-01-01T12:00:00Z' });
function context(rows, target) {
  return { date: DATE, now: new Date(`${DATE}T06:00:00-05:00`), target, rows, grouped: false, prospective: true, travel: undefined, blocks: [] };
}
const evaluate = (rows, windowStart, durationMinutes, extra = {}) => {
  const target = prospective(windowStart, durationMinutes);
  return evaluateArrivalPlacement(context(rows, target), {
    windowStart, windowEnd: hh(Number(windowStart.slice(0, 2)) * 60 + Number(windowStart.slice(3)) + durationMinutes), durationMinutes, ...extra,
  });
};

beforeEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

describe('explain: true on the real evaluator', () => {
  test('(1) the auditor repro: A 09:00 for 120, B 10:30 for 60, new 10:00 visit. Placing it after B leaves both customers on time, so nobody is newly late', () => {
    const rows = [stop('A', '09:00', 120), stop('B', '10:30', 60)];
    const fit = evaluate(rows, '10:00', 60, { explain: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    // Before A it makes A late, between A and B it makes B late, after B it makes only itself late.
    expect(fit.lateness).toEqual({ targetLate: true, newlyLateStopIds: [], baselineLateStopIds: [], dayEndExceeded: false });
  });

  test('every position of the day is tried, whatever capacity mode does: the same answer with capacity on', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const rows = [stop('A', '09:00', 120), stop('B', '10:30', 60)];
    const fit = evaluate(rows, '10:00', 60, { explain: true });
    expect(fit.lateness ? fit.lateness.newlyLateStopIds : []).toEqual([]);
  });

  test('the tried positions are the n+1 insertion points of the current order', () => {
    const optimizer = require('../services/route-optimizer');
    const rows = [stop('A', '09:00', 120), stop('B', '10:30', 60), stop('C', '13:00', 60)];
    const spy = jest.spyOn(optimizer, 'fallbackLegMetrics');
    evaluate(rows, '10:00', 60);
    const plain = spy.mock.calls.length;
    spy.mockClear();
    evaluate(rows, '10:00', 60, { explain: true });
    // (default calls) + baseline (3 legs + home) + 4 positions x 2 simulations each; only bounded growth
    expect(spy.mock.calls.length - plain).toBeGreaterThan(0);
    expect(spy.mock.calls.length - plain).toBeLessThan(200);
    spy.mockRestore();
  });

  test('(2) the new visit misses only its own window: nobody else is late', () => {
    // A runs 08:00-11:00; a new 08:00 visit queued behind it arrives 11:20, after its 10:00 limit.
    const rows = [stop('A', '08:00', 180)];
    const fit = evaluate(rows, '08:00', 60, { explain: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit.lateness).toEqual({ targetLate: true, newlyLateStopIds: [], baselineLateStopIds: [], dayEndExceeded: false });
  });

  test('(3) the day is already late before the new visit: that stop is baseline, not newly late', () => {
    // A takes four hours, so B (promised 08:30, arrive by 10:30) is late with or without the new 15:00 visit.
    const rows = [stop('A', '08:00', 240), stop('B', '08:30', 60)];
    const fit = evaluate(rows, '15:00', 60, { explain: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit.lateness.baselineLateStopIds).toEqual(['B']);
    expect(fit.lateness.newlyLateStopIds).toEqual([]);
    expect(fit.lateness.targetLate).toBe(false);
  });

  test('(4) the route runs past the day end: nobody is late', () => {
    const fit = evaluate([stop('A', '09:00', 60)], '19:00', 120, { explain: true });
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
    expect(fit.lateness).toEqual({ targetLate: false, newlyLateStopIds: [], baselineLateStopIds: [], dayEndExceeded: true });
  });

  test('a feasible placement carries no lateness', () => {
    const fit = evaluate([stop('A', '09:00', 60)], '13:00', 60, { explain: true });
    expect(fit.feasible).toBe(true);
    expect(fit).not.toHaveProperty('lateness');
  });
});

describe('the default path is unchanged', () => {
  const failing = [stop('A', '09:00', 120), stop('B', '10:30', 60)];

  test('without explain a failure is exactly the old result: same reason and warning, no lateness key', () => {
    const fit = evaluate(failing, '10:00', 60);
    expect(Object.keys(fit).sort()).toEqual(['feasible', 'reason', 'target', 'warning']);
    expect(fit).toMatchObject({
      feasible: false, reason: 'arrival_window',
      warning: `The route on ${DATE} cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.`,
    });
  });

  test('explain only adds lateness: everything else matches the default call, failing or feasible', () => {
    for (const [rows, start] of [[failing, '10:00'], [[stop('A', '09:00', 60)], '13:00']]) {
      const plain = evaluate(rows, start, 60);
      const explained = evaluate(rows, start, 60, { explain: true });
      const { lateness, ...rest } = explained;
      expect(rest).toEqual(plain);
      expect(lateness !== undefined).toBe(!plain.feasible);
    }
  });

  test('without explain the simulation runs exactly as before (no extra simulations)', () => {
    const optimizer = require('../services/route-optimizer');
    const calls = [];
    const original = optimizer.fallbackLegMetrics;
    optimizer.fallbackLegMetrics = (...args) => { calls.push(args); return original(...args); };
    try {
      evaluate(failing, '10:00', 60);
      const plainCalls = calls.length;
      calls.length = 0;
      evaluate(failing, '10:00', 60, { explain: true });
      expect(calls.length).toBeGreaterThan(plainCalls);
      expect(plainCalls).toBeGreaterThan(0);
    } finally {
      optimizer.fallbackLegMetrics = original;
    }
  });
});

describe('customer route check with the real evaluator', () => {
  const arrivalRoute = require('../services/scheduling/arrival-route');

  beforeEach(() => { process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true'; });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS; });

  // The slot is also the only one dated in the next 7 days, so the floor would hold it
  // whenever it is the only offer: add a second, safe slot on the same day to take the floor out.
  async function check(rows, startMin, durationMinutes) {
    jest.spyOn(arrivalRoute, 'loadArrivalRouteContext').mockImplementation(async ({ prospective: p }) => {
      const target = { id: '__candidate__', route_order: null, created_at: '2026-01-01T12:00:00Z', ...p, technician_id: 'tech', scheduled_date: DATE, lat: 27.5, lng: -82.4 };
      return context(rows, target);
    });
    const safe = { date: DATE, start_time: '16:00', technician_id: 'tech' };
    const probe = { date: DATE, start_time: hh(startMin), technician_id: 'tech' };
    return filterOfferedSlots({
      surface: 'book', mode: 'on', slots: [probe, safe], durationMinutes, today: DATE,
      target: { prospective: { lat: 27.5, lng: -82.4, estimated_duration_minutes: durationMinutes } },
    });
  }

  test('the auditor repro slot is kept (no position leaves another customer newly late)', async () => {
    const { slots, report } = await check([stop('A', '09:00', 120), stop('B', '10:30', 60)], 10 * 60, 60);
    expect(slots).toHaveLength(2);
    expect(report).toMatchObject({ removed: 0, targetLate: 1 });
  });

  // The new visit appended LAST delays nobody, so with every position tried a real route never
  // confirms newly late stops. The removal path itself is covered with a mocked diagnosis in
  // customer-route-check.test.js.
  test('crowded days never confirm newly late stops on the real evaluator', async () => {
    const days = [
      [stop('A', '08:00', 120), stop('B', '09:30', 120), stop('C', '11:00', 120), stop('D', '13:00', 60)],
      [stop('A', '09:00', 240), stop('B', '09:30', 60)],
      [stop('A', '10:00', 60)],
    ];
    for (const rows of days) {
      for (const startMin of [8 * 60, 9 * 60, 10 * 60, 11 * 60, 13 * 60]) {
        const fit = evaluate(rows, hh(startMin), 60, { explain: true });
        if (!fit.feasible && fit.reason === 'arrival_window') expect(fit.lateness.newlyLateStopIds).toEqual([]);
      }
    }
  });

  test('keeps a slot that only misses its own window and counts target_late', async () => {
    const { slots, report } = await check([stop('A', '08:00', 180)], 8 * 60, 60);
    expect(slots).toHaveLength(2);
    expect(report).toMatchObject({ removed: 0, targetLate: 1 });
  });

  test('keeps a slot on a day that was already late and counts baseline_late', async () => {
    const { slots, report } = await check([stop('A', '08:00', 240), stop('B', '08:30', 60)], 15 * 60, 60);
    expect(slots).toHaveLength(2);
    // both offered starts (the probe and the 16:00 companion) hit the same already-late day
    expect(report).toMatchObject({ removed: 0, baselineLate: 2 });
  });

  test('keeps a slot whose route runs past the day end and counts day_end', async () => {
    const { slots, report } = await check([stop('A', '09:00', 60)], 19 * 60, 120);
    expect(slots).toHaveLength(2);
    expect(report).toMatchObject({ removed: 0, dayEnd: 1 });
  });

  test('keeps the slot when the evaluator gives no diagnosis (fail open)', async () => {
    jest.spyOn(arrivalRoute, 'evaluateArrivalPlacement').mockReturnValue({ feasible: false, reason: 'arrival_window' });
    jest.spyOn(arrivalRoute, 'loadArrivalRouteContext').mockResolvedValue({ rows: [] });
    const slots = [{ date: DATE, start_time: '09:00', technician_id: 'tech' }, { date: DATE, start_time: '10:00', technician_id: 'tech' }];
    const out = await filterOfferedSlots({ surface: 'book', mode: 'on', slots, durationMinutes: 60, today: DATE,
      target: { prospective: { lat: 27.5, lng: -82.4 } } });
    expect(out.slots).toEqual(slots);
    expect(out.report.removed).toBe(0);
    expect(out.report.byReason.arrival_window_unexplained).toBe(2);
  });

  test('the summary line carries the new counts', async () => {
    const logger = require('../services/logger');
    logger.info.mockClear();
    const out = await check([stop('A', '08:00', 180)], 8 * 60, 60);
    expect(out.report.targetLate).toBe(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/kept_other=\d+ target_late=1 baseline_late=0 day_end=0 floor_kept=/);
  });
});
