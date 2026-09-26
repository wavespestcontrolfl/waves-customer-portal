// Codex r1 P1 on the capacity-picker minutes PR: fit.detourMinutes used to
// subtract routeDriveMinutes' haversine FALLBACK model (never traffic-aware)
// from simulation.travelMin, which IS traffic-aware whenever context.travel
// is live. A congested existing leg then scored entirely against the
// candidate, manufacturing a detour that was really just the standing
// route's own congestion. The baseline must come from the SAME travel
// source and departures as the candidate simulation.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  // Only exercised if the fix's simulate-based baseline fails outright and
  // falls back to the model — neither test here takes that path, but the
  // module must still export these for route-reorder-window-fit.js.
  haversine: () => 1,
  fallbackLegMetrics: () => ({ minutes: 5 }),
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 5, source: 'conservative_model', reason: null }) }),
}));

const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');

const DATE = '2027-03-01';
const stop = (id, windowStart, lat, overrides = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z', ...overrides,
});

beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test('a congested existing leg does not inflate the candidate detour', () => {
  const existing = stop('existing', '09:00', 27.5);
  const target = stop('target', '11:00', 27.6);
  // Traffic-aware travel: the standing HQ->existing leg is badly congested
  // (90 min); every other leg (existing->target, target->HQ) is a flat 20.
  // The candidate itself adds no real extra drive beyond that congestion.
  const travel = { lookup: ({ to }) => ({ minutes: to.id === 'existing' ? 90 : 20, source: 'google_traffic', reason: null }) };
  const context = { date: DATE, now: new Date(), target, rows: [existing], grouped: false, travel };
  const fit = evaluateArrivalPlacement(context, { windowStart: '11:00', windowEnd: '12:00', durationMinutes: 60 });
  expect(fit.feasible).toBe(true);
  // Candidate route (HQ->existing 90, existing->target 20, target->HQ 20 =
  // 130) minus the SAME-source baseline (HQ->existing 90, existing->HQ 20 =
  // 110): 20 minutes of real added drive, not the ~120 a fallback-model
  // baseline (ignoring the 90-minute congestion) would have manufactured.
  expect(fit.detourMinutes).toBe(20);
});

test('a real long detour still gets capped', () => {
  const existing = stop('existing', '09:00', 27.5);
  // Pushed later so the 200-minute leg into it still meets its promise.
  const farTarget = stop('target', '15:00', 27.9);
  const travel = { lookup: ({ to }) => ({ minutes: to.id === 'target' ? 200 : 20, source: 'google_traffic', reason: null }) };
  const context = { date: DATE, now: new Date(), target: farTarget, rows: [existing], grouped: false, travel };
  const fit = evaluateArrivalPlacement(context, { windowStart: '15:00', windowEnd: '16:00', durationMinutes: 60 });
  expect(fit.feasible).toBe(true);
  // Baseline (existing alone): HQ->existing 20 + existing->HQ 20 = 40.
  // Candidate: HQ->existing 20 + existing->target 200 + target->HQ 20 = 240.
  expect(fit.detourMinutes).toBe(200);
});
