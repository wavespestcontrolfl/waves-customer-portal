/**
 * createSelfBooking signed-offer gate (booking-audit rounds 2+3).
 *
 * /confirm's geometry/date/duration mirrors can't prove a (service, location,
 * date, start, technician, duration) tuple was ever OFFERED — so the commit
 * path requires the HMAC the availability builder attached to each slot
 * (`slot_sig`). Round 3 added the request-context scope: the normalized
 * funnel service key and the rounded-coordinate location key are bound into
 * the signature, so an offer fetched for one address/service can't confirm
 * another. These tests drive createSelfBooking up to (and just past) the gate
 * with a table-keyed db mock: identity resolves via a verified estimate, and
 * a request that clears the gate is proven by reaching the customer lookup
 * (mocked to null → 404), which sits AFTER the signature check.
 *
 * Also home to the source_estimate_id contract (accept-retry correlation):
 * malformed → 400, unknown-but-well-formed → booking proceeds UNLINKED, the
 * booking's own estimate id → proceeds.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { createSelfBooking } = require('../routes/booking')._internals;
const { mintSlotOfferField, SLOT_OFFER_TTL_MS } = require('../utils/slot-offer-token');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SLOT_DATE = etDateString(addETDays(new Date(), 3));
const TECH_ID = '7d34c5e6-1111-2222-3333-444455556666';
const EST_ID = 'aaaa1111-bb22-4c33-8d44-eeee5555ffff';
// Funnel service scope: catalog id + the availability build's resolved
// coords on the public ~1 km rounding grid (bookingOfferLocationKey).
const SERVICE_KEY = 'pest_control';
const LAT = 27.336789;
const LNG = -82.530612;
const LOCATION_KEY = '27.34,-82.53';

function mockTables() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      // Id-sensitive: only the verified estimate EST_ID exists — the
      // source_estimate_id existence check must see unknown ids as missing.
      const builder = {
        _id: null,
        where(_field, id) { builder._id = id; return builder; },
        first: jest.fn(() => Promise.resolve(
          String(builder._id) === EST_ID
            ? { id: EST_ID, source: 'admin', customer_id: 'cust-1', status: 'sent' }
            : null,
        )),
      };
      return builder;
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
      // Sentinel: reaching the full-row customer lookup (mocked null → 404)
      // proves the signature gate passed. The gate's own record-coordinate
      // fallback also reads this table and gets null — harmless (the tests
      // that need a location scope submit new_customer coords).
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
    serviceKey: SERVICE_KEY,
    locationKey: LOCATION_KEY,
    date: SLOT_DATE,
    startMinutes: 9 * 60,
    technicianId: TECH_ID,
    durationMinutes: 60,
    ...overrides,
  };
}

function confirmPayload(slotSig, overrides = {}) {
  return {
    estimate_id: EST_ID,
    slot_date: SLOT_DATE,
    slot_start: '09:00',
    technician_id: TECH_ID,
    service_id: SERVICE_KEY,
    duration_minutes: 60,
    // The funnel echoes the availability response's resolved coords here —
    // the gate re-derives the signed location scope from them.
    new_customer: { lat: LAT, lng: LNG },
    slot_sig: slotSig,
    ...overrides,
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
    const { exp, sig } = signSlotOffer(offerPayload({ surface: 'estimate', scopeId: EST_ID }));
    const result = await createSelfBooking(confirmPayload(`${exp}.${sig}`));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });
});

describe('createSelfBooking — service + location scope binding (round 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables();
  });

  test('an offer minted for a DIFFERENT service does not confirm this one', async () => {
    // Offer fetched for termite (90-min catalog visit) — replayed against a
    // pest_control confirm. The confirm derives pest_control's scope + 60-min
    // duration, so the termite sig can never verify.
    const sig = mintSlotOfferField(offerPayload({ serviceKey: 'termite', durationMinutes: 90 }));
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('swapping the confirm service under a valid offer → 409 (service is bound)', async () => {
    const sig = mintSlotOfferField(offerPayload()); // pest_control offer
    const result = await createSelfBooking(confirmPayload(sig, { service_id: 'rodent' }));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('an offer minted for a DIFFERENT location does not confirm this address', async () => {
    const sig = mintSlotOfferField(offerPayload({ locationKey: '26.99,-82.10' }));
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('swapping the confirm coordinates under a valid offer → 409 (location is bound)', async () => {
    const sig = mintSlotOfferField(offerPayload()); // signed for 27.34,-82.53
    const result = await createSelfBooking(confirmPayload(sig, {
      new_customer: { lat: 26.99, lng: -82.10 },
    }));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('the ~1 km rounding grid keeps exact vs rounded coordinate echoes equivalent', async () => {
    // The builder signs roundPublicCoord(resolved); a disclosable response
    // echoes the EXACT coords. Re-rounding at confirm makes both verify.
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig, {
      new_customer: { lat: 27.34, lng: -82.53 }, // pre-rounded echo
    }));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test("a confirm naming NO funnel service is refused even against an ''-scoped sig (non-redeeming builders)", async () => {
    // reschedule/voice availability lookups sign with serviceKey '' — those
    // sigs must never clear the /confirm gate.
    const sig = mintSlotOfferField(offerPayload({ serviceKey: '' }));
    const result = await createSelfBooking(confirmPayload(sig, {
      service_id: undefined,
      service_type: 'Something Unrecognized',
    }));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('the display label resolves the same service scope as the catalog id', async () => {
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig, {
      service_id: undefined,
      service_type: 'Pest Control', // funnel label alias → pest_control
    }));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test('client duration cannot override the catalog duration post-offer', async () => {
    // Offer signed for pest_control's catalog 60. A confirm asking for 90
    // still derives 60 server-side — the sig verifies and the gate clears
    // (404 sentinel), proving the caller-chosen minutes were ignored.
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig, { duration_minutes: 90 }));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });
});

describe('createSelfBooking — source_estimate_id (accept-retry correlation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables();
  });

  const validSig = () => mintSlotOfferField(offerPayload());

  test('malformed source_estimate_id → 400 before any customer write', async () => {
    for (const bad of ['not-a-uuid', '123', 'aaaa1111-bb22-4c33-8d44-eeee5555fff']) {
      const result = await createSelfBooking(confirmPayload(validSig(), { source_estimate_id: bad }));
      expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/estimate reference/i) });
    }
  });

  test('well-formed but UNKNOWN source_estimate_id proceeds UNLINKED (warn, no 400)', async () => {
    const unknown = '11111111-2222-4333-8444-555566667777';
    const result = await createSelfBooking(confirmPayload(validSig(), { source_estimate_id: unknown }));
    // Reaches the post-gate customer lookup — the stale link was dropped,
    // not fatal (the column FKs estimates, so linking it would 500).
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(unknown));
  });

  test("the booking's own (existing) estimate id validates and proceeds", async () => {
    const result = await createSelfBooking(confirmPayload(validSig(), { source_estimate_id: EST_ID }));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
