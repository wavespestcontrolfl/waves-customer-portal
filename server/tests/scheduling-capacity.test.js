jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluateArrivalPlacement, groupRouteStops, routeFingerprint } = require('../services/scheduling/arrival-route');
const { simulateArrivalRoute, effectiveWindowRange } = require('../services/route-reorder-window-fit');
const { assertAdminAppointmentWindow } = require('../services/scheduling/window-rules');

const date = '2027-01-15';
const now = new Date('2027-01-01T12:00:00Z');
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const stop = (id, start, duration, extra = {}) => ({ id, scheduled_date: date, technician_id: 'tech',
  lat: 27.44, lng: -82.4, status: 'confirmed', window_start: clock(start), window_end: clock(start + duration),
  estimated_duration_minutes: duration, service_type: 'Pest Control', ...extra });
const travel = (minutes = 0) => ({ lookup: () => ({ minutes, source: 'google_traffic', reason: null }) });
const context = (rows = [], extra = {}) => ({ date, now, rows, prospective: true, target: stop('__candidate__', 960, 30), travel: travel(), ...extra });
const options = (start = 960, duration = 30) => ({ windowStart: clock(start), windowEnd: clock(start + duration), durationMinutes: duration });

beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test.each([15, 20, 30, 40, 90])('keeps a %i-minute allowance without rounding it into a larger block', duration => {
  const fit = evaluateArrivalPlacement(context(), options(600, duration));
  expect(fit.feasible).toBe(true);
  const arrival = fit.arrivals.find(row => row.id === '__candidate__');
  expect(arrival).toEqual({ id: '__candidate__', arrival: '10:00', departure: clock(600 + duration) });
});

test('the complete route may finish exactly at 18:00, including its final return', () => {
  // Existing work holds the route until 17:00. The customer sees a 16–18
  // arrival promise; 40 minutes on site + the 20-minute return use the rest.
  const rows = [stop('existing', 840, 160, { route_order: 1 })];
  const input = context(rows, { travel: travel(20) });
  const fit = evaluateArrivalPlacement(input, options(960, 40));
  expect(fit.feasible).toBe(true);
  expect(fit.finishMinute).toBe(1080);
  expect(fit.estimatedArrival).toBe('17:00');
  expect(evaluateArrivalPlacement(input, options(960, 41)).feasible).toBe(false);
});

test('explicit departure and return limits remain authoritative for capacity measurements', () => {
  const input = context([], { travel: travel(20) });
  expect(evaluateArrivalPlacement(input, { ...options(600, 30), departureMin: 480, returnByMin: 650 }))
    .toMatchObject({ feasible: true, returnMinuteBeforeBreaks: 650, finishMinute: 650 });
  expect(evaluateArrivalPlacement(input, { ...options(600, 30), returnByMin: 649 }))
    .toMatchObject({ feasible: false, reason: 'return_time' });
  expect(evaluateArrivalPlacement(input, { ...options(600, 30), departureMin: 721 }).feasible).toBe(false);
  expect(evaluateArrivalPlacement(input, { ...options(600, 30), dayEndMin: 649 }).feasible).toBe(false);
});

test.each([[420, 30], [1020, 30], [960, 121]])('new arrival/work windows stay within 08–18: %j', (start, duration) => {
  expect(() => assertAdminAppointmentWindow({ windowStart: clock(start), durationMinutes: duration })).toThrow();
  expect(evaluateArrivalPlacement(context(), options(start, duration)).feasible).toBe(false);
});

test('finds an insertion without changing the existing relative stop order', () => {
  const rows = [stop('early', 480, 60, { route_order: 1 }), stop('late', 720, 60, { route_order: 2 })];
  const input = context(rows);
  const before = JSON.stringify(input.rows);
  const fit = evaluateArrivalPlacement(input, options(600, 30));
  expect(fit.feasible).toBe(true);
  expect(fit.routeOrder).toEqual(['early', '__candidate__', 'late']);
  expect(JSON.stringify(input.rows)).toBe(before);
});

test('complete visits sum member work while sharing one arrival anchor', () => {
  const members = [stop('pest', 600, 30, { visit_id: 'visit', route_order: 1 }), stop('lawn', 600, 40, { visit_id: 'visit', route_order: 2, service_type: 'Lawn Care' })];
  const grouped = groupRouteStops(members);
  expect(grouped).toHaveLength(1);
  expect(grouped[0].estimated_duration_minutes).toBe(70);
  expect(grouped[0].arrivalRange).toEqual({ startMin: 600, endMin: 720 });
  expect(groupRouteStops([members[0], { ...members[1], lat: 27.5 }])).toBeNull();
});

test('existing blocked time interrupts work/travel and invalidates a changed route proof', () => {
  const optimizer = { HQ: { lat: 27, lng: -82 }, haversine: () => 0, fallbackLegMetrics: () => ({ minutes: 0 }) };
  const result = simulateArrivalRoute(optimizer, effectiveWindowRange, [stop('job', 600, 40)], {
    blockedIntervals: [{ startMin: 615, endMin: 660 }], dayEndMin: 1080, includeReturnInFinish: true,
  });
  expect(result.arrivals[0]).toEqual({ id: 'job', arrivalMin: 660, departureMin: 700 });
  const input = context([], { blocks: [{ id: 'blocked', start_time: '12:00', end_time: '13:00' }] });
  const fingerprint = routeFingerprint(input);
  input.blocks[0].end_time = '14:00';
  expect(routeFingerprint(input)).not.toBe(fingerprint);
});

test('unknown coordinates, active work and unassigned blockers cannot create capacity', () => {
  expect(evaluateArrivalPlacement(context([stop('missing', 540, 30, { lat: null })]), options()).feasible).toBe(false);
  expect(evaluateArrivalPlacement(context([stop('unassigned', 480, 600, { technician_id: null })]), options()).feasible).toBe(false);
  const live = context([stop('active', 480, 60, { status: 'on_site' })], { now: new Date('2027-01-15T14:00:00Z') });
  expect(evaluateArrivalPlacement(live, options()).reason).toBe('route_unverified');
});
