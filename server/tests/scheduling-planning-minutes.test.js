// Owner planning minutes (2026-09-25) and the capacity picker's stale-order
// fallback: the table itself, its gate, the placed-visit exemption, the
// clock-order rescue of a leftover stored order, and the day_overcommitted
// diagnosis.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { plannedWorkMinutes } = require('../services/scheduling/planning-minutes');
const { workDuration } = require('../services/route-reorder-window-fit');
const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { ROUTE_WRITE_GUARD_COLUMNS } = require('../services/route-reorder');

const date = '2027-01-15';
const now = new Date('2027-01-01T12:00:00Z');
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const stop = (id, start, duration, extra = {}) => ({ id, scheduled_date: date, technician_id: 'tech',
  lat: 27.44, lng: -82.4, status: 'confirmed', window_start: clock(start), window_end: clock(start + duration),
  estimated_duration_minutes: duration, service_type: 'Mosquito', ...extra });
const travel = { lookup: () => ({ minutes: 0, source: 'google_traffic', reason: null }) };
const context = rows => ({ date, now, rows, prospective: true, target: stop('__candidate__', 960, 30), travel });
const options = (start, duration) => ({ windowStart: clock(start), windowEnd: clock(start + duration), durationMinutes: duration });

beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

describe('planning minutes table', () => {
  const row = (service_type, extra = {}) => ({ service_type, window_start: '09:00', window_end: '10:00',
    estimated_duration_minutes: 60, ...extra });

  test.each([
    ['Quarterly Pest Control Service', {}, 25],
    ['Bi-Monthly Pest Control Service', {}, 25],
    ['Pest Control Service', { is_recurring: true }, 25],
    ['One-Time Pest Control', { is_recurring: true }, 45],
    ['Pest Control Service', {}, 45],
    ['Every 6 Weeks Lawn Care Service', {}, 20],
    ['Monthly Lawn Care Service', {}, 20],
    ['Quarterly Pest Control Service', { is_callback: true }, 15],
    ['Pest Re-Service', {}, 15],
    ['Lawn Assessment', {}, 30],
    ['Termite Inspection', {}, 30],
    ['Rodent Control', {}, 30],
    ['Termite Bait Station Service', {}, 30],
  ])('%s %o plans %i minutes', (name, extra, minutes) => {
    expect(plannedWorkMinutes(row(name, extra))).toBe(minutes);
    expect(workDuration(row(name, extra))).toBe(minutes);
  });

  test.each(['Tree & Shrub Care', 'Mosquito', 'Bed Bug Treatment', 'Lawn Care', 'Pest & Lawn Combo', null])(
    '%s keeps the legacy window/estimate rule', (name) => {
      expect(plannedWorkMinutes(row(name))).toBeNull();
      expect(workDuration(row(name))).toBe(60);
    });

  test('a deliberate long estimate is never planned shorter; a span-sized one is', () => {
    expect(plannedWorkMinutes(row('Quarterly Pest Control Service', { estimated_duration_minutes: 120 }))).toBe(120);
    expect(plannedWorkMinutes(row('Quarterly Pest Control Service',
      { window_start: '13:00', window_end: '16:00', estimated_duration_minutes: 180 }))).toBe(25);
  });

  test('gate off and the placed visit are not planned; a route group keeps its members\' sum', () => {
    const pest = row('Quarterly Pest Control Service');
    expect(plannedWorkMinutes({ ...pest, planning_exempt: true })).toBeNull();
    expect(plannedWorkMinutes({ ...pest, memberIds: ['a', 'b'], estimated_duration_minutes: 45 })).toBe(45);
    delete process.env.GATE_SCHEDULING_CAPACITY;
    expect(plannedWorkMinutes(pest)).toBeNull();
    expect(workDuration(pest)).toBe(60);
  });

  test('every planning input rides the route-write guard on both sides of the lock', () => {
    // A signature built from rows missing an input would plan them
    // differently and abort every nightly write as stale.
    expect(ROUTE_WRITE_GUARD_COLUMNS).toEqual(expect.arrayContaining(['service_type', 'is_recurring', 'is_callback',
      'estimated_duration_minutes', 'window_start', 'window_end']));
  });

  test('existing recurring stops open room a 60-minute charge would not', () => {
    // Two promises each at 09:00, 10:00 and 11:00. Charged 60 minutes apiece
    // the second 10:00 stop cannot arrive by 12:00; at the planned 25 the
    // morning finishes before noon and a 12:00 visit fits.
    const day = (service_type) => [9, 9, 10, 10, 11, 11].map((h, i) => stop(`s${i}`, h * 60, 60,
      { route_order: i + 1, service_type }));
    expect(evaluateArrivalPlacement(context(day('Mosquito')), options(12 * 60, 60)))
      .toMatchObject({ feasible: false, reason: 'day_overcommitted' });
    expect(evaluateArrivalPlacement(context(day('Quarterly Pest Control Service')), options(12 * 60, 60)).feasible)
      .toBe(true);
  });
});

describe('stale stored order', () => {
  test('a stored order that runs a 13:00 promise before a 09:00 one is rescued by clock order', () => {
    const rows = [
      stop('morning', 9 * 60, 60, { route_order: 2 }),
      stop('afternoon', 13 * 60, 60, { route_order: 1 }),
    ];
    const fit = evaluateArrivalPlacement(context(rows), options(16 * 60, 30));
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder).toEqual(['morning', 'afternoon', '__candidate__']);
    expect(fit.detourMinutes).toBeGreaterThanOrEqual(0);
  });

  test('an unnumbered stop also makes the day eligible for clock order', () => {
    const rows = [
      stop('afternoon', 13 * 60, 60, { route_order: 1 }),
      stop('morning', 9 * 60, 60, { route_order: null }),
    ];
    expect(evaluateArrivalPlacement(context(rows), options(16 * 60, 30)).routeOrder)
      .toEqual(['morning', 'afternoon', '__candidate__']);
  });

  test('a legacy time_window-only row is rescued into its REAL promised order, not left last by the board tiebreak', () => {
    // Both rows carry time_window only (no window_start), the pattern the
    // dispatch-board sort (currentOrder) always reads as unconstrained and
    // sorts last — so nulling route_order and re-running currentOrder (the
    // old clockOrder) reproduced the exact same inverted order it was
    // rescuing (Codex r1 P1). afternoon (route_order 1) before morning
    // (route_order 2) misses morning's own 08:00-12:00 promise once
    // afternoon's 60-minute job runs first; only sorting the fallback by the
    // REAL resolved window (effectiveWindowRange) rescues it.
    const legacy = (id, timeWindow, routeOrder) => ({ id, technician_id: 'tech', scheduled_date: date,
      lat: 27.44, lng: -82.4, status: 'confirmed', time_window: timeWindow, estimated_duration_minutes: 60,
      service_type: 'Mosquito', route_order: routeOrder, created_at: '2020-01-01T00:00:00Z' });
    const rows = [legacy('afternoon', 'afternoon', 1), legacy('morning', 'morning', 2)];
    const fit = evaluateArrivalPlacement(context(rows), options(16 * 60, 30));
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder).toEqual(['morning', 'afternoon', '__candidate__']);
  });
});

describe('day_overcommitted', () => {
  test('a day whose own stops cannot keep their promises says so', () => {
    // Two 09:00 promises (deadline 11:00) with 150 minutes of work each.
    const rows = [
      stop('first', 9 * 60, 60, { route_order: 1, estimated_duration_minutes: 150 }),
      stop('second', 9 * 60, 60, { route_order: 2, estimated_duration_minutes: 150 }),
    ];
    const fit = evaluateArrivalPlacement(context(rows), options(16 * 60, 30));
    expect(fit).toMatchObject({ feasible: false, reason: 'day_overcommitted' });
  });

  test('a visit that breaks an otherwise sound day stays arrival_window', () => {
    // 09:00 promise with 200 minutes of work: alone it is fine. A 10:00
    // promise either delays it past 11:00 or waits past its own 12:00.
    const rows = [stop('long', 9 * 60, 60, { route_order: 1, estimated_duration_minutes: 200 })];
    const fit = evaluateArrivalPlacement(context(rows), options(10 * 60, 120));
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });
});

describe('preserveCapacity (a version-2 hold accepted after a gate rollback)', () => {
  test('plannedWorkMinutes/workDuration honor a stamped preserveCapacity row even with the live gate off', () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const pest = { service_type: 'Quarterly Pest Control Service', window_start: '09:00', window_end: '10:00',
      estimated_duration_minutes: 60 };
    // The live gate alone still means legacy minutes...
    expect(plannedWorkMinutes(pest)).toBeNull();
    expect(workDuration(pest)).toBe(60);
    // ...but a row arrival-route.js stamped for a persisted preserveCapacity
    // path (a reservation_policy_version===2 hold committing while
    // GATE_SCHEDULING_CAPACITY is rolled back) keeps its owner minutes.
    expect(plannedWorkMinutes({ ...pest, preserveCapacity: true })).toBe(25);
    expect(workDuration({ ...pest, preserveCapacity: true })).toBe(25);
  });

  test('evaluateArrivalPlacement threads context.preserveCapacity onto every row, not just capacityEnabled()', () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    // Identical shape to "existing recurring stops open room a 60-minute
    // charge would not" above (six recurring-pest promises at 09/09/10/10/
    // 11/11), reached through context.preserveCapacity instead of the live
    // gate. Charged the legacy 60 minutes apiece — what plannedWorkMinutes
    // returned before it also honored preserveCapacity, even though
    // `capacity` (arrival-route.js) was already true via preserveCapacity —
    // the day cannot keep noon; planned at owner minutes (25 each) it can.
    const day = [9, 9, 10, 10, 11, 11].map((h, i) => stop(`s${i}`, h * 60, 60,
      { route_order: i + 1, service_type: 'Quarterly Pest Control Service' }));
    const fit = evaluateArrivalPlacement({ ...context(day), preserveCapacity: true }, options(12 * 60, 60));
    expect(fit.feasible).toBe(true);
  });
});
