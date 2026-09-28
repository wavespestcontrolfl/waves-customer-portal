/**
 * findCapacitySlots' pre-existing allowInsertion boolean
 * (`opts.capacityPlacement === true`): on a day whose stored route_order is
 * complete and not stale, arrival-route.js's buildCandidateOrders sequences
 * the day through currentOrder alone, which sorts a no-route_order
 * prospective candidate LAST — after the final real stop — so every hour
 * before that stop fails arrival_window UNLESS allowInsertion is set.
 * Codex round 1 on PR #5231 (owner 2026-09-28): a broader `insertProspective`
 * opt was rejected — insertion offers must only reach callers whose commit
 * persists the certified route order (createSelfBooking, while
 * GATE_BOOK_CAPACITY_COMMIT is live), which is exactly what capacityPlacement
 * already gates. This file pins find-time.js's OWN capacityPlacement ->
 * allowInsertion wiring, and its conservative_travel skip, at the unit level
 * (mocked arrival-route, no DB) — the estimate picker (estimate-slot-
 * availability.js) already relies on both; booking-availability-insertion
 * .test.js pins booking.js's own callers passing capacityPlacement through.
 *
 * This mocks arrival-route.js's evaluation (like find-time-customer-grid
 * .test.js) rather than exercising its real route-simulation math (already
 * covered by scheduling-capacity.test.js's "finds an insertion without
 * changing the existing relative stop order" / allowInsertion:false pair,
 * and by arrival-window-placement-db.test.js's real-DB capacityPlacement
 * commit-persistence proof): the mock models exactly the append-only bug — a
 * candidate before the day's last real stop is feasible only with
 * allowInsertion, one after it is feasible either way — so these tests are
 * purely about find-time.js's own opts.capacityPlacement -> allowInsertion
 * wiring and the conservative_travel keying, not arrival-route's insertion
 * math or the DB-backed commit.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  createSchedulingTravel: () => ({ preload: async () => {}, diagnostics: () => ({}) }),
}));

// A day whose stored route_order is complete: stops at 09:00, 13:00, 15:00,
// 16:00 (route-order 1-4), matching the scenario in the fix's owner report.
// The last stop ends at 17:00. Without insertion, buildCandidateOrders would
// sequence the no-route_order prospective candidate AFTER that stop — so
// this mock treats any candidate start before 17:00 as infeasible
// (arrival_window) UNLESS options.allowInsertion is set, and any start at or
// after 17:00 (genuinely after the last stop) as feasible either way.
const LAST_STOP_END_MIN = 17 * 60;
const mockEvaluateArrivalPlacement = jest.fn((_context, options) => {
  const [h, m] = options.windowStart.split(':').map(Number);
  const start = h * 60 + m;
  if (!options.allowInsertion && start < LAST_STOP_END_MIN) {
    return { feasible: false, reason: 'arrival_window' };
  }
  return {
    feasible: true, routeOrder: ['s09', 's13', 's15', 's16', 'candidate'],
    detourMinutes: 5, driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0,
    estimatedArrival: null, arrivals: [{}], finishMinute: 1080,
    travelSource: 'none', travelReasons: [],
  };
});
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: () => false,
  loadArrivalRouteContext: jest.fn(async () => ({
    target: { id: 'candidate', service_type: 'pest_control' },
    rows: [
      { id: 's09', route_order: 1, window_start: '09:00' },
      { id: 's13', route_order: 2, window_start: '13:00' },
      { id: 's15', route_order: 3, window_start: '15:00' },
      { id: 's16', route_order: 4, window_start: '16:00' },
    ],
  })),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: mockEvaluateArrivalPlacement,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const evaluateArrivalPlacement = mockEvaluateArrivalPlacement;

function chain(result) {
  const c = {};
  ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const FUTURE_DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1',
  dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 50, serviceType: 'pest_control',
};

describe('findCapacitySlots — capacityPlacement insertion on a complete-route-order day', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
    evaluateArrivalPlacement.mockImplementation((_context, options) => {
      const [h, m] = options.windowStart.split(':').map(Number);
      const start = h * 60 + m;
      if (!options.allowInsertion && start < LAST_STOP_END_MIN) {
        return { feasible: false, reason: 'arrival_window' };
      }
      return {
        feasible: true, routeOrder: ['s09', 's13', 's15', 's16', 'candidate'],
        detourMinutes: 5, driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0,
        estimatedArrival: null, arrivals: [{}], finishMinute: 1080,
        travelSource: 'none', travelReasons: [],
      };
    });
  });
  afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

  // evaluateArrivalPlacement is also called 3x per candidate up front, for
  // the pairwise travel-preload passes (collectLegs set) — filtered out
  // below so these tests count only the REAL feasibility checks (the main
  // fit check, and — only when !capacityPlacement — the conservative_travel
  // no-traffic fallback probe).
  const realCalls = () => evaluateArrivalPlacement.mock.calls.filter((c) => !('collectLegs' in c[1]));

  test('capacityPlacement: true — a 10:00/11:00 candidate between existing stops is offered, and the conservative_travel fallback probe is skipped', async () => {
    const { slots } = await findAvailableSlots({ ...BASE, capacityPlacement: true });
    const startTimes = slots.map((s) => s.start_time);
    expect(startTimes).toContain('10:00');
    expect(startTimes).toContain('11:00');
    // One real evaluateArrivalPlacement call per admitted 10:00 candidate,
    // not two — capacityPlacement skips the conservative_travel probe
    // (find-time.js: `if (!opts.capacityPlacement && ...)`).
    expect(realCalls().filter((c) => c[1].windowStart === '10:00')).toHaveLength(1);
  });

  test('capacityPlacement omitted — the same candidate is rejected with arrival_window, and the conservative_travel probe runs', async () => {
    const { slots, rejections } = await findAvailableSlots({ ...BASE });
    const startTimes = slots.map((s) => s.start_time);
    expect(startTimes).not.toContain('10:00');
    expect(startTimes).not.toContain('11:00');
    expect(rejections.arrival_window).toBeGreaterThan(0);
    // The main check alone rejects 10:00 (arrival_window) before the
    // conservative_travel probe would even run for it — confirms the
    // rejection comes from allowInsertion being unset, not from a
    // travel-only failure.
    expect(realCalls().filter((c) => c[1].windowStart === '10:00')).toHaveLength(1);
  });
});
