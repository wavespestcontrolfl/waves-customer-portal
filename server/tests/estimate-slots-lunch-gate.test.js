/**
 * Estimate slot generator — lunch block (GATE_BOOKING_LUNCH_BLOCK, owner
 * ruling 2026-09-23). Unset (default): 12:00 is an ordinary offerable hour on
 * both the synthetic ASAP lane and the route-derived lane. Set: NO
 * customer-facing slot overlapping 12:00–13:00 leaves getAvailableSlots —
 * the ASAP grid drops noon (customerOfferGrid) and a route-derived candidate
 * whose start rounds onto noon is dropped at the shared slotWindowFitsDay
 * choke point — and the result cache keys on the gate state so a pool built
 * while noon was offerable is never served after the gate flips on.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({
    slots: [
      { date: '2027-05-20', start_time: '10:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 3 },
      // A route gap whose earliest-feasible minute lands inside the lunch hour.
      { date: '2027-05-20', start_time: '12:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 2, stops_that_day: 3 },
    ],
    evaluated: 2,
    total_feasible: 2,
  })),
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots, _internals: _test } = estimateSlotAvailability;

const ENV_KEY = 'GATE_BOOKING_LUNCH_BLOCK';
const ESTIMATE_ROW = {
  id: 'est-lunch-1', status: 'sent', expires_at: null, customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231', estimate_data: null, service_interest: 'Pest Control',
};

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.3364, longitude: -82.5307,
          address_line1: '123 Test St', city: 'Sarasota', state: 'FL', zip: '34231',
        }),
      };
    }
    if (table === 'technicians') {
      return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]) };
    }
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(), whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue([]) };
    throw new Error(`unexpected table ${table}`);
  });
}

const allOffered = (result) => [...(result.primary || []), ...(result.expander || [])];
const overlapsNoon = (s) => {
  const [sh, sm] = s.windowStart.split(':').map(Number);
  const [eh, em] = s.windowEnd.split(':').map(Number);
  const start = sh * 60 + sm; const end = eh * 60 + em;
  return start < 13 * 60 && end > 12 * 60;
};

describe('estimate slots — lunch block gate', () => {
  let previous;
  beforeEach(() => {
    previous = process.env[ENV_KEY];
    jest.clearAllMocks();
    mockDb();
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  describe('slotWindowFitsDay (the one choke point every customer-facing slot runs through)', () => {
    test('gate unset: a 12:00–13:00 window fits the day', () => {
      delete process.env[ENV_KEY];
      expect(_test.slotWindowFitsDay('12:00', '13:00')).toBe(true);
    });
    test('gate on: any window overlapping 12:00–13:00 is rejected; touching windows still fit', () => {
      process.env[ENV_KEY] = 'true';
      expect(_test.slotWindowFitsDay('12:00', '13:00')).toBe(false);
      expect(_test.slotWindowFitsDay('11:30', '12:30')).toBe(false);
      expect(_test.slotWindowFitsDay('10:00', '14:00')).toBe(false);
      expect(_test.slotWindowFitsDay('11:00', '12:00')).toBe(true);
      expect(_test.slotWindowFitsDay('13:00', '14:00')).toBe(true);
    });
    test('gate on + GATE_SCHEDULING_CAPACITY on: the lunch predicate still rejects noon ahead of the shift-fit branch', () => {
      process.env[ENV_KEY] = 'true';
      const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      try {
        expect(_test.slotWindowFitsDay('12:00', '13:00')).toBe(false);
        expect(_test.slotWindowFitsDay('11:30', '12:30')).toBe(false);
        // Non-lunch windows fall through to the capacity shift-fit check.
        expect(_test.slotWindowFitsDay('10:00', '11:00')).toBe(true);
        expect(_test.slotWindowFitsDay('13:00', '14:00')).toBe(true);
      } finally {
        if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
        else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
      }
    });
    test('gate on: the day-end bound still applies first (18:00 close)', () => {
      process.env[ENV_KEY] = 'true';
      expect(_test.slotWindowFitsDay('17:00', '18:00')).toBe(true);
      expect(_test.slotWindowFitsDay('17:30', '18:30')).toBe(false);
    });
  });

  describe('buildAsapCapacitySlotsForTechs (synthetic hourly lane)', () => {
    const techs = [{ id: 'tech-1', name: 'Adam Benetti' }];
    test('gate unset: 12:00 is on the grid', () => {
      delete process.env[ENV_KEY];
      const slots = _test.buildAsapCapacitySlotsForTechs({ dateFrom: '2027-05-20', dateTo: '2027-05-20', durationMinutes: 60, techs, now: new Date() });
      expect(slots.map((s) => s.windowStart)).toContain('12:00');
      expect(slots.map((s) => s.windowStart)).toContain('17:00');
    });
    test('gate on: noon is skipped, every other grid hour stays', () => {
      process.env[ENV_KEY] = 'true';
      const slots = _test.buildAsapCapacitySlotsForTechs({ dateFrom: '2027-05-20', dateTo: '2027-05-20', durationMinutes: 60, techs, now: new Date() });
      expect(slots.map((s) => s.windowStart)).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
    });
    test('gate on: a 120-minute window starting 11:00 (11:00–13:00) is dropped too, not just the 12:00 start', () => {
      process.env[ENV_KEY] = 'true';
      const slots = _test.buildAsapCapacitySlotsForTechs({ dateFrom: '2027-05-20', dateTo: '2027-05-20', durationMinutes: 120, techs, now: new Date() });
      expect(slots.every((s) => !overlapsNoon(s))).toBe(true);
      expect(slots.map((s) => s.windowStart)).not.toContain('11:00');
      expect(slots.map((s) => s.windowStart)).not.toContain('12:00');
    });
  });

  describe('getAvailableSlots (route lane + ASAP lane + result cache)', () => {
    const opts = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };

    test('gate unset: noon is offered', async () => {
      delete process.env[ENV_KEY];
      const result = await getAvailableSlots('est-lunch-1', opts);
      expect(allOffered(result).some(overlapsNoon)).toBe(true);
    });

    test('gate on: nothing offered overlaps 12:00–13:00 — the route-derived 12:00 candidate is dropped, not just the ASAP window', async () => {
      process.env[ENV_KEY] = 'true';
      const result = await getAvailableSlots('est-lunch-1', opts);
      const offered = allOffered(result);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.some(overlapsNoon)).toBe(false);
      // The 10:00 route candidate survives — only the noon one was filtered.
      expect(offered.some((s) => s.windowStart === '10:00' && s.capacityType !== 'asap_open')).toBe(true);
    });

    test('a result cached while noon was offerable is not served after the gate flips on (gate state is in the cache key)', async () => {
      delete process.env[ENV_KEY];
      const before = await getAvailableSlots('est-lunch-1', opts);
      expect(allOffered(before).some(overlapsNoon)).toBe(true);
      expect(before.metadata.cacheHit).toBe(false);

      process.env[ENV_KEY] = 'true';
      const after = await getAvailableSlots('est-lunch-1', opts);
      expect(after.metadata.cacheHit).toBe(false);
      expect(allOffered(after).some(overlapsNoon)).toBe(false);

      // And flipping back reuses the noon-open entry rather than the blocked one.
      delete process.env[ENV_KEY];
      const again = await getAvailableSlots('est-lunch-1', opts);
      expect(allOffered(again).some(overlapsNoon)).toBe(true);
    });
  });
});
