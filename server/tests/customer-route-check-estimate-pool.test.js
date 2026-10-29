jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({
    slots: [{
      date: '2027-05-20',
      start_time: '09:00',
      technician: { id: 'tech-1', name: 'Adam Benetti' },
      detour_minutes: 4,
      stops_that_day: 3,
    }],
    evaluated: 1,
    total_feasible: 1,
  })),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => true),
  loadArrivalRouteContext: jest.fn(),
  evaluateArrivalPlacement: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  customerRouteCheckMode: () => global.__routeCheckMode || 'off',
  zoneRouteDaysLive: jest.fn(() => false),
  // The travel-gap rule reads its gate through the registry's parser at call
  // time (scheduling/travel-gap.js); keep the real helper so the collision
  // filter runs exactly as it does in prod with the gate unset.
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));

const db = require('../models/db');
const arrivalRoute = require('../services/scheduling/arrival-route');
const routeCheck = require('../services/scheduling/customer-route-check');
const logger = require('../services/logger');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;

/**
 * Wrapper-cache key vs the travel policy (GH codex #3803 r1 P1): reserveSlot
 * reads GATE_SLOT_TRAVEL_GAP / SLOT_TRAVEL_BUFFER_MINUTES at call time, but
 * filterCollidingSlots ran when the 5-minute wrapper entry was built. A flip
 * or buffer change must miss the cache, or the picker keeps serving slots the
 * reserve now rejects until TTL.
 */
const ESTIMATE_ROW = {
  id: 'est-rain-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231',
  estimate_data: null,
  service_interest: 'Pest Control',
};

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(ESTIMATE_ROW),
      };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.3364,
          longitude: -82.5307,
          address_line1: '123 Test St',
          city: 'Sarasota',
          state: 'FL',
          zip: '34231',
        }),
      };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]),
      };
    }
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue([]) };
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



/**
 * Estimate page: ONE route check per request over the route list and the ASAP
 * windows together (real helper, mocked route simulation). One floor, one
 * budget, one context cache; survivors are split back to their own list.
 */
const OFFER = { dateFrom: '2027-05-20', dateTo: '2027-05-20', offer: true };
const slotKeys = (result) => [...result.primary, ...result.expander].map((s) => `${s.date} ${s.windowStart}`);

describe('getAvailableSlots — one combined route check per request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    global.__routeCheckMode = 'on';
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    arrivalRoute.arrivalWindowRoutingEnabled.mockReturnValue(true);
    arrivalRoute.loadArrivalRouteContext.mockImplementation(async ({ date, technicianId }) => ({ rows: [], date, technicianId }));
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue({ feasible: true });
  });
  afterEach(() => { jest.useRealTimers(); delete global.__routeCheckMode; });

  const summaryLines = () => logger.info.mock.calls.map(([l]) => l).filter((l) => l.startsWith('[customer-route-check] surface='));

  test('the route list fails every near-term start but ASAP has safe ones: the failures go (no floor restore)', async () => {
    global.__routeCheckMode = 'off';
    const before = slotKeys(await getAvailableSlots('est-rain-1', OFFER));
    expect(before).toContain('2027-05-20 09:00');
    estimateSlotAvailability._internals.clearCaches();
    global.__routeCheckMode = 'on';
    // The only route-list start (09:00) would make another customer late; the other hours are fine.
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => (windowStart === '09:00' ? { feasible: false, reason: 'arrival_window' } : { feasible: true }));
    const after = slotKeys(await getAvailableSlots('est-rain-1', OFFER));
    expect(after).not.toContain('2027-05-20 09:00');
    expect(after.length).toBeGreaterThan(0);
    expect(summaryLines()[0]).toContain('floor_kept=false');
  });

  test('the floor holds across the combined pool: nothing safe near-term in either list keeps both whole', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue({ feasible: false, reason: 'arrival_window' });
    const served = slotKeys(await getAvailableSlots('est-rain-1', OFFER));
    expect(served).toContain('2027-05-20 09:00');
    expect(summaryLines()[0]).toContain('floor_kept=true');
  });

  test('one check, one budget, one log line, and each route is read once', async () => {
    const spy = jest.spyOn(routeCheck, 'filterOfferedSlots');
    await getAvailableSlots('est-rain-1', OFFER);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].surface).toBe('estimate');
    expect(summaryLines()).toHaveLength(1);
    const keys = arrivalRoute.loadArrivalRouteContext.mock.calls.map(([a]) => `${a.date}|${a.technicianId}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    spy.mockRestore();
  });

  test('the check sees only the final eligible pool: a morning-only search is checked on morning slots alone', async () => {
    const spy = jest.spyOn(routeCheck, 'filterOfferedSlots');
    await getAvailableSlots('est-rain-1', { ...OFFER, timeOfDay: 'morning' });
    const checked = spy.mock.calls[0][0].slots;
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((s) => s.windowStart < '12:00')).toBe(true);
    spy.mockRestore();
  });

  test('morning-only search where every morning start fails and only an afternoon start passes: the morning offers come back, never an empty picker', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => (windowStart < '12:00' ? { feasible: false, reason: 'arrival_window' } : { feasible: true }));
    const served = slotKeys(await getAvailableSlots('est-rain-1', { ...OFFER, timeOfDay: 'morning' }));
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((k) => k.split(' ')[1] < '12:00')).toBe(true);
    expect(served).toContain('2027-05-20 09:00');
    expect(summaryLines()[0]).toContain('floor_kept=true');
  });

  test('a cache hit does not check again', async () => {
    await getAvailableSlots('est-rain-1', OFFER);
    expect((await getAvailableSlots('est-rain-1', OFFER)).metadata.cacheHit).toBe(true);
    expect(summaryLines()).toHaveLength(1);
  });
});
