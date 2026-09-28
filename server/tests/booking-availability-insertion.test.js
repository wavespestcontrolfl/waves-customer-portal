/**
 * Owner 2026-09-28: buildBookingAvailability (the /book availability
 * builder behind /api/booking/availability, /find-slots, public reschedule,
 * public re-service, inspection-public, and the voice agent) now passes
 * find-time's insertProspective option, so a customer-facing offer can be
 * inserted BETWEEN a day's existing stops, not only appended after the
 * stored route order. Mirrors booking-availability-gap-fanout.test.js's
 * mocking style (find-time itself mocked; this file is purely about the
 * opts buildBookingAvailability hands findAvailableSlots).
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
  day_start: '08:00', day_end: '18:00',
  max_self_books_per_day: 3,
};

// db('self_booked_appointments') day-cap count query — thenable, no full days.
function wireDayCapCounts(rows = []) {
  const builder = {
    whereNot: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
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

async function build(serviceKey = '', extra = {}) {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(), serviceKey, ...extra,
  });
}

describe('buildBookingAvailability — insertProspective wiring (owner 2026-09-28)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });

  test('passes insertProspective: true to findAvailableSlots, alongside packEnds: true, for every /book availability call', async () => {
    await build();
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ insertProspective: true, packEnds: true }));
  });

  test('the self-serve caller (selfServeNotice: true) and the voice-agent caller (unset) both get insertProspective: true — the customerFacing split does not gate this', async () => {
    await build('', { selfServeNotice: true });
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ insertProspective: true, customerFacing: true }));
    await build('');
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ insertProspective: true, customerFacing: false }));
  });

  test('never passes capacityPlacement — /book keeps the conservative_travel no-traffic fallback requirement find-time.js keys on it', async () => {
    await build();
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.capacityPlacement).toBeUndefined();
    expect(opts.insertProspective).toBe(true);
  });
});
