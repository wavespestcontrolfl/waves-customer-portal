/**
 * createSelfBooking signed-offer gate (booking-audit round 2).
 *
 * /confirm's geometry/date/duration mirrors can't prove a (date, start,
 * technician, duration) tuple was ever OFFERED — so the commit path requires
 * the HMAC the availability builder attached to each slot (`slot_sig`).
 * These tests drive createSelfBooking up to (and just past) the gate with a
 * table-keyed db mock: identity resolves via a verified estimate, and a
 * request that clears the gate is proven by reaching the customer lookup
 * (mocked to null → 404), which sits AFTER the signature check.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { createSelfBooking } = require('../routes/booking')._internals;
const { mintSlotOfferField, SLOT_OFFER_TTL_MS } = require('../utils/slot-offer-token');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SLOT_DATE = etDateString(addETDays(new Date(), 3));
const TECH_ID = '7d34c5e6-1111-2222-3333-444455556666';

function mockTables() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'est-1',
          source: 'admin',
          customer_id: 'cust-1',
          status: 'sent',
        }),
      };
    }
    if (table === 'booking_config') {
      return { first: jest.fn().mockResolvedValue({}) };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: TECH_ID, active: true }),
      };
    }
    if (table === 'customers') {
      // Sentinel: reaching THIS lookup means the signature gate passed.
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

function offerPayload(overrides = {}) {
  return {
    surface: 'booking',
    scopeId: '',
    date: SLOT_DATE,
    startMinutes: 9 * 60,
    technicianId: TECH_ID,
    durationMinutes: 60,
    ...overrides,
  };
}

function confirmPayload(slotSig) {
  return {
    estimate_id: 'est-1',
    slot_date: SLOT_DATE,
    slot_start: '09:00',
    technician_id: TECH_ID,
    duration_minutes: 60,
    slot_sig: slotSig,
  };
}

describe('createSelfBooking — signed-offer gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables();
  });

  test('a MISSING slot_sig → plain-string 409 before any customer work', async () => {
    const { slot_sig, ...noSig } = confirmPayload('x');
    void slot_sig;
    const result = await createSelfBooking(noSig);
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('a TAMPERED slot_sig → 409', async () => {
    const good = mintSlotOfferField(offerPayload());
    const tampered = good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A');
    const result = await createSelfBooking(confirmPayload(tampered));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('an EXPIRED offer → 409', async () => {
    const stale = mintSlotOfferField(offerPayload(), Date.now() - SLOT_OFFER_TTL_MS - 1000);
    const result = await createSelfBooking(confirmPayload(stale));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('an offer for a DIFFERENT tuple (shifted start / other tech / other duration) → 409', async () => {
    for (const change of [
      { startMinutes: 10 * 60 },
      { technicianId: '99999999-aaaa-bbbb-cccc-ddddeeeeffff' },
      { durationMinutes: 90 },
      { date: etDateString(addETDays(new Date(), 4)) },
    ]) {
      const sig = mintSlotOfferField(offerPayload(change));
      const result = await createSelfBooking(confirmPayload(sig));
      expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
    }
  });

  test('a VALID offer clears the gate (proven by reaching the post-gate customer lookup)', async () => {
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig));
    // customers lookup (mocked null) sits after the technician check, which
    // sits after the signature gate — a 404 here means the sig verified.
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test('an estimate-surface offer for the same tuple does NOT clear the /book gate', async () => {
    const { signSlotOffer } = require('../utils/slot-offer-token');
    const { exp, sig } = signSlotOffer(offerPayload({ surface: 'estimate', scopeId: 'est-1' }));
    const result = await createSelfBooking(confirmPayload(`${exp}.${sig}`));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });
});
