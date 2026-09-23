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
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

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
  ['whereNotNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
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
  // buffer-agnostic — a stop's own catalog credit must still reduce its
  // effective end for a customer-facing (packEnds) caller even at buffer 0,
  // or the offer geometry silently reverts to gate-off behavior while the
  // commit probes keep crediting it (an offer/commit mismatch).
  const WIDE_CATALOG = [{
    service_key: 'wide_pest', name: 'pest_control',
    min_duration_minutes: 15, max_duration_minutes: 45, default_duration_minutes: null,
  }];
  const stops = [stopRow('s1', '10:00', '12:00')]; // 120-min window; expected 30 -> effective end 10:30

  test('a trailing gap packs to the credited hour (11:00), not the raw window-end hour (12:00)', async () => {
    wireDb({ stops, catalog: WIDE_CATALOG });
    const { slots } = await findAvailableSlots({
      ...BASE, packEnds: true, serviceKey: 'pest_control', bufferMinutes: 0, // explicit zero, NOT customerFacingBufferMinutes()
    });
    const trailing = slots.filter((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id == null);
    expect(trailing.map((s) => s.start_time)).toEqual(['11:00']);
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
});

describe('capacityGapNeighbours — unassigned blockers count as time-based anchors (Codex r3 P1)', () => {
  const { capacityGapNeighbours } = require('../services/scheduling/find-time')._internals;

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
    expect(capacityGapNeighbours(context, fit, new Map(), 9 * 60)).toEqual({ prevId: null, nextId: 'u1' });
    // Candidate at 14:00 (after the blocker) → blocker is prev, no next.
    expect(capacityGapNeighbours(context, fit, new Map(), 14 * 60)).toEqual({ prevId: 'u1', nextId: null });
  });

  test('merges the tech\'s own route (via routeOrder/byId) with unassigned rows, sorted by time', () => {
    const byId = new Map([
      ['own-1', { id: 'own-1', technician_id: 't1', window_start: '09:00' }],
      ['own-2', { id: 'own-2', technician_id: 't1', window_start: '16:00' }],
    ]);
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
    // not own-2 (which routeOrder alone would have named).
    expect(capacityGapNeighbours(context, fit, byId, 13 * 60)).toEqual({ prevId: 'u1', nextId: 'own-2' });
  });

  test('a completed row is never treated as a fixed unassigned blocker', () => {
    const context = {
      target: { id: '__candidate__' },
      rows: [{ id: 'done', technician_id: null, status: 'completed', window_start: '10:00' }],
    };
    const fit = { routeOrder: ['__candidate__'] };
    expect(capacityGapNeighbours(context, fit, new Map(), 13 * 60)).toEqual({ prevId: null, nextId: null });
  });
});
