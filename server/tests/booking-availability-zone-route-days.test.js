/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS, owner ruling 2026-09-29) at the /book
 * availability builder: a self-serve caller resolves the request's zone from
 * its COORDINATES and hands the slug to find-time, which lifts the detour cap
 * on the zone's route day (find-time-zone-route-days.test.js). Gate off, and
 * the phone agent (selfServeNotice unset), get no zone and make no zone
 * queries. Mocking style follows booking-availability-insertion.test.js.
 */
// The south-zone day funnel's gate resolves at feature-gates require time (the assessment-link block below).
process.env.GATE_SOUTH_ZONE_DAY_FUNNEL = 'true';
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
function wireDbGeneric() {
  return {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
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

// The lead assessment link (inspection-public.js buildAvailabilityForLead) hands its booking address to the
// builder; GATE_SOUTH_ZONE_DAY_FUNNEL narrows the pool exactly as the estimate page does (zone-day-funnel.js).
describe('buildAvailabilityForLead — south-zone day funnel', () => {
  const D1 = etDateString(addETDays(parseETDateTime(`${D}T12:00`), 1));
  const D2 = etDateString(addETDays(parseETDateTime(`${D}T12:00`), 2));
  const slotOn = (date, rank) => ({
    date, start_time: '10:00', end_time: null, technician: { id: 'tech-1' },
    detour_minutes: 5, stops_that_day: 1, rank, score: rank, insertion: { after_stop_id: 'stop-1' },
  });
  const VENICE = { line1: '9 Test Palm Way', city: 'Venice', state: 'FL', zip: '34285' };
  const SARASOTA = { line1: '2 Test Oak Ct', city: 'Sarasota', state: 'FL', zip: '34231' };
  const buildLead = (address) => require('../routes/inspection-public')._test.buildAvailabilityForLead(
    { lat: 27.12, lng: -82.44 },
    { rangeFrom: D, rangeTo: D2, config: CONFIG, duration: 60, offer: true, ...(address ? { address } : {}) },
  );
  const datesOf = (availability) => availability.days.map((d) => d.date);
  let stopRows;
  let stopLookups;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ZONE_ROUTE_DAYS;
    stopRows = [];
    stopLookups = 0;
    wireDb();
    const generic = db('scheduled_services');
    db.mockImplementation((table) => {
      if (table === 'service_zones') return { select: jest.fn().mockResolvedValue(ZONES) };
      if (table === 'system_settings') return { where: () => ({ first: async () => undefined }) };
      if (table === 'scheduled_services') {
        return {
          ...generic,
          leftJoin: () => ({
            whereBetween: () => ({
              whereNotIn: () => ({ andWhere: () => ({ select: async () => { stopLookups++; return stopRows; } }) }),
            }),
          }),
        };
      }
      return generic;
    });
    listOccupiedWindows.mockResolvedValue([]);
    findAvailableSlots.mockResolvedValue({ slots: [slotOn(D, 1), slotOn(D1, 2), slotOn(D2, 3)], total_feasible: 3 });
  });

  test('a far-south address with a zone stop on one day is offered that day only', async () => {
    stopRows = [{ scheduled_date: D1, zone: 'venice', service_city: 'Venice', customer_city: null }];
    expect(datesOf(await buildLead(VENICE))).toEqual([D1]);
  });

  test('a far-south address with no zone stop in the window is offered the best-ranked day only (seeded)', async () => {
    expect(datesOf(await buildLead(VENICE))).toEqual([D]);
  });

  test('a lead outside the funneled zones, and a build with no address, get the full list with no zone-stop read', async () => {
    stopRows = [{ scheduled_date: D1, zone: 'venice', service_city: 'Venice', customer_city: null }];
    const sarasota = await buildLead(SARASOTA);
    const bare = await buildLead(null);
    expect(datesOf(sarasota)).toEqual([D, D1, D2]);
    const unsigned = (a) => JSON.parse(JSON.stringify(a), (k, v) => (k === 'slot_sig' ? undefined : v));
    expect(unsigned(sarasota)).toEqual(unsigned(bare));
    expect(stopLookups).toBe(0);
  });

  test('a zone-stop lookup failure serves the full list', async () => {
    db.mockImplementation((table) => {
      if (table === 'service_zones') return { select: jest.fn().mockResolvedValue(ZONES) };
      if (table === 'scheduled_services') {
        return { leftJoin: () => ({ whereBetween: () => ({ whereNotIn: () => ({ andWhere: () => ({ select: async () => { throw new Error('down'); } }) }) }) }) };
      }
      return { ...wireDbGeneric() };
    });
    expect(datesOf(await buildLead(VENICE))).toEqual([D, D1, D2]);
  });

  test('every list the route OFFERS passes the address; the commit and re-validation rebuilds omit it', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/inspection-public.js'), 'utf8');
    const calls = [...src.matchAll(/await buildAvailabilityForLead\(([^;]*?)\);/gs)].map((m) => m[1]);
    const withAddress = calls.filter((c) => /\baddress\b/.test(c));
    // GET, /availability, /find-slots, the email block's slots and the SLOT_TAKEN refresh.
    expect(withAddress).toHaveLength(5);
    // The commit's single-day anti-forgery build and revalidateSlotAt: unfunneled, like the estimate page's redeem side.
    expect(calls.filter((c) => !/\baddress\b/.test(c))).toHaveLength(2);
    expect(calls.filter((c) => !/\baddress\b/.test(c)).every((c) => /rangeFrom: date, rangeTo: date/.test(c))).toBe(true);
  });
});
