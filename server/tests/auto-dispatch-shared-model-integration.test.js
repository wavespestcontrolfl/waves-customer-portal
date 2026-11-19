// End-to-end current-vs-candidate comparison on the ONE shared model
// (GATE_AUTO_DISPATCH_SHARED_MODEL, owner-approved 2026-09-26 dispatch
// backlog item 3): wires the REAL candidate-slots.js + scoring.js +
// route-model.js together through index.js's evaluatePlacement, with only
// find-time's slot search mocked. Uses REAL geo (route-optimizer is NOT
// mocked here) so "near" and "far" placements produce genuinely different
// drive/cluster numbers.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The SLOT_TAKEN pre-filter now calls the writer's OWN read-only conflict
// probe directly (Codex pre-push structural fix) rather than going through
// ctx.db — mocked to report no conflicts so these tests exercise the SCORE
// comparison, not occupancy. visit-groups' predictMemberWindows stays real
// (pure); these services carry no visit_id, so it is never reached anyway.
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));
jest.mock('../services/visit-groups', () => ({
  openMembers: jest.fn(),
  predictMemberWindows: jest.requireActual('../services/visit-groups').predictMemberWindows,
}));

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

function stopRow(id, windowStart, windowEnd, lat, lng, { date = '2026-08-11', tech = 't2' } = {}) {
  return {
    id, window_start: windowStart, window_end: windowEnd, status: 'confirmed',
    estimated_duration_minutes: 60, svc_lat: lat, svc_lng: lng, scheduled_date: date, technician_id: tech,
  };
}

// Mirror the date predicate so the test observes the same source and
// destination rows regardless of which query the evaluator performs first.
function routeDaysDb(candidateStops, currentStops, technicians = []) {
  return (table) => {
    let dates = [];
    let techIds = null;
    let onlyUnassigned = false;
    let includeUnassigned = false;
    let timedOnly = false;
    let excludedIds = new Set();
    const c = {};
    c.where = (field, value) => {
      if (typeof field === 'function') field.call(c, c);
      else if (field === 'scheduled_services.technician_id') techIds = [String(value)];
      return c;
    };
    c.whereIn = (field, values) => {
      if (field === 'scheduled_services.scheduled_date') dates = values;
      if (field === 'scheduled_services.technician_id') techIds = values.map(String);
      return c;
    };
    c.whereNull = field => {
      if (field === 'scheduled_services.technician_id') onlyUnassigned = true;
      return c;
    };
    c.orWhereNull = field => {
      if (field === 'scheduled_services.technician_id') includeUnassigned = true;
      return c;
    };
    c.whereNotNull = field => {
      if (field === 'scheduled_services.window_start') timedOnly = true;
      return c;
    };
    c.whereNotIn = (field, values) => {
      if (field === 'scheduled_services.id') excludedIds = new Set(values.map(String));
      return c;
    };
    ['whereNot', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first', 'andWhere', 'whereRaw']
      .forEach(m => { c[m] = () => c; });
    c.select = async () => {
      if (table === 'technicians') return technicians.map(id => ({ id }));
      return [...candidateStops, ...currentStops].filter(row => dates.includes(row.scheduled_date)
        && !excludedIds.has(String(row.id))
        && (!timedOnly || row.window_start != null)
        && (onlyUnassigned ? row.technician_id == null
          : (!techIds || techIds.includes(String(row.technician_id)) || (includeUnassigned && row.technician_id == null))));
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
    stopRow('n1', '08:00', '09:00', 27.401, -82.501, { date: '2026-08-04', tech: 't1' }),
    stopRow('n2', '10:00', '11:00', 27.399, -82.499, { date: '2026-08-04', tech: 't1' }),
  ];
  findAvailableSlots.mockResolvedValue({
    slots: [
      // A far-away, empty day for a DIFFERENT technician — nothing to
      // cluster with, and a long trip out from HQ.
      { date: '2026-08-11', technician: { id: 't2', name: 'B' }, start_time: '09:00', end_time: '10:00', detour_minutes: 0, total_drive_minutes: 0, stops_that_day: 0, score: 0 },
    ],
  });
  const db = routeDaysDb([], currentStops); // candidate day has NO other stops
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
  const currentStops = [stopRow('far', '07:00', '08:00', 27.10, -82.10, { date: '2026-08-04', tech: 't1' })];
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
  const db = routeDaysDb(candidateStops, currentStops);
  const result = await evaluatePlacement(SVC, PREFS, ctxWith(db), CONFIG, '2026-06-20');

  expect(result.kind).toBe('move');
  expect(result.best.date).toBe('2026-08-11');
  expect(result.best.model).toBe('shared_v1');
  expect(result.audit.routeMetrics.model).toBe('shared_v1');
  // The clustered candidate's detour is genuinely lower than the current
  // placement's (both computed by the SAME route-model.js function).
  expect(result.audit.routeMetrics.candidate_detour_minutes).toBeLessThan(result.audit.routeMetrics.current_detour_minutes);
});

// Codex pre-push P1: an eligible recurring visit can carry technician_id
// NULL. Its current placement must read the same single-tech day candidates
// are scored on (the one active tech's stops + unassigned stops), not an
// empty day — otherwise a well-clustered unassigned visit scores as a lone
// HQ round trip and any comparable candidate falsely clears the threshold.
test('an UNASSIGNED visit on a clustered day scores that day, so an equally clustered candidate does not move it', async () => {
  const SVC = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: null,
    window_start: '09:00', estimated_duration_minutes: 60, lat: 27.40, lng: -82.50,
    auto_dispatch_change_count: 0 };
  const near = (id, start, end, date, tech) => stopRow(id, start, end, 27.401, -82.501, { date, tech });
  const currentStops = [near('n1', '08:00', '09:00', '2026-08-04', 't1'), near('n2', '10:00', '11:00', '2026-08-04', null)];
  const candidateStops = [near('c1', '08:00', '09:00', '2026-08-11', 't1'), near('c2', '10:00', '11:00', '2026-08-11', null)];
  findAvailableSlots.mockResolvedValue({
    slots: [{ date: '2026-08-11', technician: { id: 't1', name: 'A' }, start_time: '09:00', end_time: '10:00', detour_minutes: 0, total_drive_minutes: 0, stops_that_day: 2, score: 0 }],
  });
  const mover = stopRow('s1', '09:00', '10:00', 27.40, -82.50, { date: '2026-08-04', tech: null });
  const db = routeDaysDb(candidateStops, [mover, ...currentStops], ['t1']);
  const result = await evaluatePlacement(SVC, PREFS, ctxWith(db), CONFIG, '2026-06-20');

  expect(result.kind).toBe('no_change');
  expect(result.reason_code).toBe('NO_SCORE_IMPROVEMENT');
  expect(result.audit.routeMetrics.current_score_breakdown.density_score).toBe(10); // clustered, not an empty day
});
