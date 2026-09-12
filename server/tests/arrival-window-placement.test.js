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

// ── Codex #4435 round 3 P1 ───────────────────────────────────────────────
// The co-visit merge charges a chain the SUM of its members' real estimates,
// floored by the longest window-derived duration. The target is normalized
// (its estimate replaced by its window span) before the simulation runs, so
// its RAW estimate has to be captured first — otherwise a 20-minute target in
// a 60-minute span beside a 50-minute sibling is modeled as 60 + 50 = 110
// instead of max(60, 20 + 50) = 70, and a valid save is rejected.
test('a co-visit target contributes its real estimate, not its normalized window span', () => {
  const sameProperty = (id, over = {}) => stop(id, '09:00', 27.545, {
    customer_id: 'cust_1', service_address_line1: '100 Main St',
    customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, ...over,
  });
  // Sibling already on the board: same customer, same 09:00-10:00 promise,
  // same pin, 50 real minutes. Target: 20 real minutes in the same slot.
  const sibling = sameProperty('sibling', { estimated_duration_minutes: 50, route_order: 1 });
  const ctx = {
    date: DATE, now: new Date(), grouped: false,
    target: sameProperty('target', { estimated_duration_minutes: 20 }),
    rows: [sibling],
  };
  // 60 is what find-time-hints actually passes — the selected WINDOW SPAN,
  // not the job's real length. Treating that span as work is the bug.
  const fit = evaluateArrivalPlacement(ctx, { windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60 });
  const target20 = fit.arrivals.find((s) => s.id === 'target');
  const sib = fit.arrivals.find((s) => s.id === 'sibling');
  expect(fit.feasible).toBe(true);
  // One physical stop: both rows arrive together at 09:00 and the pair leaves
  // after max(60-minute span, 50 + 20 real minutes) = 70 minutes — 10:10, not
  // the 11:50 two normalized 60-minute spans plus a 50-minute sibling give.
  expect(target20.arrival).toBe(sib.arrival);
  expect(target20.arrival).toBe('09:00');
  // The chain's total shows on its last member: 09:00 + max(60, 50 + 20).
  // Taking the target's estimate AFTER its span normalization — or reading
  // the 60-minute span argument as work — makes it 50 + 60 = 110 and pushes
  // this to 10:50.
  expect(target20.departure).toBe('10:10');
});

// Codex #4435 round 4 P1: a grouped (memberIds) row already carries its
// members' ADDITIVE work as its duration. Treating it as having no real
// estimate let a co-visit merge charge max(group, target) instead of their
// sum, certifying a placement that does not fit.
test('a grouped allocation contributes its summed work to a co-visit chain', () => {
  const sameProperty = (id, over = {}) => stop(id, '09:00', 27.545, {
    customer_id: 'cust_1', service_address_line1: '100 Main St',
    customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205',
    visit_id: null, ...over,
  });
  const grouped = sameProperty('allocation', {
    memberIds: ['m1', 'm2'], estimated_duration_minutes: 30, route_order: 1,
  });
  const ctx = {
    date: DATE, now: new Date(), grouped: false,
    target: sameProperty('target', { estimated_duration_minutes: 45 }),
    rows: [grouped],
  };
  const fit = evaluateArrivalPlacement(ctx, { windowStart: '09:00', windowEnd: '10:00', durationMinutes: 45 });
  const target = fit.arrivals.find((s) => s.id === 'target');
  expect(fit.feasible).toBe(true);
  // 09:00 + max(60-minute span, 30 + 45) = 10:15, not the 10:00 that
  // dropping the group's own 30 minutes would give.
  expect(target.departure).toBe('10:15');
});
