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
  // The same-hour technician scope (GATE_MULTI_TECH_CONFIRM) reads the real call-time reader.
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
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
// Only the page's list routes opt in; everything else (reserve refresh, one-tap, text rechecks) omits `offer`.
const OFFER = { ...OPTS, offer: true };
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
    await getAvailableSlots('est-rain-1', OFFER);
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
  });

  test('on: both lists go through the helper once with the estimate pin, hold and duration; its answer is served', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OFFER));
    expect(baseline.length).toBeGreaterThan(1);
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const dropped = baseline[0];
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({
      slots: slots.filter((s) => `${s.date} ${s.windowStart}` !== dropped), report: {},
    }));
    const served = keys(await getAvailableSlots('est-rain-1', OFFER));
    expect(served).not.toContain(dropped);
    // ONE call per request, over the route list and the ASAP windows together.
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(1);
    expect(routeCheck.filterOfferedSlots.mock.calls[0][0].surface).toBe('estimate');
    for (const [arg] of routeCheck.filterOfferedSlots.mock.calls) {
      expect(arg.mode).toBe('on');
      expect(arg.target.prospective).toMatchObject({ lat: 27.3364, lng: -82.5307 });
      expect(arg.target.prospective.estimated_duration_minutes).toBe(arg.durationMinutes);
      expect(arg.target.excludeEstimateId).toBe('est-rain-1');
    }
  });

  test('shadow serves today\'s list', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OFFER));
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('shadow');
    const shadow = keys(await getAvailableSlots('est-rain-1', OFFER));
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalled();
    expect(shadow).toEqual(baseline);
  });

  test('a cache hit neither recomputes nor re-logs', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const first = await getAvailableSlots('est-rain-1', OFFER);
    const calls = routeCheck.filterOfferedSlots.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second = await getAvailableSlots('est-rain-1', OFFER);
    expect(second.metadata.cacheHit).toBe(true);
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(calls);
    expect(keys(second)).toEqual(keys(first));
  });

  test('a helper failure serves the unfiltered list', async () => {
    const baseline = keys(await getAvailableSlots('est-rain-1', OFFER));
    estimateSlotAvailability._internals.clearCaches();
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    routeCheck.filterOfferedSlots.mockRejectedValue(new Error('boom'));
    expect(keys(await getAvailableSlots('est-rain-1', OFFER))).toEqual(baseline);
  });
});

describe('getAvailableSlots — route check is offer-only and its mode is part of the cache key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    routeCheck.customerRouteCheckMode.mockReturnValue('off');
    // Like the real helper: only 'on' serves the filtered list; shadow serves today's.
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots, mode }) => ({
      slots: mode === 'on' ? slots.filter((s) => s.windowStart !== '09:00') : slots, report: {},
    }));
  });
  afterEach(() => { jest.useRealTimers(); });

  const all = (result) => [...result.primary, ...result.expander];
  const has9 = (result) => all(result).some((s) => s.windowStart === '09:00');

  test('a caller that did not ask for the check gets the unfiltered list even with the gate on', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const plain = await getAvailableSlots('est-rain-1', OPTS);
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
    expect(has9(plain)).toBe(true);
  });

  test('off -> true -> off without clearing caches never serves the other mode\'s list', async () => {
    const off1 = await getAvailableSlots('est-rain-1', OFFER);
    expect(off1.metadata.cacheHit).toBe(false);
    expect(has9(off1)).toBe(true);

    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const on1 = await getAvailableSlots('est-rain-1', OFFER);
    expect(on1.metadata.cacheHit).toBe(false);
    expect(has9(on1)).toBe(false);
    expect((await getAvailableSlots('est-rain-1', OFFER)).metadata.cacheHit).toBe(true);

    routeCheck.customerRouteCheckMode.mockReturnValue('off');
    const off2 = await getAvailableSlots('est-rain-1', OFFER);
    expect(off2.metadata.cacheHit).toBe(true); // the 'off' entry is still warm
    expect(has9(off2)).toBe(true);

    routeCheck.customerRouteCheckMode.mockReturnValue('shadow');
    const shadow = await getAvailableSlots('est-rain-1', OFFER);
    expect(shadow.metadata.cacheHit).toBe(false); // its own entry
    expect(has9(shadow)).toBe(true);

    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const on2 = await getAvailableSlots('est-rain-1', OFFER);
    expect(on2.metadata.cacheHit).toBe(true);
    expect(has9(on2)).toBe(false);
  });

  test('a plain caller and an offer caller never share an entry while the gate is on', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    const offer = await getAvailableSlots('est-rain-1', OFFER);
    const plain = await getAvailableSlots('est-rain-1', OPTS);
    expect(has9(offer)).toBe(false);
    expect(has9(plain)).toBe(true);
  });
});
