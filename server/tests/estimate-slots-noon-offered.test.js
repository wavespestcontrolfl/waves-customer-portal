/**
 * Estimate slot generator — noon is a normal offerable hour (owner ruling
 * 2026-09-23). 12:00 is an ordinary offerable hour on both the synthetic ASAP
 * lane and the route-derived lane, and the result cache keys on the
 * booking_config-resolved bounds.
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
  zoneRouteDaysLive: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  // The same-hour technician scope (GATE_MULTI_TECH_CONFIRM) reads the real call-time reader.
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
}));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots, _internals: _test } = estimateSlotAvailability;

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

const allOffered = (result) => [...(result.primary || []), ...(result.expander || [])];
const overlapsNoon = (s) => {
  const [sh, sm] = s.windowStart.split(':').map(Number);
  const [eh, em] = s.windowEnd.split(':').map(Number);
  const start = sh * 60 + sm; const end = eh * 60 + em;
  return start < 13 * 60 && end > 12 * 60;
};

describe('estimate slots — noon is a normal hour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb();
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('slotWindowFitsDay (the one choke point every customer-facing slot runs through)', () => {
    test('a 12:00–13:00 window fits the day', () => {
      expect(_test.slotWindowFitsDay('12:00', '13:00')).toBe(true);
    });
    test('the day-end bound still applies (18:00 close)', () => {
      expect(_test.slotWindowFitsDay('17:00', '18:00')).toBe(true);
      expect(_test.slotWindowFitsDay('17:30', '18:30')).toBe(false);
    });
  });

  describe('buildAsapCapacitySlotsForTechs (synthetic hourly lane)', () => {
    const techs = [{ id: 'tech-1', name: 'Adam Benetti' }];
    test('12:00 is on the grid', () => {
      const slots = _test.buildAsapCapacitySlotsForTechs({ dateFrom: '2027-05-20', dateTo: '2027-05-20', durationMinutes: 60, techs, now: new Date() });
      expect(slots.map((s) => s.windowStart)).toContain('12:00');
      expect(slots.map((s) => s.windowStart)).toContain('17:00');
    });
  });

  describe('getAvailableSlots (route lane + ASAP lane + result cache)', () => {
    const opts = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };

    test('noon is offered', async () => {
      const result = await getAvailableSlots('est-lunch-1', opts);
      expect(allOffered(result).some(overlapsNoon)).toBe(true);
    });

    // Codex push-audit P1 on #4663: the cache key includes the
    // booking_config-resolved lunch interval/day-end. The resolved bounds
    // refresh on their own 60s TTL, independent of this 5-min offer cache —
    // an owner changing the configured bounds mid-window must invalidate the
    // cached pool too, or reservation validation (which re-reads current
    // config) would reject offers this cache kept serving.
    test('a resolved-bounds change produces a fresh cache key, not a stale hit', async () => {
      let bookingConfigRow = { lunch_start: '12:00:00', lunch_end: '13:00:00', day_end: '18:00:00' };
      db.mockImplementation((table) => {
        if (table === 'booking_config') return { first: jest.fn().mockResolvedValue(bookingConfigRow) };
        if (table === 'estimates') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
        if (table === 'customers') {
          return {
            where: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              latitude: 27.3364, longitude: -82.5307,
              address_line1: '123 Test St', city: 'Sarasota', state: 'FL', zip: '34231',
            }),
          };
        }
        if (table === 'technicians') return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]) };
        if (table === 'scheduled_services') {
          return {
            leftJoin: jest.fn().mockReturnThis(), whereBetween: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([]),
          };
        }
        if (table === 'service_zones') return { select: jest.fn().mockResolvedValue([]) };
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
      estimateSlotAvailability._internals.clearCaches();
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
        const before = await getAvailableSlots('est-lunch-1', opts);
        expect(before.metadata.cacheHit).toBe(false);

        // The customer-windows 60s config TTL, not this 5-min offer cache,
        // is what needs to expire for the change below to actually be read.
        // Same UTC hour bucket (15:xx), so cacheHour() alone would NOT
        // change the offer cache key — only the resolved-bounds addition does.
        jest.setSystemTime(new Date('2027-05-01T15:01:05Z'));
        bookingConfigRow = { lunch_start: '10:00:00', lunch_end: '11:00:00', day_end: '18:00:00' };
        const after = await getAvailableSlots('est-lunch-1', opts);
        expect(after.metadata.cacheHit).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
