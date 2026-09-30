/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS, owner ruling 2026-09-29) at the
 * find-time seam: the customer-facing detour cap becomes PER CANDIDATE — lifted
 * for the request's zone on that zone's route weekday (and pinned technician),
 * the flat normal cap everywhere else. Route evaluation is mocked exactly like
 * find-time-customer-grid.test.js; every candidate is "feasible" with a 120
 * minute detour (an empty far day's whole HQ round trip).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
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
const { findAvailableSlots } = require('../services/scheduling/find-time');

let settingsValue; // undefined = key absent (code default)
function chain(result) {
  const c = {};
  ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}
function mockDb(techs = [{ id: 'tech-1', name: 'A' }]) {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain(techs);
    if (table === 'system_settings') {
      const c = chain([]);
      c.first = async () => (settingsValue === undefined ? undefined : { value: settingsValue });
      return c;
    }
    return chain([]);
  });
}

// First date >= 29 days out that falls on the given ET weekday (0=Sun).
function futureDateOn(weekday) {
  const date = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
  date.setUTCHours(12, 0, 0, 0);
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
const FRIDAY = futureDateOn(5);
const THURSDAY = futureDateOn(4);

const base = (date, extra = {}) => ({
  lat: 27.12, lng: -82.44, durationMinutes: 60, dateFrom: date, dateTo: date, topN: 50,
  serviceType: 'pest_control', customerFacing: true, ...extra,
});

describe('per-candidate detour cap (capacity mode, GATE_ZONE_ROUTE_DAYS)', () => {
  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    delete process.env.GATE_ZONE_ROUTE_DAYS;
    delete process.env.SCHEDULING_MAX_DETOUR_MINUTES;
    settingsValue = undefined;
    mockDb();
  });
  afterEach(() => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    delete process.env.GATE_ZONE_ROUTE_DAYS;
  });

  test('gate off: a Venice request on a Friday is capped like everyone else (nothing offered)', async () => {
    const result = await findAvailableSlots(base(FRIDAY, { zoneSlug: 'venice' }));
    expect(result.slots).toEqual([]);
    expect(result.rejections.detour_cap).toBeGreaterThan(0);
  });

  test('gate on: the Venice Friday is lifted, the Venice Thursday is not', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const friday = await findAvailableSlots(base(FRIDAY, { zoneSlug: 'venice' }));
    expect(friday.slots.length).toBeGreaterThan(0);
    expect(friday.slots[0].detour_minutes).toBe(120);
    expect(friday.rejections.detour_cap).toBeUndefined();
    const thursday = await findAvailableSlots(base(THURSDAY, { zoneSlug: 'venice' }));
    expect(thursday.slots).toEqual([]);
    expect(thursday.rejections.detour_cap).toBeGreaterThan(0);
  });

  test('gate on: a request with no zone, or another zone, keeps the cap on a Friday', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect((await findAvailableSlots(base(FRIDAY))).slots).toEqual([]);
    expect((await findAvailableSlots(base(FRIDAY, { zoneSlug: 'sarasota' }))).slots).toEqual([]);
  });

  test('gate on: staff callers (not customerFacing) are unchanged — every fit, no cap', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const result = await findAvailableSlots(base(THURSDAY, { customerFacing: false, zoneSlug: 'venice' }));
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.rejections.detour_cap).toBeUndefined();
  });

  test('the stored config overrides the default (Thursday route day, tighter cap)', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    settingsValue = '{"venice":{"weekdays":[4],"max_detour_minutes":100}}';
    expect((await findAvailableSlots(base(THURSDAY, { zoneSlug: 'venice' }))).slots).toEqual([]); // 120 > 100
    settingsValue = '{"venice":{"weekdays":[4],"max_detour_minutes":130}}';
    expect((await findAvailableSlots(base(THURSDAY, { zoneSlug: 'venice' }))).slots.length).toBeGreaterThan(0);
    expect((await findAvailableSlots(base(FRIDAY, { zoneSlug: 'venice' }))).slots).toEqual([]); // no longer a route day
  });

  test('technician pin: only the pinned technician gets the Friday offers', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    settingsValue = '{"venice":{"weekdays":[5],"max_detour_minutes":150,"technician_id":"tech-2"}}';
    mockDb([{ id: 'tech-1', name: 'A' }, { id: 'tech-2', name: 'B' }]);
    const result = await findAvailableSlots(base(FRIDAY, { zoneSlug: 'venice' }));
    expect(result.slots.length).toBeGreaterThan(0);
    expect(new Set(result.slots.map((s) => s.technician.id))).toEqual(new Set(['tech-2']));
    expect(result.rejections.detour_cap).toBeGreaterThan(0); // tech-1's candidates
  });

  test('a config read failure leaves the normal cap in force (fails closed, never throws)', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    db.mockImplementation((table) => {
      if (table === 'system_settings') throw new Error('settings down');
      return table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([]);
    });
    const result = await findAvailableSlots(base(FRIDAY, { zoneSlug: 'venice' }));
    expect(result.slots).toEqual([]);
  });
});
