/**
 * GATE_TECH_START_POINTS (owner 2026-10-22): a technician's day starts and
 * ends at their own start point (home, when set) instead of the office.
 *
 * What this locks down:
 *  1. Gate off: every answer is RouteOptimizer.HQ itself and the technician
 *     select gains no column, so routes are exactly today's.
 *  2. Gate on: a tech with both coordinates starts there; a tech with none,
 *     one, or a non-number coordinate starts at the office.
 *  3. The staff picker's open-gap search anchors the day at that point: an
 *     empty day's first offer is priced from home, not the office.
 *  4. The arrival-window simulator drives the van back to `end`, not HQ.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const RouteOptimizer = require('../services/route-optimizer');
const { techColumns, techStartPoint, loadTechStartPoint } = require('../services/scheduling/tech-start-point');
const { simulateArrivalRoute, effectiveWindowRange } = require('../services/route-reorder-window-fit');

const ENV = process.env.GATE_TECH_START_POINTS;
afterEach(() => {
  if (ENV === undefined) delete process.env.GATE_TECH_START_POINTS;
  else process.env.GATE_TECH_START_POINTS = ENV;
});

// Synthetic points: a "home" ~25 miles south of the office, a stop near it.
const HOME = { start_lat: '27.0998000', start_lng: '-82.4543000' };
const NEAR_HOME = { lat: 27.11, lng: -82.45 };

describe('techStartPoint', () => {
  test('gate off: always the office object, no extra columns', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    expect(techStartPoint(HOME)).toBe(RouteOptimizer.HQ);
    expect(techColumns(['id', 'name'])).toEqual(['id', 'name']);
    const conn = jest.fn();
    expect(await loadTechStartPoint(conn, 't1')).toBe(RouteOptimizer.HQ);
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: both coordinates = home; anything less = office', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    expect(techStartPoint(HOME)).toEqual({ lat: 27.0998, lng: -82.4543 });
    expect(techStartPoint({ start_lat: null, start_lng: null })).toBe(RouteOptimizer.HQ);
    expect(techStartPoint({ start_lat: '27.1', start_lng: null })).toBe(RouteOptimizer.HQ);
    expect(techStartPoint({ start_lat: 'x', start_lng: '-82.4' })).toBe(RouteOptimizer.HQ);
    expect(techStartPoint(null)).toBe(RouteOptimizer.HQ);
    expect(techColumns(['id', 'name'])).toEqual(['id', 'name', 'start_lat', 'start_lng']);
    const first = jest.fn(async () => HOME);
    const conn = jest.fn(() => ({ where: () => ({ first }) }));
    expect(await loadTechStartPoint(conn, 't1')).toEqual({ lat: 27.0998, lng: -82.4543 });
    expect(first).toHaveBeenCalledWith(['start_lat', 'start_lng']);
  });
});

describe('open-gap search anchors the day at the start point', () => {
  const { _internals: { candidatesForDay } } = require('../services/scheduling/find-time');
  const firstOffer = () => {
    const found = candidatesForDay('2035-01-02', { id: 't1', name: 'Tech One', ...HOME }, {
      services: [],
      geo: {
        newStop: { lat: NEAR_HOME.lat, lng: NEAR_HOME.lng }, dateFrom: '2035-01-02', stopBuffer: 0, candidateExpectedMinutes: 60,
        durationMinutes: 60, dayOpen: 8 * 60, earliestStartMin: 0, startFloorByDate: {}, todayEt: '2026-01-01', todayFloorMin: 0,
      },
      excludeSet: new Set(), wantsPackedEnds: false, wantsExpectedMinutesCredit: false,
      durationMinutes: 60, dayOpen: 8 * 60, dayClose: 17 * 60, slotStepMinutes: 60, everyStepStart: false,
    });
    return found.candidates[0];
  };

  test('an empty day near home costs far less driving from home than from the office', () => {
    delete process.env.GATE_TECH_START_POINTS;
    const office = firstOffer();
    process.env.GATE_TECH_START_POINTS = 'true';
    const home = firstOffer();
    expect(office).toBeTruthy();
    expect(home).toBeTruthy();
    expect(home.detour_minutes).toBeLessThan(office.detour_minutes);
  });
});

describe('simulateArrivalRoute end', () => {
  const stop = { id: 's1', lat: NEAR_HOME.lat, lng: NEAR_HOME.lng, window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 30 };
  test('default returns to the office; `end` returns to the given point', () => {
    const toOffice = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [stop], { origin: RouteOptimizer.HQ });
    const toHome = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [stop], { origin: RouteOptimizer.HQ, end: { lat: 27.0998, lng: -82.4543 } });
    expect(toOffice && toHome).toBeTruthy();
    expect(toHome.returnFinishMin).toBeLessThan(toOffice.returnFinishMin);
  });
});
