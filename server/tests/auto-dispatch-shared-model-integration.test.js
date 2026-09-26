// End-to-end current-vs-candidate comparison on the ONE shared model
// (GATE_AUTO_DISPATCH_SHARED_MODEL, owner-approved 2026-09-26 dispatch
// backlog item 3): wires the REAL candidate-slots.js + scoring.js +
// route-model.js together through index.js's evaluatePlacement, with only
// find-time's slot search mocked. Uses REAL geo (route-optimizer is NOT
// mocked here) so "near" and "far" placements produce genuinely different
// drive/cluster numbers.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { _internals: { evaluatePlacement } } = require('../services/auto-dispatch');

const ORIGINAL_SHARED_GATE = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeEach(() => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  jest.clearAllMocks();
});
afterAll(() => {
  if (ORIGINAL_SHARED_GATE === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = ORIGINAL_SHARED_GATE;
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION; else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
});

const PREFS = {
  preferred_day_indexes: [], preferred_time_window: null, effective_time_window: null,
  blackout: null, service_category: 'general', raw_snapshot: null,
};
const CONFIG = { minScoreImprovement: 15, removeStabilityFloor: 35 };

function stopRow(id, windowStart, windowEnd, lat, lng) {
  return {
    id, window_start: windowStart, window_end: windowEnd, status: 'confirmed',
    estimated_duration_minutes: 60, svc_lat: lat, svc_lng: lng,
  };
}

// Sequenced db mock: call 1 = sibling-date query, call 2 = the candidate
// day's OTHER stops, call 3 = the current day's OTHER stops.
function sequencedDb(candidateStops, currentStops) {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (n === 1) return [];
      if (n === 2) return candidateStops;
      return currentStops;
    };
    return c;
  };
}

function ctxWith(db) {
  return {
    db,
    nowDate: new Date('2026-06-19T16:00:00Z'),
    lockWindowDays: 14,
    lookaheadDays: 90,
    dateToleranceDays: 30,
    topN: 60,
    capabilityFor: () => 'qualified',
  };
}

test('a visit already well placed (tight, clustered current day) does NOT move to a far, empty candidate day', async () => {
  const SVC = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1',
    window_start: '09:00', estimated_duration_minutes: 60, lat: 27.40, lng: -82.50,
    auto_dispatch_change_count: 0 };
  // Current day: two neighbors immediately around the visit, close by (same
  // small neighborhood) — low detour, high cluster share.
  const currentStops = [
    stopRow('n1', '08:00', '09:00', 27.401, -82.501),
    stopRow('n2', '10:00', '11:00', 27.399, -82.499),
  ];
  findAvailableSlots.mockResolvedValue({
    slots: [
      // A far-away, empty day for a DIFFERENT technician — nothing to
      // cluster with, and a long trip out from HQ.
      { date: '2026-08-11', technician: { id: 't2', name: 'B' }, start_time: '09:00', end_time: '10:00', detour_minutes: 0, total_drive_minutes: 0, stops_that_day: 0, score: 0 },
    ],
  });
  const db = sequencedDb([], currentStops); // candidate day has NO other stops
  const result = await evaluatePlacement(SVC, PREFS, ctxWith(db), CONFIG, '2026-06-20');

  expect(result.kind).toBe('no_change');
  expect(result.reason_code).toBe('NO_SCORE_IMPROVEMENT');
  expect(result.audit.routeMetrics.model).toBe('shared_v1');
});

test('a clearly better clustered day wins over a poorly-placed current day', async () => {
  const SVC = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1',
    window_start: '12:00', estimated_duration_minutes: 60, lat: 27.50, lng: -82.50,
    auto_dispatch_change_count: 0 };
  // Current day: the visit's only neighbor is far away (different part of
  // the county) — a big detour, and nothing nearby to cluster with.
  const currentStops = [stopRow('far', '07:00', '08:00', 27.10, -82.10)];
  // Candidate day: two neighbors immediately around the candidate window,
  // right next to the visit's own location — tight insertion, full cluster
  // credit.
  const candidateStops = [
    stopRow('near1', '08:00', '09:00', 27.501, -82.501),
    stopRow('near2', '10:00', '11:00', 27.499, -82.499),
  ];
  findAvailableSlots.mockResolvedValue({
    slots: [
      { date: '2026-08-11', technician: { id: 't2', name: 'B' }, start_time: '09:00', end_time: '10:00', detour_minutes: 0, total_drive_minutes: 0, stops_that_day: 2, score: 0 },
    ],
  });
  const db = sequencedDb(candidateStops, currentStops);
  const result = await evaluatePlacement(SVC, PREFS, ctxWith(db), CONFIG, '2026-06-20');

  expect(result.kind).toBe('move');
  expect(result.best.date).toBe('2026-08-11');
  expect(result.best.model).toBe('shared_v1');
  expect(result.audit.routeMetrics.model).toBe('shared_v1');
  // The clustered candidate's detour is genuinely lower than the current
  // placement's (both computed by the SAME route-model.js function).
  expect(result.audit.routeMetrics.candidate_detour_minutes).toBeLessThan(result.audit.routeMetrics.current_detour_minutes);
});
