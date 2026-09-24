/**
 * AvailabilityEngine.getAvailableSlots — travel-gap mirror (GATE_SLOT_TRAVEL_GAP).
 *
 * confirmBooking's commit probe runs the tech-blind, coordinate-aware
 * findConflictingVisits `travel` predicate over every stop that day, while
 * this legacy builder's occupied set is zone-scoped and buffer-only. GH codex
 * #3803 r1 P1: an out-of-zone stop adjacent to a quoted slot made the commit
 * reject the exact option check_availability had just returned. Gate on, the
 * builder now reads every occupying row (guarded coords) once for the range
 * and drops what the commit would 409; gate off issues no extra statement.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  listOccupiedWindows: jest.fn(),
}));

const db = require('../models/db');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const engine = require('../services/availability');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const ZONE = { id: 'zone-a', zone_name: 'Palmetto', cities: ['Palmetto'] };
const CONFIG = {
  advance_days_min: 1,
  advance_days_max: 1,
  day_start: '08:00',
  day_end: '17:00',
  lunch_start: '12:00',
  lunch_end: '13:00',
  slot_duration_minutes: 60,
  buffer_minutes: 15,
  max_self_books_per_day: 3,
};
// Pinned to an early ET morning (owner ruling 2026-09-23, self-serve notice
// window default 24h): "tomorrow" (advance_days_min: 1) must never itself
// fall inside the notice window, or this file's day-start assertions
// ('09:00' present/absent) would depend on the wall-clock time the suite
// happens to run at. This file is about the travel-gap mirror, not the
// notice window — self-serve-notice.test.js owns that boundary coverage.
const NOW = new Date('2027-05-14T09:00:00Z'); // 05:00 ET
let DATE;
const PALMETTO = { latitude: 27.545, longitude: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.41 };

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  DATE = etDateString(addETDays(NOW, 1));
});
afterAll(() => {
  jest.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function arrayChain(rowsArr) {
  let counting = false;
  const b = {
    where: () => b,
    whereNot: () => b,
    whereNotExists: () => { rowsArr = rowsArr.filter(row => !row.linkedVisit); return b; },
    whereIn: () => b,
    whereNotIn: () => b,
    whereNotNull: () => b,
    whereRaw: () => b,
    count: () => { counting = true; return b; },
    first: () => Promise.resolve(counting ? { count: 0 } : (rowsArr[0] || null)),
    modify(fn) { fn(b); return b; },
    leftJoin: () => b,
    select: () => b,
    then: (resolve, reject) => Promise.resolve(rowsArr).then(resolve, reject),
  };
  return b;
}

const tables = () => ({
  service_zones: () => Promise.resolve([ZONE]),
  booking_config: () => ({ first: () => Promise.resolve(CONFIG) }),
  tech_schedule_blocks: () => arrayChain([{ id: 'blk-1' }]),
  scheduled_services: () => arrayChain([]), // nothing in-zone
  self_booked_appointments: () => arrayChain([]),
  estimates: () => arrayChain([{ customer_id: 'cust-1' }]),
  customers: () => arrayChain([{ ...PALMETTO }]),
});

let seen;
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  seen = [];
  clearExpectedServiceMinutesCache();
  db.mockReset();
  const t = tables();
  db.mockImplementation((table) => {
    seen.push(table);
    if (!t[table]) throw new Error(`unexpected table ${table}`);
    return t[table]();
  });
});

const startsOf = (result) => (result.days[0]?.slots || []).map((s) => s.startTime24);

test('gate off: the global anchor read still runs (Codex r5 P1 — anchor loading is gate-independent), but no estimate/customer pin read', async () => {
  const result = await engine.getAvailableSlots('Palmetto', 'est-1');
  // loadPackingAnchors (packing-geometry.js) is unconditional — only the
  // pin/credit half of the old mirror stays behind GATE_SLOT_TRAVEL_GAP.
  expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ withCoords: true }));
  expect(seen).not.toContain('estimates');
  expect(seen).not.toContain('customers');
  // Empty zone timeline → the builder's own gaps, 09:00 onward.
  expect(startsOf(result)).toContain('09:00');
});

test('gate on: an OUT-OF-ZONE stop across a real drive drops the touching window the commit would reject', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  // Bradenton 10:00–11:00 — not in the Palmetto zone's city list, so the
  // legacy occupied set never saw it; the commit probe (tech-blind) does.
  listOccupiedWindows.mockResolvedValue([
    { id: 'far', date: DATE, startMin: 600, endMin: 660, ...BRADENTON },
  ]);
  const result = await engine.getAvailableSlots('Palmetto', 'est-1');
  expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: DATE, dateTo: DATE, withCoords: true }));
  expect(seen).toContain('estimates');
  expect(seen).toContain('customers');
  const starts = startsOf(result);
  // 09:00–10:00 touches the 10:00 stop with 0 free minutes against ~33 + 15.
  expect(starts).not.toContain('09:00');
  // 10:00–11:00 overlaps it outright.
  expect(starts).not.toContain('10:00');
  // Codex r3 P1: the far stop is merged into the SAME packing geometry
  // findGaps uses (it is a real neighbour on the one tech-blind route, just
  // in another zone), so the trailing gap is packed against it exactly like
  // a zone-local stop would be. With GATE_BOOKING_LUNCH_BLOCK unset
  // (default, owner ruling 2026-09-23, #4663) no artificial lunch occupancy
  // resets that anchor mid-day any more, so the trailing gap offers its
  // first accepted hour once clear of the far stop's travel-gap radius —
  // 12:00, not the old lunch-block-reset [] or the un-packed 14:00 the bug
  // report described.
  expect(starts).toContain('12:00');
});

test('gate on with a customerId and no estimate (AI assistant session): the customer pin, no estimates read', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  listOccupiedWindows.mockResolvedValue([
    { id: 'far', date: DATE, startMin: 600, endMin: 660, ...BRADENTON },
  ]);
  const result = await engine.getAvailableSlots('Palmetto', null, { customerId: 'cust-1' });
  expect(seen).not.toContain('estimates');
  expect(seen).toContain('customers');
  expect(startsOf(result)).not.toContain('09:00');
  // See the previous test — 12:00 with the lunch gate unset (default).
  expect(startsOf(result)).toContain('12:00');
});

test('gate on without an estimate: buffer-only pin, still mirrored; a failed range read serves unfiltered', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  listOccupiedWindows.mockResolvedValue([
    { id: 'near', date: DATE, startMin: 605, endMin: 665, lat: null, lng: null }, // 10:05 — 5 free min < 15 buffer
  ]);
  let result = await engine.getAvailableSlots('Palmetto');
  expect(seen).not.toContain('estimates');
  expect(startsOf(result)).not.toContain('09:00');

  listOccupiedWindows.mockRejectedValue(new Error('boom'));
  result = await engine.getAvailableSlots('Palmetto', 'est-1');
  expect(startsOf(result)).toContain('09:00');
});

describe('global mirror stops anchor legacy packing (Codex #4664 r3 P1)', () => {
  test('a day whose ONLY committed visit is out-of-zone packs against it instead of offering a hole-making early hour', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    // Bradenton 16:00–17:00 — not in the Palmetto zone's city list (no
    // coords, so this isolates the packing-geometry fix from any drive-time
    // arithmetic). scheduledInZone stays empty; only the global mirror
    // knows about this stop.
    listOccupiedWindows.mockResolvedValue([
      { id: 'far', date: DATE, startMin: 960, endMin: 1020, lat: null, lng: null },
    ]);
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    const starts = startsOf(result);
    // Before the fix, hasRealStops read this day as empty (occupied was
    // built from scheduledInZone alone) and the legacy earliest-per-gap
    // walk offered 9:00 immediately — a hole-making slot nowhere near the
    // day's only real (out-of-zone) stop. The fix merges that stop into the
    // same geometry findGaps uses, so the day is correctly packed instead:
    // only the latest hour that still clears the buffer before 16:00.
    expect(starts).not.toContain('09:00');
    expect(starts).toEqual(['14:00']);
  });

  test('legacy callers (gate off): the anchor read still runs (Codex r5 P1), but with no real anchor that day the zone-only geometry is unaffected', async () => {
    listOccupiedWindows.mockResolvedValue([]); // no anchor for this date — isolates this test from the fixture above
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ withCoords: true }));
    expect(startsOf(result)).toContain('09:00');
  });

  test('GATE_SLOT_TRAVEL_GAP unset: the day\'s only out-of-zone visit still anchors the packing (Codex r5 P1)', async () => {
    // Gate deliberately left unset (beforeEach already cleared it) — before
    // this fix, the whole global-anchor read lived INSIDE the gate branch,
    // so with the gate off this out-of-zone visit was invisible to
    // hasRealStops too, not just to drive-time filtering.
    listOccupiedWindows.mockResolvedValue([
      { id: 'far', date: DATE, startMin: 960, endMin: 1020, lat: null, lng: null },
    ]);
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    const starts = startsOf(result);
    expect(starts).not.toContain('09:00');
    expect(starts).toEqual(['14:00']);
  });

  // Codex r6 P1 — scheduledInZone already carries each v2-allocation
  // member's OWN raw window (09:00-10:00 apiece), so the old id-dedupe saw
  // those ids already in `occupied` and skipped the matching anchor
  // entirely, even though that anchor carries the allocation-EXPANDED span
  // (09:00-12:00, the real occupied time). `occupied` was left at the raw
  // 10:00 end, packing an 11:00 candidate the commit gate rejects as
  // overlapping the real 09:00-12:00 span.
  test('a version-2 combined allocation\'s in-zone raw members are REPLACED by the expanded anchor, not skipped', async () => {
    // Gate deliberately left unset: the anchor-set-driven packEnds geometry
    // (occupied itself) is what this test isolates — with the gate on, the
    // SEPARATE accept()-level travelGap mirror (built from the always-
    // correct dayAnchors, never from `occupied`) would independently reject
    // an 11:00 candidate that real-overlaps the anchor's true 09:00-12:00
    // span, masking the bug this finding actually describes (findGaps' OWN
    // packed-ends boundary, computed from the buggy `occupied`, offering a
    // candidate the accept() mirror then has to catch after the fact).
    const t = tables();
    // Three members of one arrival-anchored allocation, in-zone — each
    // stamped with its OWN raw per-member window (09:00-10:00).
    t.scheduled_services = () => arrayChain([
      { id: 'm1', window_start: '09:00', window_end: '10:00' },
      { id: 'm2', window_start: '09:00', window_end: '10:00' },
      { id: 'm3', window_start: '09:00', window_end: '10:00' },
    ]);
    db.mockImplementation((table) => { seen.push(table); return t[table](); });
    // The SAME three ids — but loadPackingAnchors' allocation expansion
    // (occupancy.js's occupiedRows) gives each one the REAL combined
    // 09:00-12:00 span, not its own raw 09:00-10:00.
    listOccupiedWindows.mockResolvedValue([
      { id: 'm1', date: DATE, startMin: 540, endMin: 720, lat: null, lng: null },
      { id: 'm2', date: DATE, startMin: 540, endMin: 720, lat: null, lng: null },
      { id: 'm3', date: DATE, startMin: 540, endMin: 720, lat: null, lng: null },
    ]);
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    const starts = startsOf(result);
    // Before the fix: occupied stayed at the raw 09:00-10:00 end (600), so
    // the trailing gap packed to 11:00 (roundUp(600+15)) — a candidate that
    // overlaps the real 09:00-12:00 allocation and 409s at commit. After the
    // fix: occupied is REPLACED with the expanded 09:00-12:00 span (720),
    // so the trailing gap packs to 13:00 instead.
    expect(starts).not.toContain('11:00');
    expect(starts).toEqual(['13:00']);
  });
});

describe('findGaps: the packed-after-a-stop bound credits the stop\'s own expected minutes (Codex r6 P2)', () => {
  test('a co-located 09:00-10:00 stop with 45 expected minutes offers the credited 10:00 after it, not the flat-buffer 11:00', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const t = tables();
    t.scheduled_services = () => arrayChain([
      { id: 'stop-1', window_start: '09:00', window_end: '10:00' },
    ]);
    db.mockImplementation((table) => { seen.push(table); return t[table](); });
    // 60-minute window, 45 expected minutes — the stop's own catalog credit,
    // preserved onto `occupied` by the same anchor merge finding 1 fixed.
    listOccupiedWindows.mockResolvedValue([
      { id: 'stop-1', date: DATE, startMin: 540, endMin: 600, windowMinutes: 60, expectedMinutes: 45, lat: null, lng: null },
    ]);
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    const starts = startsOf(result);
    // Before the fix: findGaps' packed-after bound was the flat
    // roundUpToHour(cursor + buffer) = roundUp(600+15) = 11:00, ignoring the
    // stop's own 15 minutes of unused window (60 window - 45 expected) that
    // should absorb the 15-minute buffer entirely. After the fix (packedBounds
    // on the after side, credited from the stop's own expectedEndMin): the
    // buffer is fully absorbed, and the bound floors at the stop's own raw
    // end (10:00) — never earlier, however much credit it carries.
    expect(starts).not.toContain('11:00');
    expect(starts).toContain('10:00');
  });
});

describe('the candidate\'s own expected-minutes credit (Codex #4664 r3 P2, r5 P2)', () => {
  // Offer/commit parity (owner ruling 2026-09-23): the offer-side mirror
  // must resolve the SAME candidate credit confirmBooking's commit probe
  // does (see availability-zone-null-confirm.test.js's "candidate
  // expected-minutes credit" suite, which proves the numeric effect at
  // commit — findConflictingVisits there is a plain jest.fn(), so the exact
  // `travel.expectedMinutes` argument is directly assertable). The catalog
  // is read only when the gate is on and an estimate is present.
  const QUARTERLY_PEST_CATALOG = [
    { service_key: 'quarterly_pest', name: 'General Pest Control', min_duration_minutes: 30, max_duration_minutes: 60 },
  ];

  test('gate on + an estimate: reads the catalog for the candidate\'s own credit', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const t = tables();
    t.services = () => arrayChain(QUARTERLY_PEST_CATALOG);
    db.mockImplementation((table) => { seen.push(table); return t[table](); });
    listOccupiedWindows.mockResolvedValue([]); // empty day — isolates the wiring from the packing geometry
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    expect(seen).toContain('services');
    expect(startsOf(result)).toContain('09:00');
  });

  test('gate off: never reads the catalog for the candidate', async () => {
    const t = tables();
    t.services = () => arrayChain(QUARTERLY_PEST_CATALOG);
    db.mockImplementation((table) => { seen.push(table); return t[table](); });
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    expect(seen).not.toContain('services');
    expect(startsOf(result)).toContain('09:00');
  });

  test('Codex r5 P2 — a noon stop is packed to the credited hour (11:00), not the flat-buffer hour (10:00)', async () => {
    // 60-minute window (config default), 45 expected (catalog midpoint
    // 30/60), 15-minute buffer, a noon stop: findGaps' gap bound previously
    // subtracted the flat 15-minute buffer from the stop's full window
    // (12:00 - 0:15 = 11:45, rounded down to 10:00 by offerLatest's hour
    // snap) regardless of credit, while the accept() callback beside it —
    // and confirmBooking at commit — already credited the same candidate.
    // packedBounds now threads that credit through the bound itself.
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const t = tables();
    t.services = () => arrayChain(QUARTERLY_PEST_CATALOG);
    t.scheduled_services = () => arrayChain([
      { id: 's1', window_start: '12:00', window_end: '13:00', estimated_duration_minutes: 60, city: 'Palmetto' },
    ]);
    db.mockImplementation((table) => { seen.push(table); return t[table](); });
    listOccupiedWindows.mockResolvedValue([]); // zone-local stop only — isolates from the global-anchor merge (r5 P1)
    const result = await engine.getAvailableSlots('Palmetto', 'est-1');
    const starts = startsOf(result);
    expect(starts).toContain('11:00');
    expect(starts).not.toContain('10:00');
  });
});

test('findGaps applies the accept predicate BEFORE its four-slot cap (r4 P2)', () => {
  // Six one-hour holes on the day (blocks every other hour); rejecting the
  // first four must still surface the fifth and sixth.
  const occupied = [9, 11, 13, 15].map((h) => ({ start: h * 60, end: h * 60 + 60 }));
  const all = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0);
  expect(all).toHaveLength(4); // capped
  const rejectEarly = (g) => g.start >= 14 * 60;
  const late = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, rejectEarly);
  expect(late.map((g) => g.start / 60)).toEqual([14, 16]);
});

test('findGaps advances an hour at a time inside a rejected gap (r5 P2)', () => {
  // One long zone-local hole 09:00–15:00 (blocks 08–09 and 15–16). An
  // out-of-zone rejection of 09:00 must yield the first accepted hour.
  const occupied = [{ start: 8 * 60, end: 9 * 60 }, { start: 15 * 60, end: 16 * 60 }];
  const noEarly = (g) => g.start >= 12 * 60;
  const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, noEarly);
  expect(slots.map((g) => g.start / 60)).toEqual([12, 16]);
  // Without a predicate the legacy shape is unchanged: one slot per gap.
  expect(engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0).map((g) => g.start / 60)).toEqual([9, 16]);
});

test('GATE_BOOKING_LUNCH_BLOCK (owner ruling 2026-09-23): unset drops the artificial lunch occupancy, true restores it', async () => {
  const previous = process.env.GATE_BOOKING_LUNCH_BLOCK;
  try {
    // Unset (default): no lunch entry is pushed onto `occupied`, so the whole
    // day is ONE gap; findGaps still offers its first hour (09:00) AND — so
    // removing the block never costs the assistant its afternoon choices —
    // the first accepted start at/after the configured afternoon boundary
    // (13:00, the old lunch_end). Noon is offerable where a gap opens onto
    // it (availability-lunch-gate-coverage.test.js).
    delete process.env.GATE_BOOKING_LUNCH_BLOCK;
    let result = await engine.getAvailableSlots('Palmetto');
    expect(startsOf(result)).toEqual(['09:00', '13:00']);

    // 'true' restores the legacy split: a morning gap (09:00) and an
    // afternoon gap starting after the lunch block + buffer (14:00).
    process.env.GATE_BOOKING_LUNCH_BLOCK = 'true';
    result = await engine.getAvailableSlots('Palmetto');
    expect(startsOf(result)).toEqual(['09:00', '14:00']);
  } finally {
    if (previous === undefined) delete process.env.GATE_BOOKING_LUNCH_BLOCK;
    else process.env.GATE_BOOKING_LUNCH_BLOCK = previous;
  }
});

test('a linked booking copy cannot retain the old window after its visit stops occupying it', async () => {
  const t = tables();
  const copy = { id: 'old-copy', start_time: '08:00', end_time: '17:00' };
  let linkedVisit = false;
  t.self_booked_appointments = () => arrayChain([{ ...copy, linkedVisit }]);
  db.mockImplementation(table => t[table]());
  expect((await engine.getAvailableSlots('Palmetto')).days).toHaveLength(0);
  linkedVisit = true;
  expect(startsOf(await engine.getAvailableSlots('Palmetto'))).toContain('09:00');
});

describe('findGaps packed-ends: the lunch block is never a packing anchor (Codex #4664 r1 P2)', () => {
  const LUNCH = { start: 12 * 60, end: 13 * 60, lunch: true };

  test('a day whose only real stop is 16:00 offers the hour before it and the hour after it — never "packed before lunch"', () => {
    const occupied = [LUNCH, { start: 16 * 60, end: 17 * 60 }];
    const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, null, { packEnds: true });
    expect(slots.map((g) => g.start / 60)).toEqual([15, 17]);
  });

  test('a stop before lunch anchors the hour after it, but the gap after lunch gets nothing from the lunch side', () => {
    const occupied = [{ start: 9 * 60, end: 10 * 60 }, LUNCH];
    const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, null, { packEnds: true });
    // 8:00 packed before the 9:00 stop, 10:00 packed after it; 11:00 is
    // NOT offered (lunch is not a stop); the afternoon has no real stop to
    // pack against.
    expect(slots.map((g) => g.start / 60)).toEqual([8, 10]);
  });

  test('an unflagged block is still a real anchor on both sides (middle gap offers both packed ends)', () => {
    const occupied = [{ start: 9 * 60, end: 10 * 60 }, { start: 14 * 60, end: 15 * 60 }];
    const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, null, { packEnds: true });
    expect(slots.map((g) => g.start / 60)).toEqual([8, 10, 13, 15]);
  });

  test('legacy mode (packEnds false) ignores the lunch flag and keeps one earliest hour per gap', () => {
    const occupied = [LUNCH, { start: 16 * 60, end: 17 * 60 }];
    const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0);
    expect(slots.map((g) => g.start / 60)).toEqual([8, 13, 17]);
  });
});

test('findGaps packed-ends: a lunch block contained inside a real stop keeps that stop as the anchor (Codex #4664 r2 P2)', () => {
  const occupied = [{ start: 11 * 60, end: 14 * 60 }, { start: 12 * 60, end: 13 * 60, lunch: true }];
  const slots = engine.findGaps(occupied, 8 * 60, 18 * 60, 60, 0, null, { packEnds: true });
  // 10:00 packed before the 11:00 stop; 14:00 packed after it (the
  // contained lunch block must not erase the after-stop anchor).
  expect(slots.map((g) => g.start / 60)).toEqual([10, 14]);
});
