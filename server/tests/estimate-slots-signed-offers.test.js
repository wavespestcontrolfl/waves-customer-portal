/**
 * Estimate-surface signed slot offers, end to end through the generator
 * (booking-audit round 2): getAvailableSlots must return slotIds carrying a
 * live `.exp.sig` suffix whose HMAC verifies for THIS estimate over the
 * slot's own (date, start, tech, duration) — the exact check reserveSlot
 * enforces — and the signature must NOT verify for any other estimate.
 * The clients stay untouched because the sig rides inside the slotId string.
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
const { splitSignedSlotId, verifySlotOffer } = require('../utils/slot-offer-token');

const ESTIMATE_ROW = {
  id: 'est-signed-1',
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
      // Zone-capacity parity (estimate-slots-zone-parity.test.js) — no zones
      // here, so the zone exclusion stays inert in this suite.
      return { select: jest.fn().mockResolvedValue([]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe('getAvailableSlots — signed offers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb();
    estimateSlotAvailability._internals.clearCaches();
  });

  test('every returned slot carries a live signature that verifies for THIS estimate only', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    try {
      const result = await getAvailableSlots('est-signed-1', {});
      const slots = [...(result.primary || []), ...(result.expander || [])];
      expect(slots.length).toBeGreaterThan(0);

      for (const slot of slots) {
        const signed = splitSignedSlotId(slot.slotId);
        expect(signed).not.toBeNull();
        // Base id keeps the pre-signing shape the reservation layer parses.
        expect(signed.baseSlotId).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_.+$/);
        const [h, m] = slot.windowStart.split(':').map(Number);
        const payload = {
          surface: 'estimate',
          scopeId: 'est-signed-1',
          date: slot.date,
          startMinutes: h * 60 + m,
          technicianId: slot.techId || null,
          durationMinutes: slot.durationMinutes,
          exp: signed.exp,
        };
        // Verifies exactly as reserveSlot will…
        expect(verifySlotOffer(payload, signed.sig)).toBe(true);
        // …and not for any other estimate (scope binding).
        expect(verifySlotOffer({ ...payload, scopeId: 'est-other' }, signed.sig)).toBe(false);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('the route-derived find-time slot is among the signed offers', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    try {
      // Pin to the route slot's day so the cross-day spread can't slice it out.
      const result = await getAvailableSlots('est-signed-1', { dateFrom: '2027-05-20', dateTo: '2027-05-20' });
      const slots = [...(result.primary || []), ...(result.expander || [])];
      const routeSlot = slots.find((s) => s.routeOptimal);
      expect(routeSlot).toBeDefined();
      expect(splitSignedSlotId(routeSlot.slotId)).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
