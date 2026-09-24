/**
 * find-time packEnds (owner bug report 2026-09-23): on a day with real
 * stops, customer-facing callers get BOTH the earliest-after-prev and
 * latest-before-next packed candidates per gap (one when they coincide),
 * restricted to the end(s) that actually border a stop — instead of the
 * single earliest-feasible-minute candidate that let a leading gap always
 * promote a hole-making 9 AM. Legacy (packEnds omitted) and empty-day
 * output stay byte-identical.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
// Zero-mile legs -> zero modeled drive minutes, so every candidate boundary
// is pure buffer/padding arithmetic (matches the picker-sim harness, whose
// scenarios put the customer and the neighbouring stop in the same city).
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 0,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { customerFacingBufferMinutes } = require('../services/scheduling/travel-gap');
const { clearExpectedServiceMinutesCache, ensureCatalogLoaded } = require('../services/scheduling/expected-service-minutes');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  clearExpectedServiceMinutesCache();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function chain(result) {
  const c = {};
  ['whereNotNull', 'whereNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
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
const BASE = { lat: 27.4, lng: -82.4, durationMinutes: 60, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 200 };

const STOP_COORDS = { svc_lat: 27.4, svc_lng: -82.4, cust_lat: null, cust_lng: null };
function stopRow(id, start, end) {
  return {
    id, scheduled_date: FUTURE_DATE, technician_id: 't1',
    window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
    estimated_duration_minutes: null, ...STOP_COORDS,
    first_name: 'Existing', last_name: 'Stop', city: 'Lakewood Ranch',
  };
}

// No catalog row matches 'pest_control' (bare service_type, no key) — every
// stop and the candidate itself fall back to their own window length, i.e.
// zero padding, the plain drive(0)+buffer(15) gap.
const NO_CATALOG_ROWS = [];
// A quarterly-pest catalog row (min 30 / max 60 -> expected 45) keyed by
// name, matched via services.name = scheduled_services.service_type/opts.serviceType.
const QUARTERLY_PEST_CATALOG = [{
  service_key: 'quarterly_pest', name: 'pest_control',
  min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null,
}];

function wireDb({ stops, catalog }) {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Adam' }]);
    if (table === 'services') return chain(catalog);
    return chain(stops); // scheduled_services
  });
}

describe('H1 — leading gap (day-open before the first stop)', () => {
  const stops = [
    stopRow('s1', '12:00', '13:00'),
    stopRow('s2', '13:00', '14:00'),
    stopRow('s3', '15:00', '16:00'),
    stopRow('s4', '16:00', '17:00'),
  ];

  test('OLD gap rule (no catalog match): the leading gap packs to 10:00 — 9:00 is never offered', async () => {
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    expect(slots.some((s) => s.start_time === '09:00')).toBe(false);
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading.map((s) => s.start_time)).toEqual(['10:00']);
  });

  test('NEW expected-minutes rule (quarterly-pest catalog match): the leading gap packs to 11:00', async () => {
    wireDb({ stops, catalog: QUARTERLY_PEST_CATALOG });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceType: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    expect(slots.some((s) => s.start_time === '09:00')).toBe(false);
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    expect(leading.map((s) => s.start_time)).toEqual(['11:00']);
  });
});

describe('leading gap capped against the next real window when expected < full duration (Codex r4 P1)', () => {
  // A termite-inspection catalog row (min 30 / max 90 -> expected 60) for a
  // 90-minute offered candidate: candidatePadding = 90-60 = 30, so nextBuffer
  // collapses to 0 and the credit-only bound (latestEndFloor -
  // candidateExpectedMinutes) lands at 11:00 — but the candidate's REAL
  // window is still the full 90 minutes (makeCandidate uses durationMinutes,
  // never the credited figure), so an 11:00 start's real end (12:30)
  // overlaps the noon stop it is supposedly packed before. The bound must
  // also respect next.startMin - durationMinutes (630 = 10:30, floored to
  // 10:00) so the offered start's real window never reaches the next stop.
  const CANDIDATE_CATALOG = [{
    service_key: 'termite_inspection', name: 'Termite Inspection Service',
    min_duration_minutes: 30, max_duration_minutes: 90, default_duration_minutes: null,
  }];
  const stops = [stopRow('s1', '12:00', '13:00')];

  test('a 90-minute candidate credited only 60 expected minutes never overlaps the noon stop\'s real window', async () => {
    wireDb({ stops, catalog: CANDIDATE_CATALOG });
    const { slots } = await findAvailableSlots({
      ...BASE, durationMinutes: 90, packEnds: true, serviceKey: 'termite_inspection',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    const leading = slots.filter((s) => s.insertion.after_stop_id == null && s.insertion.before_stop_id === 's1');
    // Before the fix, the only "packed before s1" candidate was 11:00 (real
    // end 12:30 — overlapping s1's real 12:00 start); a downstream overlap
    // check would reject it with no fallback, so this side of the gap
    // vanished entirely instead of falling back to 10:00.
    expect(leading.map((s) => s.start_time)).toEqual(['10:00']);
    for (const slot of leading) {
      const [h, m] = slot.end_time.split(':').map(Number);
      expect(h * 60 + m).toBeLessThanOrEqual(12 * 60); // never runs into the stop's real 12:00 start
    }
  });
});

describe('H5 — middle gap (idle time between two stops)', () => {
  const stops = [stopRow('s1', '09:00', '10:00'), stopRow('s2', '14:00', '15:00')];

  test('offers exactly the two packed ends (11:00 after s1, 12:00 before s2), never the hole-making hours between', async () => {
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    const middleGap = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2');
    expect(middleGap.map((s) => s.start_time).sort()).toEqual(['11:00', '12:00']);
  });
});

describe('trailing gap (last stop before day-close)', () => {
  test('offers ONLY its earliest packed start', async () => {
    wireDb({ stops: [stopRow('s1', '09:00', '10:00')], catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control',
      bufferMinutes: customerFacingBufferMinutes(),
    });
    const trailing = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id == null);
    expect(trailing.map((s) => s.start_time)).toEqual(['11:00']);
  });
});

describe('zero buffer still credits expected minutes for a customer-facing caller (Codex r4 P2)', () => {
  // SLOT_TRAVEL_BUFFER_MINUTES=0 is a supported, deliberate owner override
  // (travel-gap.js travelBufferMinutes()) — gate on, buffer explicitly
  // zeroed. travel-gap.js's effectiveEndMinutes/paddingMinutesOf are
  // buffer-agnostic — a stop's own catalog credit must still resolve for a
  // customer-facing (packEnds) caller even at buffer 0, or the commit
  // probes (which credit it regardless of buffer) disagree with the offer.
  const WIDE_CATALOG = [{
    service_key: 'wide_pest', name: 'pest_control',
    min_duration_minutes: 15, max_duration_minutes: 45, default_duration_minutes: null,
  }];
  const stops = [stopRow('s1', '10:00', '12:00')]; // 120-min window; expected 30 -> effective end 10:30

  test('the catalog credit still resolves at buffer 0, but the packed-after-prev bound never starts before the stop\'s RAW end (Codex r5 P1)', async () => {
    wireDb({ stops, catalog: WIDE_CATALOG });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control', bufferMinutes: 0, // explicit zero, NOT customerFacingBufferMinutes()
    });
    // wantsExpectedMinutesCredit engaged (buffer 0, but packEnds + gate on) —
    // proven structurally: the catalog was actually queried, not skipped
    // like a gate-off/staff caller.
    expect(db.mock.calls.map((c) => c[0])).toContain('services');
    // At zero modeled drive (this file's route-optimizer mock) AND zero
    // buffer, the credited bound (effectiveEnd + 0 drive + 0 buffer) never
    // exceeds the stop's own raw end, so packedBounds' Codex r5 P1 clamp
    // (earliest >= prev.rawEndMin) is what actually governs here: the
    // packed candidate can never start before the stop's PROMISED window
    // (10:00-12:00) truly closes, whatever the 30-minute credit optimistically
    // estimates — 11:00 would double-book a customer still legitimately
    // holding the slot until noon.
    const trailing = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id == null);
    expect(trailing.map((s) => s.start_time)).toEqual(['12:00']);
  });

  test('legacy callers (packEnds omitted) are unaffected by this gate — bufferMinutes 0 stays legacy geometry', async () => {
    wireDb({ stops, catalog: WIDE_CATALOG });
    const { slots } = await findAvailableSlots({ ...BASE, serviceKey: 'pest_control', bufferMinutes: 0 });
    // Legacy (non-packed) earliest-feasible-minute path: no credit either
    // way (stopBuffer is 0 and packEnds is not requested), byte-identical
    // to gate-off/staff-caller geometry.
    expect(slots.some((s) => s.insertion.after_stop_id === 's1' && s.start_time === '12:00')).toBe(true);
  });
});

describe('empty day (no stops at all)', () => {
  test('packEnds has no effect — the single exact-minute legacy candidate is unchanged', async () => {
    wireDb({ stops: [], catalog: NO_CATALOG_ROWS });
    const withPackEnds = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control', bufferMinutes: customerFacingBufferMinutes(),
    });
    const legacy = await findAvailableSlots({ ...BASE });
    expect(withPackEnds.slots).toHaveLength(1);
    expect(withPackEnds.slots[0].start_time).toBe('08:00');
    expect(withPackEnds.slots[0].stops_that_day).toBe(0);
    expect(legacy.slots[0].start_time).toBe('08:00');
  });
});

describe('legacy callers (packEnds omitted) stay byte-identical on a stop day', () => {
  test('every gap still emits exactly one earliest-feasible candidate', async () => {
    const stops = [stopRow('s1', '09:00', '10:00'), stopRow('s2', '14:00', '15:00')];
    wireDb({ stops, catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() });
    // Three gaps (leading, middle, trailing) -> one earliest-feasible
    // candidate each, EXCEPT the leading gap: an 08:00 start plus the
    // 60-min job plus the 15-min buffer would land past the 09:00 stop, so
    // it correctly yields none (legacy and packed-ends agree here).
    expect(slots).toHaveLength(2);
    const middleGap = slots.find((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2');
    expect(middleGap.start_time).toBe('10:15'); // 10:00 + 0 drive + 15 buffer, unsnapped
  });
});

describe('unassigned committed visits anchor the packing (Codex #4664 r2 P1)', () => {
  test('a technician_id NULL stop at 12:00 packs the leading gap to 10:00 for the tech instead of an open day', async () => {
    const unassigned = { ...stopRow('u1', '12:00', '13:00'), technician_id: null };
    wireDb({ stops: [unassigned], catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({ ...BASE, packEnds: true, bufferMinutes: customerFacingBufferMinutes() });
    const starts = slots.map((s) => s.start_time);
    expect(starts).toContain('10:00');
    expect(starts).not.toContain('09:00');
    expect(slots.every((s) => s.stops_that_day === 1)).toBe(true);
  });

  test('legacy callers (packEnds omitted) still ignore unassigned rows on a tech route', async () => {
    const unassigned = { ...stopRow('u1', '12:00', '13:00'), technician_id: null };
    wireDb({ stops: [unassigned], catalog: NO_CATALOG_ROWS });
    const { slots } = await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() });
    expect(slots.every((s) => s.stops_that_day === 0)).toBe(true);
  });
});

describe('packCapacityEnds — capacity results keep only the packed ends per gap (Codex #4664 r2 P1)', () => {
  const { packCapacityEnds } = require('../services/scheduling/find-time')._internals;
  const cap = (start, prevId, nextId, tech = 't1') => ({ date: '2026-10-01', technician: { id: tech }, start_time: start, _gap: { prevId, nextId } });

  test('leading gap keeps the latest hour, trailing the earliest, middle both, empty day everything', () => {
    const slots = [
      cap('09:00', null, 's1'), cap('10:00', null, 's1'), cap('11:00', null, 's1'), // before s1 → 11:00
      cap('14:00', 's1', 's2'), cap('15:00', 's1', 's2'), cap('16:00', 's1', 's2'), // between → 14:00 + 16:00
      cap('18:00', 's2', null), cap('19:00', 's2', null), // after s2 → 18:00
      cap('09:00', null, null, 't2'), cap('10:00', null, null, 't2'), // t2 empty day → both
    ];
    const kept = packCapacityEnds(slots).map((s) => `${s.technician.id}@${s.start_time}`);
    expect(kept).toEqual(['t1@11:00', 't1@14:00', 't1@16:00', 't1@18:00', 't2@09:00', 't2@10:00']);
  });

  // Codex r7 P1: findCapacitySlots' arrival-window route feasibility models
  // real drive but not the customer-facing travel-gap buffer/credit rule —
  // it can accept a start (10:00, touching a 09:00-10:00 stop) the
  // customer-facing gate would reject. Picking the packed endpoint BEFORE
  // that gate ran (the old order) locked in the rejected 10:00 with no
  // fallback, so the whole trailing gap looked unavailable even though
  // 11:00 — never tried, since the old code stopped after picking one
  // endpoint — clears the gate cleanly.
  test('a route-feasible but travel-gap-rejected packed endpoint is skipped in favor of the next feasible candidate', () => {
    const prevRow = { startMin: 540, endMin: 600, lat: 27.4, lng: -82.4, expectedMinutes: 60 };
    const capWithRow = (start, endTime) => ({
      date: '2026-10-01', technician: { id: 't1' }, start_time: start, end_time: endTime,
      _gap: { prevId: 's1', nextId: null, prevRow },
    });
    const slots = [capWithRow('10:00', '11:00'), capWithRow('11:00', '12:00')];
    // Co-located with the stop (zero modeled drive) and no catalog match on
    // either side — 10:00 touches the stop's raw end with 0 free minutes,
    // well under the 15-minute buffer; 11:00 clears it with 60 free minutes.
    const kept = packCapacityEnds(slots, { lat: 27.4, lng: -82.4, durationMinutes: 60 }).map((s) => s.start_time);
    expect(kept).toEqual(['11:00']);
  });

  test('gate off: the travel-gap filter never runs — the OLD packed pick (10:00) survives even though it would violate the gate', () => {
    const previous = process.env.GATE_SLOT_TRAVEL_GAP;
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    try {
      const prevRow = { startMin: 540, endMin: 600, lat: 27.4, lng: -82.4, expectedMinutes: 60 };
      const capWithRow = (start, endTime) => ({
        date: '2026-10-01', technician: { id: 't1' }, start_time: start, end_time: endTime,
        _gap: { prevId: 's1', nextId: null, prevRow },
      });
      const slots = [capWithRow('10:00', '11:00'), capWithRow('11:00', '12:00')];
      const kept = packCapacityEnds(slots, { lat: 27.4, lng: -82.4, durationMinutes: 60 }).map((s) => s.start_time);
      expect(kept).toEqual(['10:00']);
    } finally {
      if (previous === undefined) delete process.env.GATE_SLOT_TRAVEL_GAP;
      else process.env.GATE_SLOT_TRAVEL_GAP = previous;
    }
  });

  test('no survivors on a side: the group offers nothing from it, never a synthesized fallback', () => {
    // Both candidates for this trailing gap touch the stop — neither clears
    // the buffer, so this side of the group keeps nothing (consistent with
    // every other packed-ends rule in this codebase: no fallback fan-out).
    const prevRow = { startMin: 540, endMin: 600, lat: 27.4, lng: -82.4, expectedMinutes: 60 };
    const capWithRow = (start, endTime) => ({
      date: '2026-10-01', technician: { id: 't1' }, start_time: start, end_time: endTime,
      _gap: { prevId: 's1', nextId: null, prevRow },
    });
    const slots = [capWithRow('10:00', '11:00')];
    const kept = packCapacityEnds(slots, { lat: 27.4, lng: -82.4, durationMinutes: 60 });
    expect(kept).toEqual([]);
  });

  // Codex r8 P1: a v2 combined allocation's neighbour, as capacityGapNeighbours
  // now builds it — the allocation's real EXPANDED span (09:00-11:00) and
  // SUMMED credit (90), not one member's own raw 09:00-10:00 window. Before
  // this fix, the neighbour entity here would have been {startMin:540,
  // endMin:600, expectedMinutes:45} (one member's own window/credit), under
  // which 10:00 shows 15 free minutes against a 0-required gap (60-window
  // padding 15 == buffer 15) — no violation, so 10:00 was wrongly kept and
  // 11:00 (also fine, but later) was dropped, even though the real combined
  // job is still physically running from 09:00 to 11:00.
  test('a v2 combined allocation\'s neighbour genuinely occupies through its real span: 10:00 (real overlap) is rejected, 11:00 (the earliest real survivor) is kept', () => {
    const prevRow = { startMin: 540, endMin: 660, lat: 27.4, lng: -82.4, expectedMinutes: 90 };
    const capWithRow = (start, endTime) => ({
      date: '2026-10-01', technician: { id: 't1' }, start_time: start, end_time: endTime,
      _gap: { prevId: 'm1', nextId: null, prevRow },
    });
    const slots = [capWithRow('10:00', '11:00'), capWithRow('11:00', '12:00')];
    const kept = packCapacityEnds(slots, { lat: 27.4, lng: -82.4, durationMinutes: 60 }).map((s) => s.start_time);
    expect(kept).toEqual(['11:00']);
  });
});

describe('capacityGapNeighbours — unassigned blockers count as time-based anchors (Codex r3 P1)', () => {
  const { capacityGapNeighbours } = require('../services/scheduling/find-time')._internals;

  // Codex r8 P1: capacityGapNeighbours now expands context.rows itself
  // (occupiedRows + stopCreditResolver) instead of taking a caller-supplied
  // byId map, so prevRow/nextRow always resolve from context.rows — never
  // undefined for an id genuinely present there. The 3rd positional arg
  // (byId) is gone; these were the only caller and only tests of it.

  test('an unassigned-only day is NOT an empty-day gap identity: it anchors both sides by time', () => {
    // fit.routeOrder only ever carries the selected tech's OWN stops
    // (completed + pending + the candidate) — here the tech's own route is
    // empty aside from the candidate, so routeOrder alone would read as an
    // empty day even though the day has one real (unassigned) blocker at
    // noon.
    const context = {
      target: { id: '__candidate__' },
      rows: [{ id: 'u1', technician_id: null, status: 'confirmed', window_start: '12:00' }],
    };
    const fit = { routeOrder: ['__candidate__'] };
    // Candidate at 9:00 (before the blocker) → no prev, blocker is next.
    // No window_end/duration on u1 -> occupiedRows' 60-minute fallback span.
    const before = capacityGapNeighbours(context, fit, 9 * 60);
    expect(before.prevId).toBe(null);
    expect(before.nextId).toBe('u1');
    expect(before.prevRow).toBe(null);
    expect(before.nextRow).toMatchObject({ id: 'u1', startMin: 720, endMin: 780 });
    // Candidate at 14:00 (after the blocker) → blocker is prev, no next.
    const after = capacityGapNeighbours(context, fit, 14 * 60);
    expect(after.prevId).toBe('u1');
    expect(after.nextId).toBe(null);
    expect(after.prevRow).toMatchObject({ id: 'u1', startMin: 720, endMin: 780 });
    expect(after.nextRow).toBe(null);
  });

  test('merges the tech\'s own route (via routeOrder) with unassigned rows, sorted by time', () => {
    const context = {
      target: { id: '__candidate__' },
      rows: [
        { id: 'own-1', technician_id: 't1', status: 'confirmed', window_start: '09:00' },
        { id: 'own-2', technician_id: 't1', status: 'confirmed', window_start: '16:00' },
        { id: 'u1', technician_id: null, status: 'confirmed', window_start: '12:00' },
      ],
    };
    // routeOrder carries the tech's own stops + the candidate, in the
    // simulated visiting order — own-1 before the candidate, own-2 after.
    const fit = { routeOrder: ['own-1', '__candidate__', 'own-2'] };
    // Candidate placed at 13:00, between the unassigned blocker (12:00) and
    // the tech's own 16:00 stop — the unassigned row is the real neighbour,
    // not own-2 (which routeOrder alone would have named). Both row refs
    // now resolve (Codex r8 P1) since both live in context.rows.
    const result = capacityGapNeighbours(context, fit, 13 * 60);
    expect(result.prevId).toBe('u1');
    expect(result.nextId).toBe('own-2');
    expect(result.prevRow).toMatchObject({ id: 'u1', startMin: 720 });
    expect(result.nextRow).toMatchObject({ id: 'own-2', startMin: 960 });
  });

  test('a completed row is never treated as a fixed unassigned blocker', () => {
    const context = {
      target: { id: '__candidate__' },
      rows: [{ id: 'done', technician_id: null, status: 'completed', window_start: '10:00' }],
    };
    const fit = { routeOrder: ['__candidate__'] };
    expect(capacityGapNeighbours(context, fit, 13 * 60))
      .toEqual({ prevId: null, nextId: null, prevRow: null, nextRow: null });
  });
});

describe('capacityGapNeighbours — version-2 combined allocation expansion + summed credit (Codex r8 P1)', () => {
  // Companion to the buildDayStops fix in find-time-combined-allocation-
  // credit.test.js (Codex r7 P1) — capacityGapNeighbours used to anchor and
  // reshape a v2 member from its OWN raw window (one member's 09:00-10:00),
  // not the allocation's real summed span (both members' 09:00-11:00), so
  // packCapacityEnds (next describe block) could pick a packed end that
  // still genuinely overlapped the other member's ongoing work.
  const { capacityGapNeighbours } = require('../services/scheduling/find-time')._internals;
  const CATALOG = [{ service_key: null, name: 'pest_control', min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null }];

  function combinedMember(id, start, end) {
    return {
      id, scheduled_date: FUTURE_DATE, technician_id: null, status: 'confirmed',
      window_start: start, window_end: end, service_type: 'pest_control', service_key_snapshot: null,
      estimated_duration_minutes: null,
      reservation_service_mix: { version: 2, allocatedServiceIds: ['m1', 'm2'] },
    };
  }

  test('two credited 09:00-10:00 members occupying 09:00-11:00: the neighbour is the EXPANDED span with SUMMED credit, not one member\'s raw window', async () => {
    wireDb({ stops: [], catalog: CATALOG });
    await ensureCatalogLoaded(db);
    const context = {
      target: { id: '__candidate__' },
      rows: [combinedMember('m1', '09:00', '10:00'), combinedMember('m2', '09:00', '10:00')],
    };
    const fit = { routeOrder: ['__candidate__'] };
    // Candidate at 10:00 — inside the real combined span, but after each
    // member's own raw 10:00 end — is still anchored to the allocation as
    // prev (its expanded startMin, 540, is what anchors sort order).
    const { prevId, prevRow } = capacityGapNeighbours(context, fit, 10 * 60);
    expect(['m1', 'm2']).toContain(prevId);
    expect(prevRow.startMin).toBe(540); // 09:00
    expect(prevRow.endMin).toBe(660); // 11:00, NOT 600 (one member's own raw end)
    expect(prevRow.expectedMinutes).toBe(90); // 45 + 45, NOT 45 (one member's own credit)
  });
});
