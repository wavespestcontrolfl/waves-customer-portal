/**
 * Generator ↔ reserve zone-capacity parity (live dead-end found 2026-07-13):
 * reserveSlot rejects any window overlapping an UNASSIGNED scheduled service
 * in the estimate's zone, but filterCollidingSlots only compared same-tech
 * rows — so the generator kept offering the window, every tap 409'd with
 * "slot no longer available", and the refreshed list still contained the
 * same slot. These tests pin the generator to the reserve gate's semantics:
 *   - unassigned same-zone bookings block the window (zone slug OR customer
 *     city match),
 *   - a techless candidate collides against ALL live rows that day (reserve
 *     drops its technician filter for techless slots),
 *   - no zone resolved → zone gate off, same as reserveSlot.
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

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;
const { filterCollidingSlots } = estimateSlotAvailability._internals;

const ESTIMATE_ROW = {
  id: 'est-zone-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231',
  estimate_data: null,
  service_interest: 'Pest Control',
};

const SARASOTA_ZONE = { id: 'z-sar', zone_name: 'Sarasota', cities: ['Sarasota', 'Osprey'] };
const PARRISH_ZONE = { id: 'z-par', zone_name: 'Parrish', cities: ['Parrish', 'Ellenton'] };

function scheduledServicesChain(rows) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
}

function mockDb({ scheduledRows = [] } = {}) {
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
    if (table === 'service_zones') {
      return {
        select: jest.fn().mockResolvedValue([SARASOTA_ZONE, PARRISH_ZONE]),
      };
    }
    if (table === 'scheduled_services') {
      return scheduledServicesChain(scheduledRows);
    }
    throw new Error(`unexpected table ${table}`);
  });
}

// An unassigned committed booking occupying 9:00–11:00 — the live shape that
// produced the dead-end loop (confirmed self-booking, technician_id NULL).
function unassignedRow(overrides = {}) {
  return {
    technician_id: null,
    scheduled_date: '2027-05-20',
    window_start: '09:00:00',
    window_end: '11:00:00',
    estimated_duration_minutes: null,
    zone: 'sarasota',
    customer_city: null,
    ...overrides,
  };
}

function slot(overrides = {}) {
  return {
    slotId: '2027-05-20_10-00_tech-1',
    date: '2027-05-20',
    windowStart: '10:00',
    windowEnd: '11:00',
    durationMinutes: 60,
    techId: 'tech-1',
    ...overrides,
  };
}

const RANGE = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };

describe('filterCollidingSlots — reserve-gate parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    estimateSlotAvailability._internals.clearCaches();
  });

  test('drops a tech slot overlapping an unassigned booking in the estimate zone (slug match)', async () => {
    mockDb({ scheduledRows: [unassignedRow()] });
    const out = await filterCollidingSlots([slot()], { ...RANGE, estimateZone: SARASOTA_ZONE });
    expect(out).toHaveLength(0);
  });

  test('zone match via linked-customer city when the row has no zone slug', async () => {
    mockDb({ scheduledRows: [unassignedRow({ zone: null, customer_city: 'Sarasota' })] });
    const out = await filterCollidingSlots([slot()], { ...RANGE, estimateZone: SARASOTA_ZONE });
    expect(out).toHaveLength(0);
  });

  test('keeps the slot when the unassigned booking is in a different zone', async () => {
    mockDb({ scheduledRows: [unassignedRow({ zone: 'parrish' })] });
    const out = await filterCollidingSlots([slot()], { ...RANGE, estimateZone: SARASOTA_ZONE });
    expect(out).toHaveLength(1);
  });

  test('keeps the slot when no estimate zone resolved — zone gate off, same as reserveSlot', async () => {
    mockDb({ scheduledRows: [unassignedRow()] });
    const out = await filterCollidingSlots([slot()], { ...RANGE, estimateZone: null });
    expect(out).toHaveLength(1);
  });

  test('keeps a same-zone slot that touches but does not overlap the booking', async () => {
    mockDb({ scheduledRows: [unassignedRow()] });
    const out = await filterCollidingSlots(
      [slot({ slotId: '2027-05-20_11-00_tech-1', windowStart: '11:00', windowEnd: '12:00' })],
      { ...RANGE, estimateZone: SARASOTA_ZONE },
    );
    expect(out).toHaveLength(1);
  });

  test('a techless slot collides against tech-assigned rows (reserve drops its tech filter)', async () => {
    mockDb({
      scheduledRows: [unassignedRow({ technician_id: 'tech-1', zone: null })],
    });
    const out = await filterCollidingSlots(
      [slot({ slotId: '2027-05-20_10-00_unassigned', techId: null })],
      { ...RANGE, estimateZone: null },
    );
    expect(out).toHaveLength(0);
  });

  test('same-tech collisions still drop the slot (pre-existing behavior)', async () => {
    mockDb({
      scheduledRows: [unassignedRow({ technician_id: 'tech-1', zone: null })],
    });
    const out = await filterCollidingSlots([slot()], { ...RANGE, estimateZone: null });
    expect(out).toHaveLength(0);
  });
});

describe('getAvailableSlots — zone capacity end to end', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    estimateSlotAvailability._internals.clearCaches();
  });

  function overlapsBlockedWindow(s) {
    const toMin = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    return s.date === '2027-05-20' && toMin(s.windowStart) < 11 * 60 && toMin(s.windowEnd) > 9 * 60;
  }

  test('no offered slot overlaps an unassigned same-zone booking', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    try {
      mockDb({ scheduledRows: [unassignedRow()] });
      const result = await getAvailableSlots('est-zone-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
      const slots = [...(result.primary || []), ...(result.expander || [])];
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.filter(overlapsBlockedWindow)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('control: the same booking in another zone leaves the 9 AM route slot offered', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    try {
      mockDb({ scheduledRows: [unassignedRow({ zone: 'parrish' })] });
      const result = await getAvailableSlots('est-zone-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
      const slots = [...(result.primary || []), ...(result.expander || [])];
      expect(slots.some(overlapsBlockedWindow)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
