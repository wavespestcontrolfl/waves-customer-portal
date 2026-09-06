jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { simulateArrivalRoute, effectiveWindowRange } = require('../services/route-reorder-window-fit');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const RouteOptimizer = require('../services/route-optimizer');

const DATE = etDateString(addETDays(new Date(), 10));
const originalGate = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeAll(() => { process.env.GATE_DRIVE_TIME_CALIBRATION = 'true'; });
afterAll(() => {
  if (originalGate === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = originalGate;
});

// Synthetic route: two neighbouring northern properties, one southern stop.
// Real calibrated driving model; no customer records or external API calls.
const stop = (id, windowStart, lat, overrides = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z', ...overrides,
});
const northern = () => stop('northern', '08:00', 27.55);
const southern = () => stop('southern', '10:00', 27.45);
const target = () => stop('target', '09:00', 27.545);
const context = (overrides = {}) => ({
  date: DATE, now: new Date(), target: target(), rows: [northern(), southern()], grouped: false, ...overrides,
});
const placement = (start = '09:00', duration = 60) => ({
  windowStart: start, windowEnd: `${String(Number(start.slice(0, 2)) + duration / 60).padStart(2, '0')}:00`, durationMinutes: duration,
});

test('keeps neighbouring properties together and still arrives at the southern stop inside its two-hour promise', () => {
  const fit = evaluateArrivalPlacement(context(), placement());
  expect(fit.feasible).toBe(true);
  expect(fit.arrivals.map(s => s.id)).toEqual(['northern', 'target', 'southern']);
  const south = fit.arrivals.find(s => s.id === 'southern');
  expect(south.arrival > '10:00').toBe(true);
  expect(south.arrival < '12:00').toBe(true);
  const backtracking = evaluateArrivalPlacement(context(), placement('12:00'));
  expect(backtracking.feasible).toBe(true);
  expect(fit.driveMinutes).toBeLessThan(backtracking.driveMinutes);
});

test('does not require work to finish before the arrival window closes', () => {
  const optimizer = { HQ: { lat: 1, lng: 1 }, haversine: () => 0, fallbackLegMetrics: () => ({ minutes: 0 }) };
  const result = simulateArrivalRoute(optimizer, effectiveWindowRange, [stop('late-arrival', '10:00', 1)], { startMin: 11 * 60 + 59 });
  expect(result.arrivals[0]).toEqual({ id: 'late-arrival', arrivalMin: 719, departureMin: 779 });
  expect(simulateArrivalRoute(optimizer, effectiveWindowRange, [stop('missed', '10:00', 1)], { startMin: 12 * 60 + 1 })).toBeNull();
});

test('a longer service that pushes the next arrival beyond its promise is not advertised as fitting', () => {
  expect(evaluateArrivalPlacement(context(), placement('09:00', 180)).feasible).toBe(false);
});

test('checks the later route, not just the two immediate neighbours', () => {
  const rows = [northern(), southern(), stop('last', '11:00', 27.6, { estimated_duration_minutes: 180 })];
  expect(evaluateArrivalPlacement(context({ rows }), placement('09:00', 120)).feasible).toBe(false);
});

test.each([
  { technician_id: null },
  { technician_id: 'another-tech' },
  { technician_id: 'tech', reservation_expires_at: new Date(Date.now() + 60_000) },
])('unassigned work, other-tech work and live holds remain occupied: %j', extra => {
  const blocked = stop('reserved', '09:00', 27.54, { window_end: '12:00', ...extra });
  const fit = evaluateArrivalPlacement(context({ rows: [northern(), southern(), blocked] }), placement());
  expect(fit.feasible).toBe(false);
});

test('unknown locations and partial visit groups never receive a verified route fit', () => {
  expect(evaluateArrivalPlacement(context({ rows: [{ ...northern(), lat: null }] }), placement()).reason).toBe('route_unverified');
  expect(evaluateArrivalPlacement(context({ grouped: true }), placement()).reason).toBe('route_unverified');
});

test('preserves the explicit running order instead of promising a different order than the board will show', () => {
  const fit = evaluateArrivalPlacement(context({ rows: [northern(), southern()].map((s, i) => ({ ...s, route_order: i + 1 })) }), placement());
  // A new unranked row sorts after the ordered route. That old order misses
  // this northern promise, so the picker cannot call it a good 9 AM fit.
  expect(fit.feasible).toBe(false);
});

test('uses full work duration and leaves every promised/stored window unchanged', () => {
  const input = context();
  const before = JSON.stringify(input);
  const fit = evaluateArrivalPlacement(input, placement());
  expect(fit.feasible).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  const row = fit.arrivals.find(s => s.id === 'target');
  expect(Number(row.departure.slice(0, 2)) - Number(row.arrival.slice(0, 2))).toBe(1);
});

test('current-day checks do not pretend an in-progress technician is free', () => {
  const now = new Date();
  const date = etDateString(now);
  const active = { ...northern(), status: 'on_site', scheduled_date: date };
  expect(evaluateArrivalPlacement(context({ date, now, rows: [active] }), placement()).reason).toBe('route_unverified');
});

test('shared reorder simulation and the picker agree on the same complete route', () => {
  const fit = evaluateArrivalPlacement(context(), placement());
  const simulation = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [northern(), target(), southern()]);
  expect(fit.driveMinutes).toBe(simulation.travelMin);
});


test.each(['', 0, '0', 'invalid'])('invalid coordinates (%j) do not certify a zero-minute drive', lat => {
  expect(evaluateArrivalPlacement(context({ target: { ...target(), lat } }), placement()).reason).toBe('route_unverified');
});

test('a reservation during the drive to a stop still blocks the proposed route', () => {
  const fit = evaluateArrivalPlacement(context(), placement());
  const arrival = fit.arrivals.find(row => row.id === 'target').arrival;
  const previousEnd = fit.arrivals.find(row => row.id === 'northern').departure;
  expect(previousEnd < arrival).toBe(true);
  const held = stop('held-during-drive', previousEnd, 27.54, {
    window_end: arrival, estimated_duration_minutes: 1, technician_id: null,
  });
  expect(evaluateArrivalPlacement(context({ rows: [northern(), southern(), held] }), placement()).feasible).toBe(false);
});

test('the last completed location anchors the remaining same-day route', () => {
  const now = parseETDateTime(`${DATE}T10:30:00`);
  const done = { ...northern(), status: 'completed', actual_end_time: now };
  const candidate = { ...target(), lat: done.lat, lng: done.lng };
  const input = context({ now, target: candidate, rows: [done] });
  const fit = evaluateArrivalPlacement(input, placement('10:00'));
  const simulation = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [
    { ...candidate, window_start: '10:00', window_end: '11:00' },
  ], { startMin: 630, origin: done });
  expect(fit.feasible).toBe(true);
  expect(fit.estimatedArrival).toBe(`${Math.floor(simulation.arrivals[0].arrivalMin / 60)}:${String(simulation.arrivals[0].arrivalMin % 60).padStart(2, '0')}`);
  expect(evaluateArrivalPlacement(context({ now, rows: [{ ...done, actual_end_time: null }] }), placement('10:00')).reason).toBe('route_unverified');
});


test('a legitimate early staff promise starts the simulated route before 8 AM', () => {
  const early = { ...northern(), window_start: '06:00', window_end: '07:00' };
  const fit = evaluateArrivalPlacement(context({ rows: [early, southern()] }), placement());
  expect(fit.feasible).toBe(true);
  expect(fit.arrivals.find(row => row.id === early.id).arrival < '08:00').toBe(true);
});

test.each(['check_out_time', 'completed_at'])('completed stops can anchor the route using %s', field => {
  const now = parseETDateTime(`${DATE}T10:30:00`);
  const done = { ...northern(), status: 'completed', [field]: now };
  const candidate = { ...target(), lat: done.lat, lng: done.lng };
  const fit = evaluateArrivalPlacement(context({ now, target: candidate, rows: [done] }), placement('10:00'));
  expect(fit.feasible).toBe(true);
  expect(fit.arrivals.map(row => row.id)).toEqual(['target']);
});

test('an older completed stop needs no coordinates when the latest origin is known', () => {
  const now = parseETDateTime(`${DATE}T10:30:00`);
  const older = { ...northern(), id: 'older', status: 'completed', lat: null, lng: null,
    actual_end_time: parseETDateTime(`${DATE}T09:00:00`) };
  const latest = { ...southern(), status: 'completed', actual_end_time: now };
  const candidate = { ...target(), lat: latest.lat, lng: latest.lng };
  const fit = evaluateArrivalPlacement(context({ now, target: candidate, rows: [older, latest] }), placement('10:00'));
  expect(fit.feasible).toBe(true);
  expect(fit.arrivals.map(row => row.id)).toEqual(['target']);
  expect(evaluateArrivalPlacement(context({ now, target: candidate,
    rows: [older, { ...latest, lat: null, lng: null }],
  }), placement('10:00')).reason).toBe('route_unverified');
});

test.each([
  { estimated_duration_minutes: 180 },
  { estimated_duration_minutes: 60, window_end: '12:00' },
])('a short requested block cannot erase the existing service work duration: %j', existingWork => {
  const input = context({ target: { ...target(), ...existingWork } });
  expect(evaluateArrivalPlacement(input, placement('09:00', 60)).feasible).toBe(false);
});
