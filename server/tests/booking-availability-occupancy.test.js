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
    whereBetween: jest.fn().mockReturnThis(),
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
    // public-reschedule exclusion (default []).
    expect(listOccupiedWindows).toHaveBeenCalledWith({
      dateFrom: D, dateTo: D, excludeServiceIds: [],
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
    wireDayCapCounts([{ date: D, count: '3' }]); // at max_self_books_per_day
    listOccupiedWindows.mockResolvedValue([]);

    const result = await build();
    expect(result.days.find((d) => d.date === D)).toBeUndefined();
    expect(result.slots).toEqual([]);
  });
});
