/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS, owner ruling 2026-09-29) at the /book
 * availability builder: a self-serve caller resolves the request's zone from
 * its COORDINATES and hands the slug to find-time, which lifts the detour cap
 * on the zone's route day (find-time-zone-route-days.test.js). Gate off, and
 * the phone agent (selfServeNotice unset), get no zone and make no zone
 * queries. Mocking style follows booking-availability-insertion.test.js.
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

const D = etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), 10));
const CONFIG = {
  advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00', max_self_books_per_day: 3,
};
const ZONES = [
  { id: 'z-sar', zone_name: 'Sarasota / Lakewood Ranch', cities: ['Sarasota'], center_lat: 27.3364, center_lng: -82.5307 },
  { id: 'z-ven', zone_name: 'Venice / North Port', cities: ['Venice'], center_lat: 27.0998, center_lng: -82.4543 },
];

function wireDb() {
  const generic = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockImplementation((table) => {
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue(ZONES) };
    if (table === 'system_settings') return { where: () => ({ first: async () => undefined }) };
    return generic;
  });
  db.raw = jest.fn((sql) => sql);
}
const tablesQueried = () => db.mock.calls.map((c) => c[0]);

const build = (extra = {}) => buildBookingAvailability({
  lat: 27.12, lng: -82.44, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(), ...extra,
});

describe('buildBookingAvailability — zone route day wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ZONE_ROUTE_DAYS;
    wireDb();
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });
  afterEach(() => { delete process.env.GATE_ZONE_ROUTE_DAYS; });

  test('gate off: no zone, and no zone/settings query', async () => {
    await build({ selfServeNotice: true });
    expect(findAvailableSlots.mock.calls[0][0].zoneSlug).toBeNull();
    expect(tablesQueried()).not.toContain('service_zones');
    expect(tablesQueried()).not.toContain('system_settings');
  });

  test('gate on, self-serve: a North Venice pin (not a city in service_zones.cities) is passed as venice', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    await build({ selfServeNotice: true });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ zoneSlug: 'venice', customerFacing: true }));
  });

  test('gate on, self-serve: a northern pin resolves to its own zone (no route day for it)', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    await build({ selfServeNotice: true, lat: 27.3364, lng: -82.5307 });
    expect(findAvailableSlots.mock.calls[0][0].zoneSlug).toBe('sarasota');
  });

  test('gate on, phone-agent style caller (selfServeNotice unset): no zone, not customerFacing', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    await build();
    const opts = findAvailableSlots.mock.calls[0][0];
    expect(opts.zoneSlug).toBeNull();
    expect(opts.customerFacing).toBeFalsy();
    expect(tablesQueried()).not.toContain('service_zones');
  });

  test('the Friday slot find-time returns for the lifted zone reaches the offered days', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: D, start_time: '10:00', end_time: null, technician: { id: 'tech-1' },
        detour_minutes: 120, stops_that_day: 0, rank: 1, score: 120, latest_start_min: 12 * 60,
      }],
      total_feasible: 1,
    });
    const availability = await build({ selfServeNotice: true });
    expect(availability.days.flatMap((d) => d.slots).map((s) => s.start_time)).toContain('10:00');
  });
});
