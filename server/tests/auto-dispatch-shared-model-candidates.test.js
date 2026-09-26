// GATE_AUTO_DISPATCH_SHARED_MODEL applied inside findValidCandidateSlots /
// computeCurrentPlacement: candidates the rebooker's writer would refuse
// (SLOT_TAKEN) are dropped before scoring, survivors are re-scored on the
// shared route-cost/cluster model, and gate off stays byte-identical to
// today (2026-09-26 incident: 17 applied, 72 SLOT_TAKEN under the legacy
// candidate generation).
//
// Codex pre-push P1 (this round — "we keep missing pieces because we mirror
// the writer"): the SLOT_TAKEN pre-filter calls the writer's OWN read-only
// conflict probe (rebooker.js probeMoveConflicts, exported unchanged) rather
// than re-deriving any part of its predicate, ONE call per DISTINCT
// candidate DATE (never per candidate/member). Groups are checked per member
// window from the writer's own derivation (visit-groups.js
// predictMemberWindows) rather than a summed/widened interval. Route-cost/
// cluster scoring reads every candidate tech-day in ONE batched query
// (tech-or-unassigned rows), with windowless placeholders excluded and
// visit-group members collapsed to one physical stop for clustering.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));
jest.mock('../services/visit-groups', () => ({
  openMembers: jest.fn(),
  predictMemberWindows: jest.requireActual('../services/visit-groups').predictMemberWindows,
}));
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { openMembers } = require('../services/visit-groups');
const { probeMoveConflicts } = require('../services/rebooker');
const {
  findValidCandidateSlots,
  computeCurrentPlacement,
  _internals: {
    loadDayStops, loadGroupContext, filterAndScoreSharedModelCandidates, loadDateOccupiedSpans, planUnitPlacement, movedSiblings, candidateRouteOrder,
  },
} = require('../services/auto-dispatch/candidate-slots');

const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
const ORIGINAL_SHARED_GATE = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
beforeEach(() => {
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  jest.clearAllMocks();
  probeMoveConflicts.mockResolvedValue({ rows: [], snapshot: [] }); // default: no occupancy conflicts anywhere
});
afterEach(() => {
  if (ORIGINAL_SHARED_GATE === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = ORIGINAL_SHARED_GATE;
});
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION; else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
});

const SERVICE = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1', window_start: '09:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
const prefs = { service_category: 'general', blackout: null };

function ctxBase() {
  return {
    nowDate: new Date('2026-06-19T16:00:00Z'),
    lockWindowDays: 14,
    lookaheadDays: 90,
    topN: 60,
    capabilityFor: () => 'qualified',
  };
}

// Generic ctx.db mock: every scheduled_services query (sibling-date check,
// loadDayStops for route scoring, computeCurrentPlacement's neighbor
// queries) returns []. The SLOT_TAKEN occupancy check no longer touches
// ctx.db at all — it goes through the mocked rebooker probeMoveConflicts above.
function emptyDb() {
  const c = {};
  ['where', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
    .forEach((m) => { c[m] = () => c; });
  c.select = async () => [];
  return () => c;
}

// A conflicting row shaped just enough for scheduling/occupancy.js's
// occupiedRows to expand it to a plain {startMin, endMin} span (no
// reservation_service_mix -> not a version-2 combined allocation, the common
// case) — the SAME expansion probeMoveConflicts' own findConflictingVisits
// applies internally.
function conflictRow(windowStart, windowEnd) {
  return { id: 'occupied-1', window_start: windowStart, window_end: windowEnd, estimated_duration_minutes: 60 };
}

// The tech-day a batched day-stop row belongs to (the 2026-08-06 / t1 slot
// most tests use).
const SLOT_KEY = { scheduled_date: '2026-08-06', technician_id: 't1' };

test('gate ON: drops a SLOT_TAKEN candidate (via the writer\'s own probeMoveConflicts, batched by date) and re-scores the survivor on the shared model', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [
      { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1 },
      { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 },
    ],
  });
  // 08-05's window (08:00-09:00) collides with existing occupancy; 08-06 is clear.
  probeMoveConflicts.mockImplementation(async ({ target }) => (
    target.date === '2026-08-05' ? { rows: [conflictRow('08:00', '09:00')], snapshot: [] } : { rows: [], snapshot: [] }
  ));
  const { candidates, current, drops } = await findValidCandidateSlots(SERVICE, prefs, { ...ctxBase(), db: emptyDb() });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].date).toBe('2026-08-06');
  expect(candidates[0].model).toBe('shared_v1');
  expect(Number.isFinite(candidates[0].same_area_share)).toBe(true);
  expect(drops.slot_taken).toBe(1);
  expect(current.model).toBe('shared_v1');
});

test('gate OFF: no occupancy pre-filter, no shared-model fields, byte-identical to legacy candidate output', async () => {
  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  findAvailableSlots.mockResolvedValue({
    slots: [
      { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1 },
      { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 },
    ],
  });
  // Only 2 db calls expected (sibling query + current-placement neighbors) —
  // the shared-model queries never run, and the writer's probe is never
  // even called.
  let calls = 0;
  const db = () => {
    calls += 1;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
    c.select = async () => [];
    return c;
  };
  const { candidates, current, drops } = await findValidCandidateSlots(SERVICE, prefs, { ...ctxBase(), db });

  expect(candidates).toHaveLength(2); // both kept — no SLOT_TAKEN pre-filter
  expect(candidates.map((c) => c.date)).toEqual(['2026-08-05', '2026-08-06']); // find-time's own order preserved
  expect(candidates.every((c) => c.model === undefined)).toBe(true);
  expect(candidates.every((c) => c.same_area_share === undefined)).toBe(true);
  expect(drops.slot_taken).toBe(0);
  expect(current.model).toBeUndefined();
  expect(calls).toBe(2);
  expect(probeMoveConflicts).not.toHaveBeenCalled();
});

// Codex r1 (PRRT_kwDOR3YQi86mP9cs): gate on, every survivor reaches the
// caller to be scored (index.js caps by total score); gate off keeps the
// legacy pre-score cap in find-time order.
test('gate on: no pre-score cap — every survivor is returned; gate off: the legacy top-N cap', async () => {
  const slots = ['2026-08-05', '2026-08-06', '2026-08-07'].map((date) => (
    { date, technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 5, stops_that_day: 0, score: 1 }
  ));
  findAvailableSlots.mockResolvedValue({ slots });
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const on = await findValidCandidateSlots(SERVICE, prefs, { ...ctxBase(), scoreCap: 1, db: emptyDb() });
  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  const off = await findValidCandidateSlots(SERVICE, prefs, { ...ctxBase(), scoreCap: 1, db: emptyDb() });
  expect(on.candidates).toHaveLength(3);
  expect(off.candidates.map((c) => c.date)).toEqual(['2026-08-05']);
});

// Sequenced db mock for a SINGLE candidate: call 1 = sibling-date query
// (none), call 2 = the batched candidate tech-day stops — `dayStops`, call
// 3 = computeCurrentPlacement's legacy neighbor query (none), call 4 =
// computeCurrentPlacement's shared-model loadDayStops (none). The occupancy
// check goes through the mocked probe, never ctx.db.
function singleCandidateDb(dayStops) {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (n === 1) return []; // sibling query
      if (n === 2) return dayStops; // the candidate tech-days' stops (one batched read)
      return []; // current-placement queries (legacy + shared-model)
    };
    return c;
  };
}

// Codex pre-push P1 (2026-09-26): loadDayStops fetched expired estimate-slot
// holds and no_show rows — invisible to the occupancy check already, but
// routeCost/clusterShare had no exclusion of their own, so a day whose only
// "stops" were inactive read as near-zero detour and fully clustered.
test('a day whose only stops are an expired hold + a no_show scores IDENTICALLY to a genuinely empty day', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const SLOT = { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 };

  // Sitting right on top of the candidate's own location — if either row
  // wrongly counted, it would score a near-zero detour and full cluster
  // credit.
  const expiredHoldRow = {
    id: 'expired-hold', window_start: '08:00', window_end: '09:00', status: 'confirmed',
    reservation_expires_at: new Date(Date.now() - 60000).toISOString(),
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng, ...SLOT_KEY,
  };
  const noShowRow = {
    id: 'no-show', window_start: '08:00', window_end: '09:00', status: 'no_show',
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng, ...SLOT_KEY,
  };

  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: withInactiveOnly } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: singleCandidateDb([expiredHoldRow, noShowRow]) },
  );

  jest.clearAllMocks();
  probeMoveConflicts.mockResolvedValue({ rows: [], snapshot: [] });
  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: empty } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: singleCandidateDb([]) },
  );

  expect(withInactiveOnly).toHaveLength(1);
  expect(empty).toHaveLength(1);
  expect(withInactiveOnly[0].detour_minutes).toBe(empty[0].detour_minutes);
  expect(withInactiveOnly[0].total_drive_minutes).toBe(empty[0].total_drive_minutes);
  // Cluster share must read as an EMPTY day (0), not fully clustered (the
  // mocked haversine below always reports every pair as "close").
  expect(withInactiveOnly[0].same_area_share).toBe(0);
  expect(empty[0].same_area_share).toBe(0);
});

// Codex pre-push P1: loadDayStops fetched windowless placeholder rows
// (window_start NULL — a due-date recurring child not yet placed) and
// defaulted them to a FICTIONAL 08:00 start, inflating route-cost/cluster
// scoring. This mock ACTUALLY honors the SQL exclusion (filters the fixture
// once .whereNotNull('...window_start') is invoked), so a regression that
// drops that call would make this test fail — not just assert the call
// shape.
function windowlessAwareSingleCandidateDb(dayStopsFixture) {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    let filteredWindowless = false;
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.whereNotNull = (field) => {
      if (field === 'scheduled_services.window_start') filteredWindowless = true;
      return c;
    };
    c.select = async () => {
      if (n === 1) return [];
      if (n === 2) return filteredWindowless ? dayStopsFixture.filter((r) => r.window_start != null) : dayStopsFixture;
      return [];
    };
    return c;
  };
}

test('a day whose only "stop" is a windowless placeholder scores like an empty day (Codex pre-push P1)', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const SLOT = { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 };
  const placeholderRow = {
    id: 'placeholder', window_start: null, window_end: null, status: 'pending',
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng, ...SLOT_KEY,
  };

  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: withPlaceholder } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: windowlessAwareSingleCandidateDb([placeholderRow]) },
  );

  jest.clearAllMocks();
  probeMoveConflicts.mockResolvedValue({ rows: [], snapshot: [] });
  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: empty } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: windowlessAwareSingleCandidateDb([]) },
  );

  expect(withPlaceholder).toHaveLength(1);
  expect(withPlaceholder[0].detour_minutes).toBe(empty[0].detour_minutes);
  expect(withPlaceholder[0].total_drive_minutes).toBe(empty[0].total_drive_minutes);
  expect(withPlaceholder[0].same_area_share).toBe(0);
});

test('computeCurrentPlacement: a current-day expired hold / no_show does not count toward detour or clustering', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';

  const expiredHoldRow = {
    id: 'expired-hold', window_start: '08:00', window_end: '09:00', status: 'confirmed',
    reservation_expires_at: new Date(Date.now() - 60000).toISOString(),
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng,
  };
  const noShowRow = {
    id: 'no-show', window_start: '10:00', window_end: '11:00', status: 'no_show',
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng,
  };
  const rowsDb = (rows) => () => {
    const c = {};
    ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => rows;
    return c;
  };

  const withInactive = await computeCurrentPlacement(SERVICE, prefs, { ...ctxBase(), db: rowsDb([expiredHoldRow, noShowRow]) });
  const empty = await computeCurrentPlacement(SERVICE, prefs, { ...ctxBase(), db: rowsDb([]) });

  expect(withInactive.detour_minutes).toBe(empty.detour_minutes);
  expect(withInactive.total_drive_minutes).toBe(empty.total_drive_minutes);
  expect(withInactive.same_area_share).toBe(0);
  expect(empty.same_area_share).toBe(0);
});

// Codex pre-push P1 (this round): stops_that_day under the gate must count
// the SAME active stop list (activeNeighbors) the detour/cluster numbers
// above are computed from, not the legacy (inactive-carrying) neighbor list.
test('computeCurrentPlacement: stops_that_day under the gate counts ACTIVE neighbors only', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const noShowRow = {
    id: 'no-show', window_start: '10:00', window_end: '11:00', status: 'no_show',
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng,
  };
  const rowsDb = (rows) => () => {
    const c = {};
    ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => rows;
    return c;
  };
  const current = await computeCurrentPlacement(SERVICE, prefs, { ...ctxBase(), db: rowsDb([noShowRow]) });
  // The no_show never counts (it isn't active) — just the visit itself.
  expect(current.stops_that_day).toBe(1);
});

// Codex pre-push P1 (this round): the writer's OWN read-only conflict probe
// is the source of truth, batched by date rather than re-derived per query.
describe('loadDateOccupiedSpans: the writer\'s own probe, batched by date (Codex pre-push P1)', () => {
  test('calls probeMoveConflicts ONCE with a full-day window and the moving unit\'s excludeIds, expanding rows to {startMin, endMin} spans', async () => {
    probeMoveConflicts.mockResolvedValueOnce({ rows: [conflictRow('08:00', '09:00')], snapshot: [] });
    const result = await loadDateOccupiedSpans(jest.fn(), '2026-08-06', new Set(['s1', 'sib1']));

    expect(result).toEqual([{ startMin: 480, endMin: 540 }]);
    expect(probeMoveConflicts).toHaveBeenCalledTimes(1);
    const call = probeMoveConflicts.mock.calls[0][0];
    expect(call.target.date).toBe('2026-08-06');
    expect(call.target.technicianId).toBeNull();
    // A full-day window — comfortably past the latest close this business
    // ever runs — so the writer's own SQL predicate is vacuously true for
    // every real row on the date.
    expect(call.target.windowStart < '01:00').toBe(true);
    expect(call.target.windowEnd > '18:00').toBe(true);
    expect(new Set(call.excludeServiceIds)).toEqual(new Set(['s1', 'sib1']));
  });

  test('filterAndScoreSharedModelCandidates batches by DATE, not by (technician, date) — one probe call serves every technician candidate on that date', async () => {
    const service = { id: 's1', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
    const geo = { lat: 27.4, lng: -82.5 };
    const candidates = [
      { technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' },
      { technician_id: 't2', date: '2026-08-06', start_time: '09:00', end_time: '10:00' },
      { technician_id: 't1', date: '2026-08-07', start_time: '08:00', end_time: '09:00' },
    ];
    await filterAndScoreSharedModelCandidates(service, geo, candidates, { db: emptyDb() }, {});

    // Two distinct DATES among three candidates -> exactly two probe calls.
    expect(probeMoveConflicts).toHaveBeenCalledTimes(2);
    const dates = probeMoveConflicts.mock.calls.map((c) => c[0].target.date).sort();
    expect(dates).toEqual(['2026-08-06', '2026-08-07']);
  });
});

describe('loadDayStops: tech-scoped route scoring (+ the single tech\'s unassigned rows), windowless placeholders excluded', () => {
  // .where receives a callback (the tech-or-null filter, Codex r1) — capture
  // the callback's own sub-builder calls to verify the OR NULL predicate shape.
  function techFilterCapturingDb() {
    let capturedTech = null;
    let capturedNullField = null;
    const c = {};
    c.where = (fieldOrFn) => {
      if (typeof fieldOrFn === 'function') {
        const sub = {
          whereIn: (f, v) => { capturedTech = [f, v]; return sub; },
          orWhereNull: (f) => { capturedNullField = f; return sub; },
        };
        fieldOrFn(sub);
      }
      return c;
    };
    ['whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => [];
    return { db: () => c, get capturedTech() { return capturedTech; }, get capturedNullField() { return capturedNullField; } };
  }

  test('the technician filter matches the candidate tech OR technician_id IS NULL (single active field tech, Codex pre-push P1)', async () => {
    const harness = techFilterCapturingDb();
    await loadDayStops(harness.db, { technicianId: 't1', dateStr: '2026-08-06', excludeIds: new Set(['s1']) });
    expect(harness.capturedTech).toEqual(['scheduled_services.technician_id', ['t1']]);
    expect(harness.capturedNullField).toBe('scheduled_services.technician_id');
  });

  // Codex r1: no per-tech-day serial reads — every candidate tech-day comes
  // from ONE query, split in memory (an unassigned row counts for every tech).
  test('filterAndScoreSharedModelCandidates reads every candidate tech-day in ONE query and scores each on its own day', async () => {
    let queries = 0;
    let capturedDates = null;
    const rows = [
      { id: 'a', window_start: '10:00', window_end: '11:00', status: 'confirmed', svc_lat: 27.4, svc_lng: -82.5, scheduled_date: '2026-08-06', technician_id: 't1' },
      { id: 'b', window_start: '12:00', window_end: '13:00', status: 'confirmed', svc_lat: 27.4, svc_lng: -82.5, scheduled_date: '2026-08-06', technician_id: null },
      { id: 'c', window_start: '10:00', window_end: '11:00', status: 'confirmed', svc_lat: 27.4, svc_lng: -82.5, scheduled_date: new Date('2026-08-07T00:00:00Z'), technician_id: 't2' },
    ];
    const db = () => {
      queries += 1;
      const c = {};
      ['where', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
      c.whereIn = (field, v) => { if (field === 'scheduled_services.scheduled_date') capturedDates = v; return c; };
      c.select = async () => rows;
      return c;
    };
    const candidates = [
      { technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' },
      { technician_id: 't2', date: '2026-08-06', start_time: '14:00', end_time: '15:00' },
      { technician_id: 't2', date: '2026-08-07', start_time: '08:00', end_time: '09:00' },
    ];
    const kept = await filterAndScoreSharedModelCandidates(
      { id: 's1', estimated_duration_minutes: 60 }, { lat: 27.4, lng: -82.5 }, candidates, { db }, {},
    );
    expect(queries).toBe(1);
    expect(capturedDates.sort()).toEqual(['2026-08-06', '2026-08-07']);
    // t1 on 08-06: its own row + the unassigned row; t2 on 08-06: the
    // unassigned row only; t2 on 08-07: its own row.
    expect(kept.map((k) => k.stops_that_day)).toEqual([3, 2, 2]);
  });

  test('excludes windowless placeholder rows via whereNotNull(window_start) — matches the canonical occupancy reader\'s own convention', async () => {
    let capturedField = null;
    const db = () => {
      const c = {};
      ['where', 'whereIn', 'whereNotIn'].forEach((m) => { c[m] = () => c; });
      c.whereNotNull = (field) => { capturedField = field; return c; };
      c.leftJoin = () => c;
      c.select = async () => [];
      return c;
    };
    await loadDayStops(db, { technicianId: 't1', dateStr: '2026-08-06', excludeIds: new Set(['s1']) });
    expect(capturedField).toBe('scheduled_services.window_start');
  });

  test('no technician: the unassigned rows alone (whereNull, no technician list)', async () => {
    let usedWhereNull = null;
    let usedWhereIn = false;
    const c = {};
    c.where = (fn) => {
      if (typeof fn === 'function') {
        fn({ whereNull: (f) => { usedWhereNull = f; }, whereIn: () => { usedWhereIn = true; return { orWhereNull: () => {} }; } });
      }
      return c;
    };
    ['whereIn', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => [];
    await loadDayStops(() => c, { technicianId: null, dateStr: '2026-08-06', excludeIds: new Set() });
    expect(usedWhereNull).toBe('scheduled_services.technician_id');
    expect(usedWhereIn).toBe(false);
  });

  test('excludes every id in excludeIds via whereNotIn', async () => {
    let capturedExcludeArgs = null;
    const db = () => {
      const c = {};
      ['where', 'whereIn', 'whereNotNull'].forEach((m) => { c[m] = () => c; });
      c.whereNotIn = (field, ids) => {
        if (field === 'scheduled_services.id') capturedExcludeArgs = ids;
        return c;
      };
      c.leftJoin = () => c;
      c.select = async () => [];
      return c;
    };
    await loadDayStops(db, { technicianId: 't1', dateStr: '2026-08-06', excludeIds: new Set(['s1', 'sib']) });
    expect(new Set(capturedExcludeArgs)).toEqual(new Set(['s1', 'sib']));
  });
});

// Codex pre-push P1: a visit-group's own siblings (moving together with the
// tapped visit) must never be counted as a stationary "other stop" for
// EITHER side of the current-vs-candidate comparison, and the group's
// occupancy must be checked via the writer's OWN per-member shift math
// (predictMemberWindows) rather than a summed/widened interval.
// Call 1 = loadGroupContext's sibling rows; later calls = the batched
// candidate tech-day stops (none).
// Serves the unit's visit row (service_visits.window_start — the unit
// mover's anchor fallback) and hands every other table to `db`.
function withVisit(db, visitWindowStart = null) {
  return (table) => {
    if (table !== 'service_visits') return db(table);
    const c = {};
    c.where = () => c;
    c.first = async () => ({ window_start: visitWindowStart });
    return c;
  };
}

function groupDb(siblingRows) {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => (n === 1 ? siblingRows : []);
    return c;
  };
}

describe('visit-group exclusion (Codex pre-push P1)', () => {
  test('loadGroupContext: no visit_id -> standalone visit, zero db calls', async () => {
    const db = jest.fn();
    const result = await loadGroupContext(db, { id: 's1' });
    expect(result.excludeIds).toEqual(new Set(['s1']));
    expect(result.siblings).toEqual([]);
    expect(db).not.toHaveBeenCalled();
    expect(openMembers).not.toHaveBeenCalled();
  });

  test('loadGroupContext: a visit group resolves excludeIds (self + siblings) and the siblings\' windows', async () => {
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }, { id: 'sib2' }]);
    const db = () => {
      const c = {};
      c.whereIn = () => c;
      c.select = async () => [
        { id: 'sib1', window_start: '10:00', window_end: '11:00' },
        { id: 'sib2', window_start: '13:00', window_end: '14:00' },
      ];
      return c;
    };
    const result = await loadGroupContext(withVisit(db, '09:00'), { id: 's1', visit_id: 'v1' });
    expect(result.excludeIds).toEqual(new Set(['s1', 'sib1', 'sib2']));
    expect(result.siblings.map((s) => s.id).sort()).toEqual(['sib1', 'sib2']);
    expect(result.visitWindowStart).toBe('09:00');
  });

  // Codex r3 P1 (PRRT_kwDOR3YQi86mQlqy): a visit_id row whose group cannot
  // be read may be grouped — fail closed, never score it as standalone.
  test('loadGroupContext: an unreadable group FAILS CLOSED (GROUP_CONTEXT_UNAVAILABLE), for the member read and the follow-ups alike', async () => {
    openMembers.mockRejectedValueOnce(new Error('boom'));
    await expect(loadGroupContext(jest.fn(), { id: 's1', visit_id: 'v1' }))
      .rejects.toMatchObject({ code: 'GROUP_CONTEXT_UNAVAILABLE' });

    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    const failingSiblings = (table) => {
      const c = {};
      ['where', 'whereIn'].forEach((m) => { c[m] = () => c; });
      c.select = async () => { throw new Error('boom'); };
      c.first = async () => ({ window_start: '09:00' });
      return table === 'service_visits' ? c : c;
    };
    await expect(loadGroupContext(failingSiblings, { id: 's1', visit_id: 'v1' }))
      .rejects.toMatchObject({ code: 'GROUP_CONTEXT_UNAVAILABLE' });
  });

  test('gate on: a visit whose group cannot be read gets no candidates and no current placement (propagates to the orchestrator)', async () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    findAvailableSlots.mockResolvedValue({
      slots: [{ date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 5, stops_that_day: 0, score: 1 }],
    });
    openMembers.mockRejectedValueOnce(new Error('boom'));
    await expect(findValidCandidateSlots({ ...SERVICE, visit_id: 'v1' }, prefs, { ...ctxBase(), db: emptyDb() }))
      .rejects.toMatchObject({ code: 'GROUP_CONTEXT_UNAVAILABLE' });
  });

  test('filterAndScoreSharedModelCandidates: excludes group siblings from loadDayStops (never a stationary "other stop") and from the occupancy probe\'s excludeServiceIds', async () => {
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    let call = 0;
    let capturedDayStopExcludeIds = null;
    const db = () => {
      call += 1;
      const n = call;
      const c = {};
      if (n === 1) {
        // loadGroupContext's sibling-fields query
        c.whereIn = () => c;
        c.select = async () => [{ id: 'sib1', window_start: '10:00', window_end: '11:00' }];
      } else {
        // the batched candidate tech-day stops
        c.where = () => c;
        c.whereIn = () => c;
        c.whereNotNull = () => c;
        c.whereNotIn = (field, ids) => {
          if (field === 'scheduled_services.id') capturedDayStopExcludeIds = ids;
          return c;
        };
        c.leftJoin = () => c;
        c.select = async () => [];
      }
      return c;
    };
    const service = { id: 's1', visit_id: 'v1', window_start: '08:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
    const geo = { lat: 27.4, lng: -82.5 };
    const candidates = [{ technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' }];
    await filterAndScoreSharedModelCandidates(service, geo, candidates, { db: withVisit(db) }, {});

    expect(new Set(capturedDayStopExcludeIds)).toEqual(new Set(['s1', 'sib1']));
    expect(new Set(probeMoveConflicts.mock.calls[0][0].excludeServiceIds)).toEqual(new Set(['s1', 'sib1']));
  });

  test('a sibling whose shift would cross midnight rejects the WHOLE candidate outright (predictMemberWindows\' own invalid flag)', async () => {
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    // A sibling at 23:30 — the primary's requested +14h shift pushes it past
    // midnight.
    const db = groupDb([{ id: 'sib1', window_start: '23:30', window_end: '23:59' }]);
    const service = { id: 's1', visit_id: 'v1', window_start: '08:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
    const geo = { lat: 27.4, lng: -82.5 };
    // Requesting a MUCH later start shifts the sibling well past 24:00.
    const candidates = [{ technician_id: 't1', date: '2026-08-06', start_time: '22:00', end_time: '23:00' }];
    const drops = { slot_taken: 0 };
    const kept = await filterAndScoreSharedModelCandidates(service, geo, candidates, { db: withVisit(db) }, drops);
    expect(kept).toHaveLength(0);
    expect(drops.slot_taken).toBe(1);
  });

  test('computeCurrentPlacement: excludes the visit\'s own group siblings from the shared-model neighbor list', async () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    const grouped = { ...SERVICE, visit_id: 'v1' };
    let call = 0;
    let capturedExcludeIds = null;
    const db = () => {
      call += 1;
      const n = call;
      const c = {};
      // Gate on: the legacy neighbor read is skipped (the shared model reads
      // the day itself), so the first query is the group's sibling fields.
      if (n === 1) {
        // loadGroupContext's sibling-fields query
        c.whereIn = () => c;
        c.select = async () => [{ id: 'sib1', window_start: '10:00', window_end: '11:00' }];
      } else {
        // loadDayStops for the CURRENT day/tech (the shared-model branch)
        c.where = () => c;
        c.whereIn = () => c;
        c.whereNotNull = () => c;
        c.whereNotIn = (field, ids) => { if (field === 'scheduled_services.id') capturedExcludeIds = ids; return c; };
        c.leftJoin = () => c;
        c.select = async () => [];
      }
      return c;
    };
    await computeCurrentPlacement(grouped, prefs, { ...ctxBase(), db: withVisit(db) });
    expect(new Set(capturedExcludeIds)).toEqual(new Set(['s1', 'sib1']));
  });
});

// Codex r1 (PRRT_kwDOR3YQi86mPzgj, PRRT_kwDOR3YQi86mP9cn): the pre-filter
// asks the writer's own probe for every window the writer itself will probe
// — the tapped visit's, or each group member's derived window — instead of
// a tech-scoped query or one summed interval for the group.
describe('SLOT_TAKEN parity with the writer (Codex r1)', () => {
  const realProbe = jest.requireActual('../services/rebooker').probeMoveConflicts;

  // A knex-shaped double for the REAL probeMoveConflicts: the visit query
  // returns `visitRows`, and the interview read (db.raw) returns
  // `interviewRows` — the job_applications shape bookedInterviewConflictRows
  // reads.
  function probeDb({ visitRows = [], interviewRows = [] } = {}) {
    const db = () => {
      const c = {};
      ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereRaw', 'leftJoin', 'orWhere', 'first']
        .forEach((m) => { c[m] = () => c; });
      c.select = () => ({ orderBy: async () => visitRows, then: (r) => r([]) });
      return c;
    };
    db.raw = jest.fn(async () => ({ rows: interviewRows }));
    return db;
  }

  test('a booked interview blocks a candidate — through the writer\'s own probeMoveConflicts (includeInterviews)', async () => {
    probeMoveConflicts.mockImplementation(realProbe);
    // 08:30-09:00 ET interview on 2026-08-06 (EDT) — occupies 08:15-09:15
    // with its buffers.
    const db = probeDb({ interviewRows: [{ id: 'app-1', interview_at: '2026-08-06T12:30:00Z', interview_end_at: '2026-08-06T13:00:00Z' }] });
    const service = { id: 's1', window_start: '09:00', estimated_duration_minutes: 60 };
    const candidates = [
      { technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' }, // overlaps the interview
      { technician_id: 't1', date: '2026-08-06', start_time: '10:00', end_time: '11:00' }, // clear
    ];
    const drops = { slot_taken: 0 };
    const kept = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, candidates, { db }, drops);
    expect(kept.map((k) => k.start_time)).toEqual(['10:00']);
    expect(drops.slot_taken).toBe(1);
    expect(db.raw).toHaveBeenCalledTimes(1); // one interview read for the date, not one per candidate
  });

  test('a PRECEDING sibling\'s collision blocks the candidate even when the primary\'s own window is clear', async () => {
    // Sibling 08:00-09:00 ahead of the primary's 09:00. Moving the primary to
    // 11:00 shifts the sibling by the same +2h, to 10:00-11:00.
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    const db = groupDb([{ id: 'sib1', window_start: '08:00', window_end: '09:00', estimated_duration_minutes: 60 }]);
    // Another job at 10:00-10:30 collides with the sibling's derived window
    // only — never with the primary's requested 11:00-12:00.
    probeMoveConflicts.mockResolvedValue({ rows: [conflictRow('10:00', '10:30')], snapshot: [] });
    const service = { id: 's1', visit_id: 'v1', window_start: '09:00', estimated_duration_minutes: 60 };
    const candidates = [{ technician_id: 't1', date: '2026-08-06', start_time: '11:00', end_time: '12:00' }];
    const drops = { slot_taken: 0 };
    const kept = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, candidates, { db: withVisit(db) }, drops);
    expect(kept).toHaveLength(0);
    expect(drops.slot_taken).toBe(1);
  });

  test('co-timed overlapping sibling windows do NOT falsely reject — the members\' own rows are excluded exactly as the unit move excludes them', async () => {
    // A combo booking: both members 09:00-10:00, occupying 09:00-11:00 on the
    // date between them. The date's occupancy holds BOTH members' current
    // rows plus an unrelated 13:00 job.
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    const db = groupDb([{ id: 'sib1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }]);
    const dateRows = [
      { ...conflictRow('09:00', '11:00'), id: 's1' },
      { ...conflictRow('09:00', '11:00'), id: 'sib1' },
      { ...conflictRow('13:00', '14:00'), id: 'other' },
    ];
    // Honors excludeServiceIds the way findConflictingVisits' WHERE does.
    probeMoveConflicts.mockImplementation(async ({ excludeServiceIds }) => ({
      rows: dateRows.filter((r) => !excludeServiceIds.includes(r.id)), snapshot: [],
    }));
    const service = { id: 's1', visit_id: 'v1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 };
    const candidates = [
      { technician_id: 't1', date: '2026-08-06', start_time: '10:00', end_time: '11:00' }, // both members land co-timed, overlapping their own old rows
      { technician_id: 't1', date: '2026-08-06', start_time: '13:00', end_time: '14:00' }, // collides with the unrelated job
    ];
    const drops = { slot_taken: 0 };
    const kept = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, candidates, { db: withVisit(db) }, drops);
    expect(kept.map((k) => k.start_time)).toEqual(['10:00']);
    expect(drops.slot_taken).toBe(1);
  });

  test('planUnitPlacement: the writer\'s own spans — an open end probes the duration (else one hour); a group probes each member\'s derived window', () => {
    const cand = { date: '2026-08-06', start_time: '10:00', end_time: null };
    expect(planUnitPlacement({ id: 's1', estimated_duration_minutes: 45 }, {}, cand))
      .toEqual({ windows: [{ start: '10:00', end: '10:45' }], targets: [{ id: 's1', start: '10:00', end: null }] });
    expect(planUnitPlacement({ id: 's1' }, {}, cand).windows).toEqual([{ start: '10:00', end: '11:00' }]);
    const members = [
      { id: 's1', window_start: '09:00', window_end: '10:00' },
      { id: 'sib1', window_start: '10:00', window_end: null, estimated_duration_minutes: 30 },
      { id: 'sib2', window_start: null, window_end: null },
    ];
    expect(planUnitPlacement({ id: 's1', window_start: '09:00' }, { members }, { date: '2026-08-06', start_time: '13:00', end_time: '14:00' }))
      .toMatchObject({ windows: [{ start: '13:00', end: '14:00' }, { start: '14:00', end: '14:30' }] }); // windowless sib2 is not probed
  });

  // Codex r2 (PRRT_kwDOR3YQi86mQebG): a windowless tapped row anchors on the
  // visit's canonical start, exactly as moveVisitAsUnit does.
  test('a windowless tapped row shifts its siblings from the VISIT\'s start', () => {
    const members = [
      { id: 's1', window_start: null, window_end: null },
      { id: 'sib1', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 },
    ];
    const service = { id: 's1', window_start: null };
    const cand = { date: '2026-08-06', start_time: '11:00', end_time: '12:00' };
    expect(planUnitPlacement(service, { members, visitWindowStart: '09:00' }, cand).windows)
      .toEqual([{ start: '11:00', end: '12:00' }, { start: '11:00', end: '12:00' }]); // sibling +2h from the visit's 09:00
    expect(planUnitPlacement(service, { members, visitWindowStart: null }, cand)).toBeNull(); // the writer refuses: no anchor
  });

  // Codex r2 (PRRT_kwDOR3YQi86mQebH): a shifted sibling that fails the admin
  // window rules is refused, not only one crossing midnight.
  test('a sibling whose shifted window breaks the admin window rules rejects the candidate', () => {
    const members = [
      { id: 's1', window_start: '09:00', window_end: '10:00' },
      { id: 'sib1', window_start: '10:30', window_end: '11:30', estimated_duration_minutes: 60 }, // a legacy :30 sibling
    ];
    const service = { id: 's1', window_start: '09:00' };
    expect(planUnitPlacement(service, { members }, { date: '2026-08-06', start_time: '13:00', end_time: '14:00' })).toBeNull();
    const onTheHour = [members[0], { ...members[1], window_start: '10:00', window_end: '11:00' }];
    expect(planUnitPlacement(service, { members: onTheHour }, { date: '2026-08-06', start_time: '13:00', end_time: '14:00' })).not.toBeNull();
  });

  // Codex r2 (PRRT_kwDOR3YQi86mQebI): the unit is placed at its EARLIEST
  // start — a preceding sibling's — on both sides of the comparison.
  // Codex r5 (PRRT_kwDOR3YQi86mQ1x6): the moving unit's siblings carry their
  // own ordering keys as they will stand after the move.
  test('movedSiblings: each sibling at its predicted window, with the route_order the rebooker leaves it', () => {
    const sibling = { id: 'sib1', scheduled_date: '2026-08-06', technician_id: 't1', window_start: '08:00', window_end: '09:00', route_order: 1, created_at: '2026-07-01T00:00:00Z' };
    const placement = { targets: [{ id: 's1', start: '13:00', end: '14:00' }, { id: 'sib1', start: '12:00', end: '13:00' }] };
    const [sameDay] = movedSiblings([sibling], placement, { date: '2026-08-06', technician_id: 't1' });
    expect(sameDay).toMatchObject({ window_start: '12:00', window_end: '13:00', route_order: 1, created_at: '2026-07-01T00:00:00Z' });
    const [otherDay] = movedSiblings([sibling], placement, { date: '2026-08-07', technician_id: 't1' });
    expect(otherDay.route_order).toBeNull();
  });

  test('loadGroupContext reads each sibling\'s ordering keys (route_order, created_at, technician_id) for the unit\'s place in the sequence', async () => {
    openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]);
    let cols = null;
    const db = withVisit(() => {
      const c = {};
      c.whereIn = () => c;
      c.select = async (...selected) => { cols = selected; return []; };
      return c;
    });
    await loadGroupContext(db, { id: 's1', visit_id: 'v1' });
    expect(cols).toEqual(expect.arrayContaining(['route_order', 'created_at', 'technician_id', 'window_start', 'window_end']));
  });



});

// Codex pre-push P1: the visit group is read ONCE per evaluation, so the
// current placement and the candidates score the same unit even if the
// membership changes mid-evaluation; a later evaluation reads it afresh.
test('openMembers is read exactly once per evaluation; the current placement and the candidates share its excludeIds', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [{ date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '13:00', end_time: '14:00', detour_minutes: 1, total_drive_minutes: 5, stops_that_day: 0, score: 1 }],
  });
  // A second read would see a different unit (sib2 joined).
  openMembers.mockResolvedValueOnce([{ id: 's1' }, { id: 'sib1' }]).mockResolvedValue([{ id: 's1' }, { id: 'sib1' }, { id: 'sib2' }]);
  const dayStopExcludes = [];
  const db = withVisit(() => {
    const c = {};
    ['where', 'whereIn', 'whereNot', 'whereNotNull', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
    c.whereNotIn = (field, ids) => { if (field === 'scheduled_services.id') dayStopExcludes.push([...ids].sort()); return c; };
    c.select = async (...cols) => (cols[0] === 'id' ? [{ id: 'sib1', window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60 }] : []);
    return c;
  });
  const grouped = { ...SERVICE, visit_id: 'v1', window_start: '09:00', window_end: '10:00' };

  await findValidCandidateSlots(grouped, prefs, { ...ctxBase(), db });
  expect(openMembers).toHaveBeenCalledTimes(1);
  // Both sides' day-stop reads (the candidates' batch and the current day)
  // exclude the same unit.
  expect(dayStopExcludes).toEqual([['s1', 'sib1'], ['s1', 'sib1']]);
  expect([...probeMoveConflicts.mock.calls[0][0].excludeServiceIds].sort()).toEqual(['s1', 'sib1']);

  // A later evaluation (the retry re-evaluation) reads the group afresh, once.
  await findValidCandidateSlots(grouped, prefs, { ...ctxBase(), db });
  expect(openMembers).toHaveBeenCalledTimes(2);
  openMembers.mockReset();
});

// Codex pre-push P1: group siblings are excluded from the day's stops because
// they move with the visit, so both the current placement and every candidate
// must charge their work as part of the moving unit.
test('a grouped visit charges its siblings\' planning minutes on both the current placement and the candidate', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const sibling = { id: 'sib1', window_start: '10:00', window_end: '10:45', estimated_duration_minutes: 45, service_type: 'Lawn', is_recurring: false, is_callback: false };
  let siblingSelect = null;
  const db = () => {
    const c = {};
    ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async (...cols) => {
      if (cols[0] === 'id') { siblingSelect = cols; return [sibling]; }
      return [];
    };
    return c;
  };
  const grouped = { ...SERVICE, visit_id: 'v1', window_start: '09:00', window_end: '10:00' };
  const cand = [{ technician_id: 't1', date: '2026-08-06', start_time: '13:00', end_time: '14:00' }];
  const geo = { lat: SERVICE.lat, lng: SERVICE.lng };

  openMembers.mockResolvedValue([{ id: 's1' }, { id: 'sib1' }]);
  const vdb = withVisit(db);
  const [groupedCand] = await filterAndScoreSharedModelCandidates(grouped, geo, cand, { db: vdb }, {});
  const groupedCurrent = await computeCurrentPlacement(grouped, prefs, { ...ctxBase(), db: vdb });
  openMembers.mockResolvedValue([{ id: 's1' }]);
  const [aloneCand] = await filterAndScoreSharedModelCandidates(grouped, geo, cand, { db: vdb }, {});
  const aloneCurrent = await computeCurrentPlacement(grouped, prefs, { ...ctxBase(), db: vdb });
  openMembers.mockReset();

  expect(siblingSelect).toEqual(expect.arrayContaining(['service_type', 'is_recurring', 'is_callback', 'estimated_duration_minutes']));
  expect(groupedCand.route_minutes - aloneCand.route_minutes).toBeCloseTo(45, 5);
  expect(groupedCurrent.route_minutes - aloneCurrent.route_minutes).toBeCloseTo(45, 5);
  expect(groupedCand.detour_minutes).toBeCloseTo(aloneCand.detour_minutes, 5);
});

// Pre-push P1 (PRRT_kwDOR3YQi86mQsaf): a candidate is scored with the
// route_order the visit will actually carry after the move.
test('candidateRouteOrder: kept on a same-day, same-tech move; cleared on a date or technician change (as the rebooker does)', () => {
  const svc = { scheduled_date: '2026-08-06', technician_id: 't1', route_order: 3 };
  expect(candidateRouteOrder(svc, { date: '2026-08-06', technician_id: 't1' })).toBe(3);
  expect(candidateRouteOrder(svc, { date: '2026-08-07', technician_id: 't1' })).toBeNull();
  expect(candidateRouteOrder(svc, { date: '2026-08-06', technician_id: 't2' })).toBeNull();
});

// Codex r4 (PRRT_kwDOR3YQi86mQsaf / PRRT_kwDOR3YQi86mQsai): the day-stop rows
// carry the canonical sequence keys and the co-visit identity inputs, so a
// real legacy co-visit pair on a candidate day scores as ONE stop.
test('day-stop rows carry route_order/created_at and the co-visit inputs — a legacy co-visit pair costs what one stop does', async () => {
  const coVisit = (id) => ({
    id, visit_id: null, customer_id: 'c9', status: 'confirmed', window_start: '10:00', window_end: '11:00', estimated_duration_minutes: null,
    route_order: 1, created_at: '2026-07-01T12:00:00Z', svc_lat: 27.45, svc_lng: -82.45,
    service_address_line1: '12 Palm Way', service_address_line2: null, service_address_city: 'Bradenton', service_address_zip: '34203', ...SLOT_KEY,
  });
  const dbWith = (rows) => () => {
    const c = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => rows;
    return c;
  };
  const cand = [{ technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' }];
  const service = { id: 's1', estimated_duration_minutes: 60 };
  const [pair] = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, cand, { db: dbWith([coVisit('p'), coVisit('l')]) }, {});
  const [single] = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, cand, { db: dbWith([coVisit('p')]) }, {});
  expect(pair.route_minutes).toBeCloseTo(single.route_minutes, 5);
  expect(pair.detour_minutes).toBeCloseTo(single.detour_minutes, 5);
});

// Codex r1 (PRRT_kwDOR3YQi86mPzgn): the owner planning minutes of the day's
// stops reach the comparison through route_minutes.
test('route_minutes charges the owner planning table: a planning-table change moves the candidate\'s cost', async () => {
  const pestStop = {
    id: 'p1', window_start: '10:00', window_end: '11:00', status: 'confirmed', service_type: 'Quarterly Pest Control Service',
    is_recurring: true, estimated_duration_minutes: 60, svc_lat: 27.4, svc_lng: -82.5, ...SLOT_KEY,
  };
  const db = () => {
    const c = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => [pestStop];
    return c;
  };
  const cand = [{ technician_id: 't1', date: '2026-08-06', start_time: '08:00', end_time: '09:00' }];
  const service = { id: 's1', estimated_duration_minutes: 60 };
  const ORIGINAL_CAPACITY = process.env.GATE_SCHEDULING_CAPACITY;
  try {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const [legacy] = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, cand, { db }, {});
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const [planned] = await filterAndScoreSharedModelCandidates(service, { lat: 27.4, lng: -82.5 }, cand, { db }, {});
    expect(legacy.route_minutes - planned.route_minutes).toBeCloseTo(60 - 25, 5); // recurring pest plans at 25, not its 60-min estimate
    expect(legacy.detour_minutes).toBeCloseTo(planned.detour_minutes, 5);
  } finally {
    if (ORIGINAL_CAPACITY === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = ORIGINAL_CAPACITY;
  }
});
