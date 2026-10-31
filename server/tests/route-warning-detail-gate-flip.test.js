/**
 * GATE_ROUTE_WARNING_DETAIL across a flip (Codex round 1 P2): a reviewed reschedule's conflict snapshot is
 * built from the unchanged sentence, so a proposal reviewed with the gate in one state and applied in the
 * other still matches. Real evaluator and real occupancy and rebooker probes, in-memory route.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  ...jest.requireActual('../services/route-optimizer'),
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  fallbackLegMetrics: () => ({ minutes: 20 }),
  milesToDriveMinutes: () => 15,
  createSchedulingTravel: () => ({ lookup: () => ({ minutes: 20, source: 'conservative_model', reason: null }) }),
}));

const mockStops = { rows: [], target: null };
jest.mock('../services/scheduling/arrival-route', () => {
  const actual = jest.requireActual('../services/scheduling/arrival-route');
  return {
    ...actual,
    arrivalWindowRoutingEnabled: () => true,
    checkArrivalPlacement: async ({ windowStart, windowEnd, detail }) => actual.evaluateArrivalPlacement({
      date: '2027-03-01', now: new Date('2027-03-01T06:00:00-05:00'), target: mockStops.target, rows: mockStops.rows,
      grouped: false, prospective: false, travel: undefined, blocks: [] }, { windowStart, windowEnd, durationMinutes: 60, detail }),
  };
});

const rebooker = require('../services/rebooker');

const stop = (id, windowStart, extra = {}) => ({
  id, technician_id: 'tech', scheduled_date: '2027-03-01', status: 'confirmed', window_start: windowStart,
  window_end: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`, estimated_duration_minutes: 60,
  lat: 27.5, lng: -82.4, route_order: null, created_at: '2020-01-01T12:00:00Z', ...extra,
});
const probe = () => rebooker.probeMoveConflicts({ conn: jest.fn(), excludeServiceIds: [], options: { overlapAdvisory: true, adminWindowRules: true },
  target: { id: 'T', date: '2027-03-01', windowStart: mockStops.target.window_start, windowEnd: mockStops.target.window_end, technicianId: 'tech' } });
const flip = async () => {
  delete process.env.GATE_ROUTE_WARNING_DETAIL;
  const off = await probe();
  process.env.GATE_ROUTE_WARNING_DETAIL = 'true';
  const on = await probe();
  return { off, on };
};

beforeEach(() => { delete process.env.GATE_ROUTE_WARNING_DETAIL; delete process.env.GATE_SCHEDULING_CAPACITY; delete process.env.GATE_STAFF_ROUTE_INSERTION; });
afterEach(() => { delete process.env.GATE_ROUTE_WARNING_DETAIL; });

test('an unverified route (a stop with no pin): the warning is worded with the gate on, the snapshot is the same either way', async () => {
  mockStops.rows = [stop('P', '08:00', { lat: null })];
  mockStops.target = stop('T', '10:00');
  const { off, on } = await flip();
  expect(off.rows[0].warning).toMatch(/^Could not verify the route's arrival windows/);
  expect(on.rows[0].warning).toMatch(/Stop 1 \(8–10 AM window\) has no map pin/);
  expect(on.rows[0].base_warning).toBe(off.rows[0].warning);
  expect(on.snapshot).toEqual(off.snapshot);
});

test('an arrival_window failure: the same snapshot across the flip', async () => {
  mockStops.rows = [stop('A', '08:00', { estimated_duration_minutes: 240, window_end: '12:00' }), stop('B', '08:30')];
  mockStops.target = stop('T', '15:00');
  const { off, on } = await flip();
  expect(off.rows[0].conflict_reason).toBe('arrival_window');
  expect(on.rows[0].warning).not.toBe(off.rows[0].warning);
  expect(on.snapshot).toEqual(off.snapshot);
});
