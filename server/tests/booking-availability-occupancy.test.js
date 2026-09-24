/**
 * /book offer ↔ commit mirror (schedule-conflict lane): createSelfBooking's
 * commit gate blocks on unassigned zone rows and live customer-NULL estimate
 * holds, but find-time's occupied set is per-tech — so an unassigned booking
 * used to make buildBookingAvailability re-offer a slot that 409'd on every
 * tap (the same dead-end-loop class the estimate surface fixed with
 * filterCollidingSlots / #2704). The builder now post-filters candidates
 * against the shared tech-blind occupancy set and degrades SOFT on query
 * failure (over-filtering is acceptable; serving nothing is not).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D = dayOffset(10);

const CONFIG = {
  advance_days_min: 1, advance_days_max: 14,
  slot_duration_minutes: 60,
  day_start: '08:00', day_end: '17:00',
  max_self_books_per_day: 3,
};

function slot(startTime, rank) {
  return {
    date: D,
    start_time: startTime,
    end_time: null,
    technician: { id: 'tech-1' },
    detour_minutes: 3,
    stops_that_day: 2,
    rank,
    score: 100 - rank,
    insertion: { after_stop_id: 'stop-1' },
  };
}

// db('self_booked_appointments') day-cap count query — thenable, no full days.
function wireDayCapCounts(rows = []) {
  const builder = {
    whereNot: jest.fn().mockReturnThis(),
    // The day cap also counts VOICE bookings off scheduled_services (they
    // write no self_booked_appointments row) — same thenable, no rows here.
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    // Effective-date count (SELF_BOOKING_EFFECTIVE_DATE_SQL) rides in via
    // whereRaw / db.raw select / groupByRaw — passthroughs; no linked live
    // rows here, so the copy dates stand.
    whereRaw: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  return builder;
}

async function build() {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(),
  });
}

describe('buildBookingAvailability — travel-gap mirror (GATE_SLOT_TRAVEL_GAP)', () => {
  const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
  const saved = {};
  beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    wireDayCapCounts([]);
    findAvailableSlots.mockResolvedValue({ slots: [slot('09:00', 1), slot('14:00', 2)], total_feasible: 2 });
    // Bradenton stop 10:00–11:00 with a guarded pin — touches the 09:00 hour
    // across ~33 modeled minutes; 14:00 is three hours clear.
    listOccupiedWindows.mockResolvedValue([
      { id: 'row-1', technician_id: 'tech-1', customer_id: 'cust-2', date: D, startMin: 600, endMin: 660, lat: 27.425, lng: -82.41 },
    ]);
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Palmetto request.
  const buildPalmetto = () => buildBookingAvailability({
    lat: 27.545, lng: -82.545, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(),
  });

  const dayStarts = (result) => (result.days.find((d) => d.date === D)?.slots || []).map((s) => s.start_time);

  test('gate off: the touching 09:00 hour is still offered (legacy overlap-only mirror)', async () => {
    expect(dayStarts(await buildPalmetto())).toEqual(['09:00', '14:00']);
  });

  test('find-time gets the customer-facing buffer only when the gate is on; the shared anchor load stays gate-independent (Codex r5 structural)', async () => {
    await build();
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 0 }));
    // packing-geometry's loadPackingAnchors always reads WITH coords —
    // anchor loading is no longer where GATE_SLOT_TRAVEL_GAP lives; only
    // the drive-time predicate (violatesTravelGap) is gated.
    expect(listOccupiedWindows).toHaveBeenLastCalledWith(expect.objectContaining({ withCoords: true }));
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '20';
    await build();
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 20 }));
    expect(listOccupiedWindows).toHaveBeenLastCalledWith(expect.objectContaining({ withCoords: true }));
  });

  test('gate on: the touching hour is dropped, the clear one survives', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    expect(dayStarts(await buildPalmetto())).toEqual(['14:00']);
  });

  // Codex push-audit P1 (r6) — the occupancy mirror's anchor→row mapping
  // never set `hold`, so travel-gap.js's isHoldStop (`stop.hold != null`)
  // fell through to its reservation_expires_at heuristic, which this row
  // never carries either — every anchor here read as a plain committed
  // stop, never a hold. That breaks travelGapConflicts' "a hold never
  // shadows the committed neighbour behind it" rule: a CLOSE, COMPLIANT
  // hold naturally wins the nearest-before-candidate slot (real stops and
  // holds compete on raw proximity when hold status is unknown), silently
  // discarding a FARTHER, genuinely violating committed stop that a
  // correctly-flagged hold would never have been allowed to eclipse.
  test('a close, compliant hold never shadows a farther, genuinely violating committed stop', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    listOccupiedWindows.mockResolvedValue([
      // Farther from the 09:00-10:00 (540-600) candidate, in Bradenton
      // (~33 modeled minutes + 15 buffer needed): ends at 08:20 (500), only
      // 40 free minutes — well short of the ~48 required, a real violation.
      { id: 'real-far', technician_id: 'tech-1', customer_id: 'cust-1', date: D, startMin: 440, endMin: 500, lat: 27.425, lng: -82.41 },
      // Closer to the candidate (ends at 08:45 = 525) but co-located
      // (Palmetto, zero drive) and compliant on its own: exactly 15 free
      // minutes meets the flat buffer with room to spare.
      { id: 'hold-near', technician_id: null, customer_id: null, date: D, startMin: 465, endMin: 525, lat: 27.545, lng: -82.545, hold: true },
    ]);
    const result = await buildPalmetto();
    // Before the fix: the compliant, closer "hold" (misread as an ordinary
    // committed stop) wins the before-candidate slot on raw proximity,
    // discarding the farther real violator entirely — 09:00 wrongly
    // survives. After the fix: the hold is correctly excluded from that
    // slot, the real violator is checked instead, and 09:00 is dropped.
    expect(dayStarts(result)).not.toContain('09:00');
    expect(dayStarts(result)).toEqual(['14:00']);
  });
});

describe('buildBookingAvailability — commit-gate occupancy mirror', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    findAvailableSlots.mockResolvedValue({
      slots: [slot('09:00', 1), slot('14:00', 2)],
      total_feasible: 2,
    });
  });

  test('drops candidates overlapping an unassigned row and a techless hold', async () => {
    listOccupiedWindows.mockResolvedValue([
      // Unassigned zone booking (technician_id NULL) 09:00–10:00.
      { id: 'row-1', technician_id: null, customer_id: 'cust-2', date: D, startMin: 540, endMin: 600 },
      // Live techless estimate hold 14:30–15:30 — overlaps the 14:00 hour.
      { id: 'row-2', technician_id: null, customer_id: null, date: D, startMin: 870, endMin: 930 },
    ]);

    const result = await build();
    const starts = (result.days.find((d) => d.date === D)?.slots || []).map((s) => s.start_time);
    expect(starts).toEqual([]);
    expect(result.slots).toEqual([]);

    // The occupancy fetch mirrors the builder's range and threads the
    // public-reschedule exclusion (default []). Routed through the shared
    // loadPackingAnchors (Codex r5 structural) — always WITH coords,
    // gate-independent (see the travel-gap describe block above).
    expect(listOccupiedWindows).toHaveBeenCalledWith({
      dateFrom: D, dateTo: D, excludeServiceIds: [],
      withCoords: true,
    });
  });

  test('non-overlapping occupancy leaves offers untouched; back-to-back windows do not clash', async () => {
    listOccupiedWindows.mockResolvedValue([
      // 10:00–11:00 — back-to-back with the 09:00–10:00 candidate.
      { id: 'row-1', technician_id: null, customer_id: 'cust-2', date: D, startMin: 600, endMin: 660 },
    ]);

    const result = await build();
    const starts = (result.days.find((d) => d.date === D)?.slots || []).map((s) => s.start_time);
    expect(starts).toEqual(['09:00', '14:00']);
  });

  test('degrades soft: occupancy query failure serves unfiltered slots, never nothing', async () => {
    listOccupiedWindows.mockRejectedValue(new Error('relation vanished'));

    const result = await build();
    const starts = (result.days.find((d) => d.date === D)?.slots || []).map((s) => s.start_time);
    expect(starts).toEqual(['09:00', '14:00']);
  });

  test('day-cap fullDays behavior is unchanged by the occupancy filter', async () => {
    // GATE_SELF_BOOK_DAY_CAP (owner ruling 2026-09-23): dark by default —
    // force it on to exercise the cap this test is about.
    process.env.GATE_SELF_BOOK_DAY_CAP = 'true';
    try {
      wireDayCapCounts([{ date: D, count: '3' }]); // at max_self_books_per_day
      listOccupiedWindows.mockResolvedValue([]);

      const result = await build();
      expect(result.days.find((d) => d.date === D)).toBeUndefined();
      expect(result.slots).toEqual([]);
    } finally {
      delete process.env.GATE_SELF_BOOK_DAY_CAP;
    }
  });

  test('day cap off by default: a day at max_self_books_per_day is still offered', async () => {
    delete process.env.GATE_SELF_BOOK_DAY_CAP;
    wireDayCapCounts([{ date: D, count: '3' }]);
    listOccupiedWindows.mockResolvedValue([]);

    const result = await build();
    expect(result.days.find((d) => d.date === D)).toBeDefined();
  });
});
