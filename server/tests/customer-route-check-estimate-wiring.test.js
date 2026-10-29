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
jest.mock('../services/scheduling/customer-route-check', () => ({
  customerRouteCheckMode: jest.fn(() => 'off'),
  filterOfferedSlots: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  zoneRouteDaysLive: jest.fn(() => false),
  // The travel-gap rule reads its gate through the registry's parser at call
  // time (scheduling/travel-gap.js); keep the real helper so the collision
  // filter runs exactly as it does in prod with the gate unset.
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));

const db = require('../models/db');
const routeCheck = require('../services/scheduling/customer-route-check');
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



const OPTS = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };
const saved = process.env.GATE_SCHEDULING_CAPACITY;
afterAll(() => {
  if (saved === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
  else process.env.GATE_SCHEDULING_CAPACITY = saved;
});

describe('getAvailableSlots — route check wiring (GATE_CUSTOMER_ROUTE_CHECK)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    routeCheck.customerRouteCheckMode.mockReturnValue('off');
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({ slots, report: {} }));
  });
  afterEach(() => { jest.useRealTimers(); });

  const keys = (result) => [...result.primary, ...result.expander].map((s) => `${s.date} ${s.windowStart}`);

  test('gate off: the helper is never called', async () => {
    await getAvailableSlots('est-rain-1', OPTS);
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
  });

  test('on: both lists go through the helper with the estimate pin, hold and duration; its answer is served', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OPTS));
    expect(baseline.length).toBeGreaterThan(1);
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const dropped = baseline[0];
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({
      slots: slots.filter((s) => `${s.date} ${s.windowStart}` !== dropped), report: {},
    }));
    const served = keys(await getAvailableSlots('est-rain-1', OPTS));
    expect(served).not.toContain(dropped);
    const surfaces = routeCheck.filterOfferedSlots.mock.calls.map(([a]) => a.surface);
    expect(surfaces).toContain('estimate');
    expect(surfaces).toContain('estimate_asap');
    for (const [arg] of routeCheck.filterOfferedSlots.mock.calls) {
      expect(arg.mode).toBe('on');
      expect(arg.target.prospective).toMatchObject({ lat: 27.3364, lng: -82.5307 });
      expect(arg.target.prospective.estimated_duration_minutes).toBe(arg.durationMinutes);
      expect(arg.target.excludeEstimateId).toBe('est-rain-1');
    }
  });

  test('shadow serves today\'s list', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OPTS));
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('shadow');
    const shadow = keys(await getAvailableSlots('est-rain-1', OPTS));
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalled();
    expect(shadow).toEqual(baseline);
  });

  test('a cache hit neither recomputes nor re-logs', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const first = await getAvailableSlots('est-rain-1', OPTS);
    const calls = routeCheck.filterOfferedSlots.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second = await getAvailableSlots('est-rain-1', OPTS);
    expect(second.metadata.cacheHit).toBe(true);
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(calls);
    expect(keys(second)).toEqual(keys(first));
  });

  test('a helper failure serves the unfiltered list', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OPTS));
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    routeCheck.filterOfferedSlots.mockRejectedValue(new Error('boom'));
    expect(keys(await getAvailableSlots('est-rain-1', OPTS))).toEqual(baseline);
  });
});
