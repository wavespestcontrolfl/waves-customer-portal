/**
 * Codex round 1 on PR #5231 (owner 2026-09-28): buildBookingAvailability
 * (the shared /book availability builder) now takes a `capacityPlacement`
 * param and passes it straight through to findAvailableSlots, replacing the
 * earlier unconditional `insertProspective: true` — insertion offers must
 * only reach callers whose own commit persists the certified route order,
 * so buildBookingAvailability itself takes no default and leaves the
 * decision to each caller. Per-caller wiring (which callers pass
 * capacityPlacement: bookCapacityCommitLive() vs omit it) is covered in each
 * route's own test file (booking-find-slots*, reservice-public*,
 * inspection-public*, reschedule-public*, voice-relay-booking/tools). This
 * file mirrors booking-availability-gap-fanout.test.js's mocking style
 * (find-time itself mocked) and is purely about buildBookingAvailability's
 * own pass-through.
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

describe('buildBookingAvailability — capacityPlacement pass-through', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });

  test('capacityPlacement: true is passed straight through to findAvailableSlots, alongside packEnds: true', async () => {
    await build('', { capacityPlacement: true });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ capacityPlacement: true, packEnds: true }));
  });

  test('capacityPlacement omitted by the caller reaches findAvailableSlots as undefined, never true — the append-only default', async () => {
    await build();
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.capacityPlacement).toBeUndefined();
    expect(opts.capacityPlacement).not.toBe(true);
  });

  test('capacityPlacement: false is passed through as false, not coerced to undefined or true', async () => {
    await build('', { capacityPlacement: false });
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.capacityPlacement).toBe(false);
  });
});
