/**
 * /book availability rain chips (GATE_BOOKING_RAIN_CHIPS):
 * buildBookingAvailability stamps the office-point daily rain chance onto
 * each day object AND each slot (days[].slots + curated slots) when the gate
 * is on; gate off (or outlook null) leaves the payload byte-identical to
 * today — no field anywhere, no weather call when gated off. The public
 * rescheduler consumes this builder's days/slots verbatim, so day.rainChance
 * flowing here is what its DayGroup chip reads.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { getDailyRainOutlookBounded } = require('../services/weather-forecast');
const { isEnabled } = require('../config/feature-gates');
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

describe('buildBookingAvailability — rain chips (GATE_BOOKING_RAIN_CHIPS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDayCapCounts([]);
    listOccupiedWindows.mockResolvedValue([]);
    isEnabled.mockImplementation(() => false);
    getDailyRainOutlookBounded.mockResolvedValue(null);
    findAvailableSlots.mockResolvedValue({
      slots: [slot('09:00', 1), slot('14:00', 2)],
      total_feasible: 2,
    });
  });

  test('gate ON: day objects AND every slot (days + curated) carry rainChance', async () => {
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue({
      [D]: { rainChance: 62, shortForecast: 'Scattered storms' },
    });

    const result = await build();
    const day = result.days.find((d) => d.date === D);
    expect(day).toBeDefined();
    expect(day.rainChance).toBe(62);
    expect(day.slots.length).toBeGreaterThan(0);
    for (const s of day.slots) expect(s.rainChance).toBe(62);
    expect(result.slots.length).toBeGreaterThan(0);
    for (const s of result.slots) expect(s.rainChance).toBe(62);

    // ONE office-point lookup, never the customer's coordinates.
    expect(getDailyRainOutlookBounded).toHaveBeenCalledTimes(1);
    expect(getDailyRainOutlookBounded).toHaveBeenCalledWith(27.4217, -82.4065);
  });

  test('gate ON + outlook null: fail-open, payload has no rainChance anywhere', async () => {
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue(null);

    const result = await build();
    const day = result.days.find((d) => d.date === D);
    expect(day).not.toHaveProperty('rainChance');
    for (const s of day.slots) expect(s).not.toHaveProperty('rainChance');
    for (const s of result.slots) expect(s).not.toHaveProperty('rainChance');
  });

  test('gate OFF: no weather call and payload identical to today (no field)', async () => {
    getDailyRainOutlookBounded.mockResolvedValue({
      [D]: { rainChance: 62, shortForecast: 'Scattered storms' },
    });

    const result = await build();
    const day = result.days.find((d) => d.date === D);
    expect(day).toBeDefined();
    expect(day).not.toHaveProperty('rainChance');
    for (const s of day.slots) expect(s).not.toHaveProperty('rainChance');
    for (const s of result.slots) expect(s).not.toHaveProperty('rainChance');
    expect(getDailyRainOutlookBounded).not.toHaveBeenCalled();
  });
});
