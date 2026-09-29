/**
 * Codex r7 P1 on #5310: packCapacityEnds' own clearsTravelGap and
 * capacityGapNeighbours were second, independently incomplete copies of
 * travel-gap.js's own before/after grace split and group-combination —
 * missing finding #1 (no HQ-seed for a first-of-day capacity candidate, so
 * a graced offer could quietly promise a start the tech's real HQ arrival
 * can't honor) and finding #2 (a visit_id neighbour read back as one
 * member's own un-combined window/credit, not the group's true combined
 * span). Both now route through the SAME shared functions
 * (classifyStopsAroundCandidate / projectGraceForCandidate / projectDayChain)
 * the commit-side probe (occupancy.js's findConflictingVisitsWithTravel)
 * uses. evaluateGap/toPackingBoundAnchor (legacy, non-capacity offer
 * geometry) had the identical finding-#2 gap for a visit_id neighbour.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Every leg (HQ<->candidate, candidate<->stop) resolves to the SAME uniform
// drive time — haversine ignores its real coordinate args and always
// reports 20 straight-line miles, which the real (unmocked)
// milesToDriveMinutes model turns into a clean, checkable 56 minutes (same
// precedent as find-time-hq-leading-gap-grace.test.js).
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 20,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { _internals } = require('../services/scheduling/find-time');
const {
  capacityGapNeighbours, packCapacityEnds, toPackingBoundAnchor, capacityNeighbourEntity,
} = _internals;
const { travelGapConflicts, projectDayChain } = require('../services/scheduling/travel-gap');
const { ensureCatalogLoaded, clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  clearExpectedServiceMinutesCache();
  // No catalog match anywhere -> every credit falls back to the plain
  // window length (zero padding) — deterministic, hand-checkable arithmetic.
  db.mockImplementation((table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    return { select: async () => [] };
  });
  await ensureCatalogLoaded(db);
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const DATE = '2099-01-05';
const TECH = { id: 'tech-1', name: 'Adam' };
const COORDS = { lat: 27.4, lng: -82.4 };

function visitMember(id, start, end, extra = {}) {
  return {
    id, scheduled_date: DATE, technician_id: TECH.id, status: 'confirmed',
    window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null, lat: COORDS.lat, lng: COORDS.lng,
    visit_id: 'visit-group-1', customer_id: 'cust-1', ...extra,
  };
}

describe('capacityGapNeighbours resolves a visit_id group to its combined span (finding #2, capacity mode)', () => {
  test('a staggered two-member visit_id group returns the GROUP\'s combined startMin/endMin, not one member\'s own', () => {
    const m1 = visitMember('m1', '09:00', '10:00'); // 540-600
    const m2 = visitMember('m2', '09:30', '11:00'); // 570-660
    const context = { rows: [m1, m2], target: { id: 'candidate' } };
    const fit = { routeOrder: ['m1', 'm2', 'candidate'] };
    // Candidate starts after both members -> the group anchors as `prev`.
    const { prevId, prevRow, nextId, nextRow } = capacityGapNeighbours(context, fit, 700);
    expect(prevId).toBe('m2'); // the later-starting member is the last anchor <= 700
    expect(nextId).toBeNull();
    expect(nextRow).toBeNull();
    // The GROUP's combined span (min start, max end) — not m2's own 570-660.
    expect(prevRow.startMin).toBe(540);
    expect(prevRow.endMin).toBe(660);
  });

  test('the same group resolved as the `next` neighbour also reads the combined span', () => {
    const m1 = visitMember('m1', '09:00', '10:00');
    const m2 = visitMember('m2', '09:30', '11:00');
    const context = { rows: [m1, m2], target: { id: 'candidate' } };
    const fit = { routeOrder: ['m1', 'm2', 'candidate'] };
    const { prevId, nextId, nextRow } = capacityGapNeighbours(context, fit, 500);
    expect(prevId).toBeNull();
    expect(nextId).toBe('m1'); // the earlier-starting member is the first anchor > 500
    expect(nextRow.startMin).toBe(540);
    expect(nextRow.endMin).toBe(660);
  });

  test('never chains another technician\'s rows into this candidate\'s day', () => {
    const mine = visitMember('mine', '09:00', '10:00', { visit_id: null });
    const other = visitMember('other', '08:00', '09:00', { visit_id: null, technician_id: 'tech-2' });
    const context = { rows: [mine, other], target: { id: 'candidate' } };
    const fit = { routeOrder: ['mine', 'candidate'] }; // tech-2's row never appears in this tech's routeOrder
    const { prevId, nextId } = capacityGapNeighbours(context, fit, 700);
    expect(prevId).toBe('mine');
    expect(nextId).toBeNull(); // tech-2's row is correctly excluded, not chained in as a neighbour
  });
});

describe('capacityNeighbourEntity reads a combined group\'s own authoritative `hold`', () => {
  test('a visit_id group with a live hold member carries hold:true through to the travel-gap entity', () => {
    const committed = visitMember('m1', '09:00', '10:00');
    const hold = visitMember('m2', '09:30', '11:00', { customer_id: null, reservation_expires_at: new Date(Date.now() + 600000).toISOString() });
    const { combinedByStop } = projectDayChain([
      { ...committed, allocationKey: null },
      { ...hold, allocationKey: null },
    ].map((row) => ({ ...row, startMin: row.window_start === '09:00' ? 540 : 570, endMin: row.window_start === '09:00' ? 600 : 660 })));
    const combined = [...combinedByStop.values()][0];
    expect(combined.hold).toBe(true); // ANY member holding makes the whole group a hold
    const entity = capacityNeighbourEntity(combined);
    expect(entity.hold).toBe(true); // survives capacityNeighbourEntity's own reshape
  });
});

describe('toPackingBoundAnchor (legacy offer geometry) reads a visit_id group\'s combined window/expected minutes (finding #2)', () => {
  test('a member stamped with the group\'s combinedByStop reads the GROUP\'s window/credit, not its own', () => {
    const m1 = { id: 'm1', startMin: 540, endMin: 600, expectedMinutes: 50, visit_id: 'g1', allocationKey: null, lat: COORDS.lat, lng: COORDS.lng, arrivalMin: 545, hold: false };
    const m2 = { id: 'm2', startMin: 570, endMin: 660, expectedMinutes: 80, visit_id: 'g1', allocationKey: null, lat: COORDS.lat, lng: COORDS.lng, arrivalMin: 545, hold: false };
    const { combinedByStop } = projectDayChain([m1, m2]);
    const anchor = toPackingBoundAnchor(m1, combinedByStop);
    expect(anchor.rawStartMin).toBe(540); // combined MIN start across both members
    expect(anchor.rawEndMin).toBe(660);   // combined MAX end across both members
    // Combined SUM of each member's own credit is 50+80=130, clamped to the
    // combined window's own 120 minutes (540-660) — toPackingBoundAnchor
    // never credits more than the window itself allows.
    expect(anchor.expectedEndMin).toBe(540 + 120);
    // arrivalMin/hold are the member's OWN fields (already the group's
    // shared value via buildDayStops' arrivalByStop overlay) — never
    // overwritten by this fix.
    expect(anchor.arrivalMin).toBe(545);
    expect(anchor.hold).toBe(false);
  });

  test('grace 0 (no combinedByStop passed at all) stays byte-identical to the member\'s own individual window', () => {
    const m1 = { id: 'm1', startMin: 540, endMin: 600, expectedMinutes: 50, visit_id: 'g1', lat: COORDS.lat, lng: COORDS.lng };
    const anchor = toPackingBoundAnchor(m1);
    expect(anchor.rawStartMin).toBe(540);
    expect(anchor.rawEndMin).toBe(600);
    expect(anchor.expectedEndMin).toBe(540 + 50);
  });

  test('an allocationKey (v2) member is unaffected either way — already pre-expanded to the same combined shape', () => {
    const m1 = { id: 'm1', startMin: 540, endMin: 660, expectedMinutes: 90, allocationKey: 'alloc-1', visit_id: null, lat: COORDS.lat, lng: COORDS.lng };
    const m2 = { id: 'm2', startMin: 540, endMin: 660, expectedMinutes: 90, allocationKey: 'alloc-1', visit_id: null, lat: COORDS.lat, lng: COORDS.lng };
    const { combinedByStop } = projectDayChain([m1, m2]);
    const withMap = toPackingBoundAnchor(m1, combinedByStop);
    const withoutMap = toPackingBoundAnchor(m1);
    expect(withMap).toEqual(withoutMap);
  });
});

// Finding #1: a first-of-day capacity candidate (no before-neighbour at
// all) with a real stop after it. candidate 08:20-09:20 (500-560,
// duration/expected 60, zero padding), next stop 11:00-12:00 (660-720).
// HQ-seed floor: SHIFT.startMinutes (480) + driveMin(HQ, candidate) (56,
// mocked) = 536 -> the tech's REAL arrival is 36 minutes later than the
// offered 08:20 start. Required gap (drive 56 + buffer 15, zero padding
// either way since it floors at 0) = 71.
//   BUGGY (arrival left at candidate.startMin=500): effectiveEnd=560,
//     gap to next = 660-560=100 >= 71 -> PASSES (wrongly offers the slot).
//   FIXED (arrival HQ-seeded to 536): effectiveEnd=596,
//     gap to next = 660-596=64 < 71 -> REJECTS (the tech genuinely can't
//     make it in time) — the correct, customer-safe verdict.
describe('packCapacityEnds seeds a first-of-day candidate\'s real arrival from HQ (finding #1, capacity mode, LIVE)', () => {
  const nextRow = { id: 'next', startMin: 660, endMin: 720, lat: COORDS.lat, lng: COORDS.lng, expectedMinutes: 60 };
  const baseSlot = {
    date: DATE, technician: { id: TECH.id }, start_time: '08:20', end_time: '09:20',
    _gap: { prevId: null, nextId: 'next', prevRow: null, nextRow },
  };
  const caller = {
    lat: COORDS.lat, lng: COORDS.lng, durationMinutes: 60, expectedMinutes: 60, graceMinutes: 30, today: '2098-01-01',
  };

  test('grace > 0: rejected — the tech\'s real HQ arrival would violate the gap to the after-side neighbour', () => {
    const kept = packCapacityEnds([baseSlot], caller);
    expect(kept).toHaveLength(0);
  });

  test('grace 0: byte-identical to before this lane — no HQ lateness is ever considered', () => {
    const kept = packCapacityEnds([baseSlot], { ...caller, graceMinutes: 0 });
    expect(kept).toHaveLength(1);
  });
});

// Offer/commit parity — the SAME candidate/neighbour shapes evaluated by
// find-time's offer-side packCapacityEnds and travel-gap.js's own
// commit-side travelGapConflicts (what occupancy.js's
// findConflictingVisitsWithTravel calls) must agree.
describe('offer/commit parity', () => {
  test('finding #1 shape: packCapacityEnds and travelGapConflicts agree (both reject)', () => {
    const candidate = {
      startMin: 500, endMin: 560, lat: COORDS.lat, lng: COORDS.lng, windowMinutes: 60, expectedMinutes: 60, graceMinutes: 30,
    };
    const nextStop = {
      startMin: 660, endMin: 720, lat: COORDS.lat, lng: COORDS.lng, windowMinutes: 60, expectedMinutes: 60,
    };
    const commitConflicts = travelGapConflicts(candidate, [nextStop]);
    const commitRejects = commitConflicts.some((c) => c.reason !== 'day_end'); // offer handles day-end separately
    const nextRow = { id: 'next', startMin: 660, endMin: 720, lat: COORDS.lat, lng: COORDS.lng, expectedMinutes: 60 };
    const baseSlot = {
      date: DATE, technician: { id: TECH.id }, start_time: '08:20', end_time: '09:20',
      _gap: { prevId: null, nextId: 'next', prevRow: null, nextRow },
    };
    const caller = {
      lat: COORDS.lat, lng: COORDS.lng, durationMinutes: 60, expectedMinutes: 60, graceMinutes: 30, today: '2098-01-01',
    };
    const offerRejects = packCapacityEnds([baseSlot], caller).length === 0;
    expect(commitRejects).toBe(true);
    expect(offerRejects).toBe(commitRejects);
  });

  test('finding #2 shape: a visit_id group neighbour — capacity-mode offer and the commit predicate agree', () => {
    // Group: m1 09:00-10:00 (540-600), m2 09:30-11:00 (570-660, staggered) —
    // combined span 540-660, combined credit 60+90=150 (no catalog match,
    // so each member's own credit is its own raw window length).
    const m1 = visitMember('m1', '09:00', '10:00');
    const m2 = visitMember('m2', '09:30', '11:00');
    // Candidate right after the group's TRUE combined end (660), inside
    // what m2's own un-combined end (660) would ALSO already cover — pick a
    // candidate that only the group's full combined span protects: starts
    // at 660 itself is exactly at m2's own end, so use a stop shape whose
    // credit differs from a single member's own to prove the SUM is used.
    const candidate = {
      startMin: 665, endMin: 700, lat: COORDS.lat, lng: COORDS.lng, windowMinutes: 35, expectedMinutes: 35, graceMinutes: 20,
    };
    // Commit side: hand travelGapConflicts the RAW members (allocationKey
    // null, visit_id set) — it groups them itself via projectDayChain.
    const commitStops = [m1, m2].map((row) => ({
      startMin: row.window_start === '09:00' ? 540 : 570,
      endMin: row.window_start === '09:00' ? 600 : 660,
      lat: row.lat, lng: row.lng,
      expectedMinutes: row.window_start === '09:00' ? 60 : 90,
      visit_id: row.visit_id, allocationKey: null,
    }));
    const commitConflicts = travelGapConflicts(candidate, commitStops);
    const commitRejects = commitConflicts.some((c) => c.reason !== 'day_end');
    // Offer side: capacityGapNeighbours resolves the SAME group to its
    // combined entity, then packCapacityEnds checks the candidate against it.
    const context = { rows: [m1, m2], target: { id: 'candidate' } };
    const fit = { routeOrder: ['m1', 'm2', 'candidate'] };
    const { prevId, prevRow } = capacityGapNeighbours(context, fit, candidate.startMin);
    expect(prevId).toBe('m2');
    const baseSlot = {
      date: DATE, technician: { id: TECH.id }, start_time: '11:05', end_time: '11:40',
      _gap: { prevId, nextId: null, prevRow, nextRow: null },
    };
    const caller = {
      lat: COORDS.lat, lng: COORDS.lng, durationMinutes: 35, expectedMinutes: 35, graceMinutes: 20, today: '2098-01-01',
    };
    const offerRejects = packCapacityEnds([baseSlot], caller).length === 0;
    expect(offerRejects).toBe(commitRejects);
  });
});
