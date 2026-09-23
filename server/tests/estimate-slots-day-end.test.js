/**
 * Estimate slot generator — customer-facing day end (PR 2, 2026-09-23):
 * findEstimateSlots must ask find-time for slots through 18:00 (a 17:00
 * start plus the standard 60-minute visit), not find-time's own DAY_END_HOUR
 * default of 17 (which stays untouched for staff/optimizer callers that
 * never pass this option).
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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots, getSlotDebug, SLOT_DAY_END_MINUTES } = estimateSlotAvailability;
const { CUSTOMER_DAY_END_HOUR, CUSTOMER_DAY_END_MINUTES } = require('../services/scheduling/customer-windows');

const ESTIMATE_ROW = {
  id: 'est-dayend-1',
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
      return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
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

describe('findEstimateSlots — customer-facing day end', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb();
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); });

  test('the shared constant is 18:00, matching a 17:00 start + the standard 60-minute visit', () => {
    expect(CUSTOMER_DAY_END_HOUR).toBe(18);
    expect(SLOT_DAY_END_MINUTES).toBe(CUSTOMER_DAY_END_MINUTES);
    expect(SLOT_DAY_END_MINUTES).toBe(18 * 60);
  });

  test('the live generator passes dayEndHour: 18 to find-time on every call, not find-time\'s own 17 default', async () => {
    await getAvailableSlots('est-dayend-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    expect(findAvailableSlots).toHaveBeenCalled();
    for (const call of findAvailableSlots.mock.calls) {
      expect(call[0]).toMatchObject({ dayEndHour: 18 });
    }
  });

  test('the debug surface (getSlotDebug) also passes dayEndHour: 18', async () => {
    await getSlotDebug('est-dayend-1', { windowDays: 1 });
    expect(findAvailableSlots).toHaveBeenCalled();
    for (const call of findAvailableSlots.mock.calls) {
      expect(call[0]).toMatchObject({ dayEndHour: 18 });
    }
  });
});
