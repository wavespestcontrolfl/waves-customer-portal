// GATE_AUTO_DISPATCH_SHARED_MODEL applied inside findValidCandidateSlots /
// computeCurrentPlacement: candidates the rebooker's writer would refuse
// (SLOT_TAKEN) are dropped before scoring, survivors are re-scored on the
// shared route-cost/cluster model, and gate off stays byte-identical to
// today (2026-09-26 incident: 17 applied, 72 SLOT_TAKEN under the legacy
// candidate generation).
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');

const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
const ORIGINAL_SHARED_GATE = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
beforeEach(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; jest.clearAllMocks(); });
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

// Sequenced db mock: call 1 = sibling-date query (none), call 2 = day-stops
// for the FIRST candidate's (tech,date) (an overlapping stop — SLOT_TAKEN),
// call 3 = day-stops for the SECOND candidate's (tech,date) (a clear day),
// call 4 = computeCurrentPlacement's own neighbor query (none).
function sequencedDb() {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (n === 1) return []; // sibling query
      if (n === 2) {
        // overlapping existing stop on the first candidate's day/tech
        return [{
          id: 'blocker', window_start: '08:00', window_end: '09:00', status: 'confirmed',
          estimated_duration_minutes: 60, svc_lat: 27.39, svc_lng: -82.39,
        }];
      }
      if (n === 3) {
        // a clear day with one distant stop (no overlap with 08:00-09:00)
        return [{
          id: 'other', window_start: '13:00', window_end: '14:00', status: 'confirmed',
          estimated_duration_minutes: 60, svc_lat: 27.41, svc_lng: -82.51,
        }];
      }
      return []; // current-placement neighbor query
    };
    return c;
  };
}

test('gate ON: drops a SLOT_TAKEN candidate and re-scores the survivor on the shared model', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  findAvailableSlots.mockResolvedValue({
    slots: [
      { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1 },
      { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 },
    ],
  });
  const db = sequencedDb();
  const { candidates, current, drops } = await findValidCandidateSlots(SERVICE, prefs, { ...ctxBase(), db });

  expect(candidates).toHaveLength(1);
  expect(candidates[0].date).toBe('2026-08-06');
  expect(candidates[0].model).toBe('shared_v1');
  expect(Number.isFinite(candidates[0].same_area_share)).toBe(true);
  expect(drops.slot_taken).toBe(1);
  expect(current.model).toBe('shared_v1');
});

test('gate OFF: no overlap pre-filter, no shared-model fields, byte-identical to legacy candidate output', async () => {
  delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  findAvailableSlots.mockResolvedValue({
    slots: [
      { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 1, score: 1 },
      { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 },
    ],
  });
  // Only 2 db calls expected (sibling query + current-placement neighbors) —
  // the shared-model day-stops queries never run.
  let calls = 0;
  const db = () => {
    calls += 1;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
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
});

// Sequenced db mock for a SINGLE candidate: call 1 = sibling-date query
// (none), call 2 = day-stops for the candidate's (tech,date) — `dayStops`,
// call 3 = computeCurrentPlacement's own neighbor query (none).
function singleCandidateDb(dayStops) {
  let call = 0;
  return () => {
    call += 1;
    const n = call;
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => {
      if (n === 1) return [];
      if (n === 2) return dayStops;
      return [];
    };
    return c;
  };
}

// Codex pre-push P1 (2026-09-26): loadDayStops fetched expired estimate-slot
// holds and no_show rows — invisible to the overlap predicate already, but
// routeCost/clusterShare had no exclusion of their own, so a day whose only
// "stops" were inactive read as near-zero detour and fully clustered.
test('a day whose only stops are an expired hold + a no_show scores IDENTICALLY to a genuinely empty day', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const SLOT = { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 1, score: 2 };

  // Sitting right on top of the candidate's own location — if either row
  // wrongly counted, it would score a near-zero detour and full cluster
  // credit. Same time window as the candidate too, to also confirm neither
  // wrongly blocks the candidate as SLOT_TAKEN.
  const expiredHoldRow = {
    id: 'expired-hold', window_start: '08:00', window_end: '09:00', status: 'confirmed',
    reservation_expires_at: new Date(Date.now() - 60000).toISOString(),
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng,
  };
  const noShowRow = {
    id: 'no-show', window_start: '08:00', window_end: '09:00', status: 'no_show',
    estimated_duration_minutes: 60, svc_lat: SERVICE.lat, svc_lng: SERVICE.lng,
  };

  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: withInactiveOnly } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: singleCandidateDb([expiredHoldRow, noShowRow]) },
  );

  jest.clearAllMocks();
  findAvailableSlots.mockResolvedValue({ slots: [SLOT] });
  const { candidates: empty } = await findValidCandidateSlots(
    SERVICE, prefs, { ...ctxBase(), db: singleCandidateDb([]) },
  );

  expect(withInactiveOnly).toHaveLength(1); // neither row wrongly triggers SLOT_TAKEN
  expect(empty).toHaveLength(1);
  expect(withInactiveOnly[0].detour_minutes).toBe(empty[0].detour_minutes);
  expect(withInactiveOnly[0].total_drive_minutes).toBe(empty[0].total_drive_minutes);
  // Cluster share must read as an EMPTY day (0), not fully clustered (the
  // mocked haversine below always reports every pair as "close").
  expect(withInactiveOnly[0].same_area_share).toBe(0);
  expect(empty[0].same_area_share).toBe(0);
});

test('computeCurrentPlacement: a current-day expired hold / no_show does not count toward detour or clustering', async () => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  const { computeCurrentPlacement } = require('../services/auto-dispatch/candidate-slots');

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
    ['where', 'whereNot', 'whereNotIn', 'leftJoin'].forEach((m) => { c[m] = () => c; });
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
