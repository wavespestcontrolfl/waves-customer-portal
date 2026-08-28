/**
 * buildBookingAvailability gap fan-out: find-time emits ONE
 * earliest-feasible-minute candidate per route gap, and the builder
 * previously offered only its hour-snap — when that single snapped start
 * landed in the lunch block or on an occupied hour, the gap's genuinely
 * free later hours were never generated and whole near-term days with real
 * capacity vanished from /book, the reschedule page, and /reservice
 * (2026-08-05 field report). The builder now fans out every grid-aligned
 * start up to the gap's latest_start_min bound (end still clears the drive
 * to the next stop), so the per-start rules reject starts, not days.
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

function gapSlot(startTime, extra = {}) {
  return {
    date: D,
    start_time: startTime,
    end_time: null,
    technician: { id: 'tech-1' },
    detour_minutes: 3,
    stops_that_day: 2,
    rank: 1,
    score: 10,
    insertion: { after_stop_id: 'stop-1' },
    ...extra,
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
    // Superseded-copy filter (excludeSupersededSelfBookings) rides in via
    // .modify + whereNotExists — passthroughs; no linked live rows here.
    modify(fn) { fn(builder); return builder; },
    whereNotExists: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  return builder;
}

async function build() {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(),
  });
}

const startTimes = (availability) => (availability.days[0]?.slots || []).map((s) => s.start_time);

describe('buildBookingAvailability — gap fan-out', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
  });

  test('a gap whose earliest snap lands in lunch still offers its free afternoon hours', async () => {
    // Gap opens 11:10 (snaps to 12:00 = lunch) and runs long enough to hold
    // starts through 15:30. Pre-fan-out this day rendered EMPTY.
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('11:10', { latest_start_min: 15 * 60 + 30 })],
      total_feasible: 1,
    });
    const availability = await build();
    expect(startTimes(availability)).toEqual(['13:00', '14:00', '15:00']);
  });

  test('an occupied hour rejects that start only, not the rest of the gap', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('13:00', { latest_start_min: 15 * 60 })],
      total_feasible: 1,
    });
    listOccupiedWindows.mockResolvedValue([{ date: D, startMin: 14 * 60, endMin: 15 * 60 }]);
    const availability = await build();
    expect(startTimes(availability)).toEqual(['13:00', '15:00']);
  });

  test('the fan-out never passes latest_start_min — a snap past the bound offers nothing', async () => {
    // Gap 14:10–15:10: the hour-snap (15:00 + 60 min) would end past what the
    // route can reach; the old single-candidate path offered it anyway.
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('14:10', { latest_start_min: 14 * 60 + 10 })],
      total_feasible: 1,
    });
    const availability = await build();
    expect(availability.days).toEqual([]);
  });

  test('a slot without latest_start_min falls back to the single snapped start (legacy shape)', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('09:10')],
      total_feasible: 1,
    });
    const availability = await build();
    expect(startTimes(availability)).toEqual(['10:00']);
  });

  test('empty-day 08:00 snap-down is preserved and the day fans out past it', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [gapSlot('08:05', {
        stops_that_day: 0,
        insertion: { after_stop_id: null },
        latest_start_min: 15 * 60 + 59,
      })],
      total_feasible: 1,
    });
    const availability = await build();
    // Display cap is 4 slots/day; chronological — the legacy path offered
    // exactly one (08:00).
    expect(startTimes(availability)).toEqual(['08:00', '09:00', '10:00', '11:00']);
  });
});
