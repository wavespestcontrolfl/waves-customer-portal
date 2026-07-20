/**
 * Estimate slot rain chips (GATE_BOOKING_RAIN_CHIPS): getAvailableSlots
 * stamps the office-point daily rain chance onto every customer-facing slot
 * (per-date — slots on the same date share it) when the gate is on, and the
 * field is ABSENT — payload byte-identical to today — when the gate is off
 * or the outlook is unavailable (fail-open). The stamp lands BEFORE signing,
 * so signed/cached slots carry it.
 */
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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const { getDailyRainOutlookBounded } = require('../services/weather-forecast');
const { isEnabled } = require('../config/feature-gates');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;

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

const allSlots = (result) => [...(result.primary || []), ...(result.expander || [])];

describe('getAvailableSlots — rain chips (GATE_BOOKING_RAIN_CHIPS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb();
    // Default: every gate off; individual tests opt bookingRainChips on.
    isEnabled.mockImplementation(() => false);
    getDailyRainOutlookBounded.mockResolvedValue(null);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('gate ON: every slot on a forecast date carries that date\'s rainChance', async () => {
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue({
      '2027-05-20': { rainChance: 55, shortForecast: 'Showers' },
    });

    const result = await getAvailableSlots('est-rain-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    const slots = allSlots(result);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.rainChance).toBe(55);
    }
    // ONE office-point lookup per generation.
    expect(getDailyRainOutlookBounded).toHaveBeenCalledTimes(1);
    expect(getDailyRainOutlookBounded).toHaveBeenCalledWith(27.4217, -82.4065);
  });

  test('gate ON: dates missing from the outlook get NO field (per-date stamp)', async () => {
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue({
      '2027-05-21': { rainChance: 80, shortForecast: 'Storms' }, // different day
    });

    const result = await getAvailableSlots('est-rain-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    const slots = allSlots(result);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot).not.toHaveProperty('rainChance');
    }
  });

  test('gate ON + outlook null (deadline/outage): fail-open, field absent', async () => {
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue(null);

    const result = await getAvailableSlots('est-rain-1', {});
    for (const slot of allSlots(result)) {
      expect(slot).not.toHaveProperty('rainChance');
    }
  });

  test('gate OFF: no weather lookup at all and the field is absent', async () => {
    getDailyRainOutlookBounded.mockResolvedValue({
      '2027-05-20': { rainChance: 55, shortForecast: 'Showers' },
    });

    const result = await getAvailableSlots('est-rain-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    const slots = allSlots(result);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot).not.toHaveProperty('rainChance');
    }
    expect(getDailyRainOutlookBounded).not.toHaveBeenCalled();
  });

  test('gate flipped OFF after a gate-on cache write: cache hits stop serving rainChance', async () => {
    // First generation with the gate ON populates the 5-min wrapper cache
    // with rainChance-stamped (signed) slots.
    isEnabled.mockImplementation((gate) => gate === 'bookingRainChips');
    getDailyRainOutlookBounded.mockResolvedValue({
      '2027-05-20': { rainChance: 55, shortForecast: 'Showers' },
    });
    const warm = await getAvailableSlots('est-rain-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    expect(allSlots(warm).every((s) => s.rainChance === 55)).toBe(true);

    // Kill switch: same request now hits the cache, but the gate-off strip
    // must win — no rainChance anywhere, and no new weather lookup.
    isEnabled.mockImplementation(() => false);
    getDailyRainOutlookBounded.mockClear();
    const afterKill = await getAvailableSlots('est-rain-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    expect(afterKill.metadata.cacheHit).toBe(true);
    const slots = allSlots(afterKill);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot).not.toHaveProperty('rainChance');
    }
    expect(getDailyRainOutlookBounded).not.toHaveBeenCalled();
  });
});
