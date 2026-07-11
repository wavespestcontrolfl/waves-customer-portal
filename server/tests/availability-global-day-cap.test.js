/**
 * AvailabilityEngine.getAvailableSlots — GLOBAL day-cap filter (booking-audit r4).
 *
 * max_self_books_per_day is global by calendar date, and BOTH confirm paths
 * (routes/booking.js createSelfBooking and availability.js confirmBooking)
 * enforce it with the shared countActiveSelfBookingsForDay under the
 * date-scoped advisory lock. The zone-engine BUILDER used to count per zone:
 * when ANOTHER zone had already consumed the global cap, it still offered
 * this zone's slots — and then every confirm 409'd SLOT_TAKEN/DAY_FULL. The
 * builder must drop full days by the same GLOBAL count the confirms enforce.
 *
 * Table-keyed db mock with a filtering self_booked_appointments builder, so
 * the zone-vs-global distinction is exercised semantically: cap-consuming
 * bookings live in a DIFFERENT zone than the one being browsed.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const db = require('../models/db');
const engine = require('../services/availability');
const { etDateString, addETDays } = require('../utils/datetime-et');

const ZONE_A = { id: 'zone-a', zone_name: 'Sarasota', cities: ['Sarasota'] };
const CONFIG = {
  advance_days_min: 1,
  advance_days_max: 2, // two candidate days — at least one is a non-Sunday
  day_start: '08:00',
  day_end: '17:00',
  lunch_start: '12:00',
  lunch_end: '13:00',
  slot_duration_minutes: 60,
  buffer_minutes: 15,
  max_self_books_per_day: 3,
};

// The dates the engine can consider (it skips Sundays itself).
const CANDIDATE_DATES = [1, 2].map((i) => etDateString(addETDays(new Date(), i)));

let selfBookedRows;

// Minimal filtering builder for self_booked_appointments: supports the
// GLOBAL count chain (.where('date').whereNot('status').modify().count().first())
// AND the zone-scoped occupancy list (awaited directly after wheres).
function selfBookedBuilder() {
  const preds = [];
  let counting = false;
  const rows = () => selfBookedRows.filter((r) => preds.every((p) => p(r)));
  const b = {
    where(field, value) {
      if (typeof field === 'string') preds.push((r) => String(r[field]) === String(value));
      return b;
    },
    whereNot(field, value) {
      preds.push((r) => String(r[field]) !== String(value));
      return b;
    },
    modify(fn) { fn(b); return b; },
    count() { counting = true; return b; },
    first() {
      return Promise.resolve(counting ? { count: rows().length } : rows()[0]);
    },
    then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); },
  };
  return b;
}

function arrayChain(rowsArr) {
  const b = {
    where: () => b,
    whereNot: () => b,
    whereIn: () => b,
    whereNotIn: () => b,
    leftJoin: () => b,
    select: () => b,
    then: (resolve, reject) => Promise.resolve(rowsArr).then(resolve, reject),
  };
  return b;
}

beforeEach(() => {
  selfBookedRows = [];
  db.mockReset();
  db.mockImplementation((table) => {
    // resolveZone awaits db('service_zones') directly
    if (table === 'service_zones') return Promise.resolve([ZONE_A]);
    if (table === 'booking_config') return { first: () => Promise.resolve(CONFIG) };
    // a tech is working zone A on every candidate day, so days aren't skipped
    if (table === 'tech_schedule_blocks') return arrayChain([{ id: 'blk-1' }]);
    // no scheduled services occupying the zone's timeline
    if (table === 'scheduled_services') return arrayChain([]);
    if (table === 'self_booked_appointments') return selfBookedBuilder();
    throw new Error(`unexpected table ${table}`);
  });
});

function crossZoneBookings(perDay) {
  // Bookings that consume the GLOBAL cap from a DIFFERENT zone: the old
  // per-zone count never saw these.
  const rows = [];
  for (const date of CANDIDATE_DATES) {
    for (let n = 0; n < perDay; n++) {
      rows.push({
        service_zone_id: 'zone-b',
        date,
        status: 'confirmed',
        start_time: '09:00',
        end_time: '10:00',
      });
    }
  }
  return rows;
}

describe('getAvailableSlots day-cap scope', () => {
  test('offers NO days when the GLOBAL count is at cap, even with zero bookings in the browsed zone', async () => {
    selfBookedRows = crossZoneBookings(CONFIG.max_self_books_per_day); // 3/day, all zone-b
    const result = await engine.getAvailableSlots('Sarasota');
    expect(result.zone).toBe('Sarasota');
    expect(result.days).toEqual([]); // every candidate day is globally full
  });

  test('still offers days (with slots) when the global count is below cap', async () => {
    selfBookedRows = crossZoneBookings(CONFIG.max_self_books_per_day - 1); // 2/day < 3
    const result = await engine.getAvailableSlots('Sarasota');
    expect(result.days.length).toBeGreaterThan(0);
    expect(result.days[0].slots.length).toBeGreaterThan(0);
    // ...and the other-zone bookings do NOT occupy this zone's timeline —
    // occupancy stays zone-scoped, only the CAP is global.
    expect(result.days[0].slots.some((s) => s.startTime24 === '09:00')).toBe(true);
  });

  test('cancelled bookings never count toward the cap (same predicate as the confirm writers)', async () => {
    selfBookedRows = crossZoneBookings(CONFIG.max_self_books_per_day)
      .map((r) => ({ ...r, status: 'cancelled' }));
    const result = await engine.getAvailableSlots('Sarasota');
    expect(result.days.length).toBeGreaterThan(0);
  });
});
