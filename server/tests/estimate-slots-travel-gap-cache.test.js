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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  // The travel-gap rule reads its gate through the registry's parser at call
  // time (scheduling/travel-gap.js); keep the real helper so the collision
  // filter runs exactly as it does in prod with the gate unset.
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
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
    throw new Error(`unexpected table ${table}`);
  });
}


const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getAvailableSlots — wrapper cache keyed by the travel policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    mockDb();
    db.raw = jest.fn((sql) => sql); // gate-on collision filter selects guarded coords
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); });

  const OPTS = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };

  test('gate flip and buffer change each miss the cache; an unchanged policy hits it', async () => {
    const off = await getAvailableSlots('est-rain-1', OPTS);
    expect(off.metadata.cacheHit).toBe(false);
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);

    // Route lane: find-time got NO buffer while the gate was off.
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 0 }));

    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
    // …and the customer-facing buffer once it is on.
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 15 }));
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);

    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '25';
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);

    // Kill switch: back to the gate-off entry (still warm), never the gate-on one.
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
  });
});
