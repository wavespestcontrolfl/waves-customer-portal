/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS, owner ruling 2026-09-29) through the
 * REAL estimate picker + REAL find-time: a Venice-zone estimate with NO south
 * visit anywhere in the window is offered — and seeded by the south-zone
 * funnel — on the Friday route day when the gate is on, and gets nothing when
 * it is off (the empty day's whole HQ round trip is over the self-serve cap).
 * Only the route simulation (arrival-route.js) and travel provider are faked:
 * every candidate is feasible with a 120-minute detour, i.e. an empty far day.
 */
process.env.GATE_SOUTH_ZONE_DAY_FUNNEL = 'true';
process.env.GATE_SCHEDULING_CAPACITY = 'true';
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GOOGLE_API_KEY;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
  getBlackoutDates: jest.fn(async () => new Set()),
  getWeeklyDaysOff: jest.fn(async () => new Set()),
  isBlackoutDate: jest.fn(async () => false),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/route-optimizer', () => ({
  ...jest.requireActual('../services/route-optimizer'),
  createSchedulingTravel: () => ({ preload: async () => {}, diagnostics: () => ({}) }),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: () => false,
  loadArrivalRouteContext: jest.fn(async () => ({
    target: { id: 'candidate', service_type: 'pest_control' },
    rows: [],
  })),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(() => ({
    feasible: true, routeOrder: ['candidate'], detourMinutes: 120,
    driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0, estimatedArrival: null, arrivals: [{}],
    finishMinute: 1000, travelSource: 'none', travelReasons: [],
  })),
}));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;

const VENICE_ZONE = { id: 'z-ven', zone_name: 'Venice / North Port', cities: ['Venice', 'Nokomis', 'North Port'] };
const SARASOTA_ZONE = { id: 'z-sar', zone_name: 'Sarasota', cities: ['Sarasota', 'Osprey'] };

const ESTIMATE_ROW = {
  id: 'est-funnel-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Shamrock Blvd, Venice, FL 34293',
  estimate_data: null,
  service_interest: 'Pest Control',
};

function scheduledServicesChain(rows) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
}

function mockDb({ scheduledRows = [], estimateRow = ESTIMATE_ROW, failFirstScheduledCall = false } = {}) {
  let scheduledCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services' && failFirstScheduledCall && scheduledCalls++ === 0) {
      // First scheduled_services query per request is the funnel's zone-stop
      // lookup — simulate a transient failure there only, so the later
      // collision queries still succeed and the request completes.
      const failing = scheduledServicesChain([]);
      failing.select.mockRejectedValue(new Error('transient outage'));
      return failing;
    }
    if (table === 'estimates') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(estimateRow),
      };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.0998,
          longitude: -82.4543,
          address_line1: '123 Shamrock Blvd',
          city: 'Venice',
          state: 'FL',
          zip: '34293',
        }),
      };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]),
      };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue([VENICE_ZONE, SARASOTA_ZONE]) };
    }
    if (table === 'scheduled_services') {
      return scheduledServicesChain(scheduledRows);
    }
    if (table === 'technician_absences') {
      // buildAsapCapacitySlots' absentTechDays read (technician-eligibility.js)
      // — no tech is marked out in this suite.
      return {
        whereBetween: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}


let settingsValue;
function withSettings() {
  const inner = db.getMockImplementation();
  db.mockImplementation((table) => {
    if (table === 'system_settings') {
      return { where: jest.fn().mockReturnThis(), first: jest.fn(async () => (settingsValue === undefined ? undefined : { value: settingsValue })) };
    }
    return inner(table);
  });
}

// 2027-05-14 is a Friday; the picker window below holds Fri 05-21 (the route
// day) plus Tue-Thu and Sat. No scheduled_services rows: no south visit yet.
const WINDOW = { dateFrom: '2027-05-18', dateTo: '2027-05-22' };
const datesOf = (result) => new Set([...(result.primary || []), ...(result.expander || [])].map((s) => s.date));

describe('estimate picker — Venice address, no south visit in the window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ZONE_ROUTE_DAYS;
    settingsValue = undefined;
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    mockDb({ scheduledRows: [] });
    withSettings();
  });
  afterEach(() => { jest.useRealTimers(); delete process.env.GATE_ZONE_ROUTE_DAYS; });
  afterAll(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

  test('gate off: nothing is offered (empty-day round trip is over the cap)', async () => {
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(datesOf(result).size).toBe(0);
  });

  test('gate on: the Friday route day is offered and seeded', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(datesOf(result)).toEqual(new Set(['2027-05-21']));
    expect(result.metadata.zoneDayFunnel).toEqual({ mode: 'seeded', seedDate: '2027-05-21' });
  });

  test('gate on: the zone comes from coordinates when the address text names no zone city (Northport)', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const saved = { cities: VENICE_ZONE.cities };
    // 'Northport' is not in service_zones.cities, so resolveEstimateZone finds
    // nothing; the estimate's coordinates (the fixture customer's Venice pin)
    // must still resolve the south pool through the zone centers.
    Object.assign(VENICE_ZONE, { center_lat: 27.0998, center_lng: -82.4543 });
    Object.assign(SARASOTA_ZONE, { center_lat: 27.3364, center_lng: -82.5307 });
    try {
      mockDb({ scheduledRows: [], estimateRow: { ...ESTIMATE_ROW, address: '123 Shamrock Blvd, Northport, FL 34287' } });
      const inner = db.getMockImplementation();
      db.mockImplementation((table) => (table === 'customers' ? {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.0998, longitude: -82.4543, address_line1: '123 Shamrock Blvd', city: 'Northport', state: 'FL', zip: '34287',
        }),
      } : inner(table)));
      withSettings();
      const result = await getAvailableSlots('est-funnel-1', WINDOW);
      expect(datesOf(result)).toEqual(new Set(['2027-05-21']));
    } finally {
      delete VENICE_ZONE.center_lat; delete VENICE_ZONE.center_lng;
      delete SARASOTA_ZONE.center_lat; delete SARASOTA_ZONE.center_lng;
      VENICE_ZONE.cities = saved.cities;
    }
  });

  test('gate on but the config moves the route day: Friday is no longer offered', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    settingsValue = '{"venice":{"weekdays":[4],"max_detour_minutes":150}}';
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(datesOf(result)).toEqual(new Set(['2027-05-20']));
  });

  test('gate on, config {}: the lift is switched off without touching the gate', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    settingsValue = '{}';
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(datesOf(result).size).toBe(0);
  });
});
