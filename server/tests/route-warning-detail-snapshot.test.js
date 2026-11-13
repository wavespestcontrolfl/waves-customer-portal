/**
 * Route warning detail (Codex round 1 P2): a reviewed reschedule's conflict snapshot is built from the
 * unchanged sentence (`base_warning`), not the worded warning, so the clock times in the words cannot make a
 * reviewed move fail "destination schedule changed". Real evaluator and real occupancy and rebooker probes,
 * in-memory route.
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

beforeEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test('an unverified route (a stop with no pin): the warning is worded, base_warning keeps the unchanged sentence, the snapshot uses it', async () => {
  mockStops.rows = [stop('P', '08:00', { lat: null })];
  mockStops.target = stop('T', '10:00');
  const result = await probe();
  expect(result.rows[0].warning).toMatch(/Stop 1 \(8–10 AM window\) has no map pin/);
  expect(result.rows[0].base_warning).toMatch(/^Could not verify the route's arrival windows/);
  expect(JSON.stringify(result.snapshot)).toContain(result.rows[0].base_warning);
  expect(JSON.stringify(result.snapshot)).not.toContain('has no map pin');
});

test('an arrival_window failure: the worded warning differs from base_warning, and the snapshot carries only base_warning', async () => {
  mockStops.rows = [stop('A', '08:00', { estimated_duration_minutes: 240, window_end: '12:00' }), stop('B', '08:30')];
  mockStops.target = stop('T', '15:00');
  const result = await probe();
  expect(result.rows[0].conflict_reason).toBe('arrival_window');
  expect(result.rows[0].warning).not.toBe(result.rows[0].base_warning);
  expect(JSON.stringify(result.snapshot)).toContain(result.rows[0].base_warning);
  expect(JSON.stringify(result.snapshot)).not.toContain(result.rows[0].warning);
});
