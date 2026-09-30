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
 * booking's own estimate id → proceeds. The ownership gate (an existing
 * estimate must BELONG to the resolved customer — customer_id match, or
 * contact match when the estimate has no customer yet — or the booking
 * proceeds unlinked with a warn) is driven end-to-end in the last describe
 * with a transaction mock that captures the scheduled_services insert.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { createSelfBooking, bookInsertionOffersLive } = require('../routes/booking')._internals;
const { mintSlotOfferField, SLOT_OFFER_TTL_MS, BOOK_INSERTION_OFFER_POLICY } = require('../utils/slot-offer-token');
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
    // Blackout redemption re-check (PR #2733): nothing blocked in these
    // scenarios — resolve empty so the fail-open warn never fires.
    // system_settings backs the weekly days-off layer — same empty resolve.
    if (table === 'schedule_blackout_dates' || table === 'system_settings') {
      const bb = { where: () => bb, whereBetween: () => bb, first: async () => undefined, select: async () => [] };
      return bb;
    }
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
    if (table === 'technician_absences') {
      // assertAssignableTechnician also reads the tech's absence for the
      // booking date (GATE_TECH_OUT_REDISTRIBUTE) — none here.
      return { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: TECH_ID, employment_status: 'active', field_dispatchable: true }),
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
    // Codex round 2 P1 on PR #5231: mirrors production — buildBookingAvailability
    // mints with capacityPlacement: bookInsertionOffersLive(), read at mint
    // time. Defaulting it here the same way means every pre-existing test
    // in this file (most of which mint and confirm under the SAME env, and
    // don't care about the policy tag) keeps minting a REALISTIC offer for
    // whatever gate state it set before calling this — an untagged offer
    // when the gate is off, a tagged one when both GATE_BOOK_CAPACITY_COMMIT
    // and GATE_SCHEDULING_CAPACITY are on. Tests that specifically exercise
    // a gate flip BETWEEN mint and confirm, or want a deliberate mismatch,
    // pass an explicit `policy` override (undefined included), which always
    // wins over this default.
    policy: bookInsertionOffersLive() ? BOOK_INSERTION_OFFER_POLICY : undefined,
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

describe('createSelfBooking — mid-route insertion policy tag (Codex round 2, PR #5231)', () => {
  const ENV_KEYS = ['GATE_BOOK_CAPACITY_COMMIT', 'GATE_SCHEDULING_CAPACITY'];
  const saved = {};
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables();
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('an insertion-tagged offer confirmed after bookInsertionOffersLive() flips OFF → 409, never reaches the post-gate work', async () => {
    // Minted as if buildBookingAvailability ran with capacityPlacement true
    // (offerPolicy = BOOK_INSERTION_OFFER_POLICY); gates stay unset (off)
    // for the confirm — a rollback/mixed-deploy window landing here.
    const sig = mintSlotOfferField(offerPayload({ policy: BOOK_INSERTION_OFFER_POLICY }));
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('an untagged (append-only) offer confirmed after bookInsertionOffersLive() flips ON → 409', async () => {
    const sig = mintSlotOfferField(offerPayload()); // no policy — as buildBookingAvailability mints with capacityPlacement false/omitted
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/no longer available/i) });
  });

  test('a matching insertion-tagged offer with the gate ON clears the signature check (reaches the same post-gate sentinel as any valid offer)', async () => {
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const sig = mintSlotOfferField(offerPayload({ policy: BOOK_INSERTION_OFFER_POLICY }));
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test('a matching untagged offer with the gate OFF still clears the gate — the pre-existing default path is unaffected', async () => {
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig));
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test('GATE_BOOK_CAPACITY_COMMIT alone (GATE_SCHEDULING_CAPACITY off) does not turn on the insertion policy — an untagged offer still matches', async () => {
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    // GATE_SCHEDULING_CAPACITY stays unset.
    const sig = mintSlotOfferField(offerPayload());
    const result = await createSelfBooking(confirmPayload(sig));
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

describe('createSelfBooking — source_estimate_id OWNERSHIP gate (booking-audit r4)', () => {
  // Any EXISTING estimate UUID used to link unconditionally. The column is
  // trusted downstream — already-accepted retry rebuilds treat it as "this
  // estimate is booked" and completion invoicing rolls the estimate's pending
  // deposit credit forward through it — so a borrowed UUID could suppress the
  // real customer's retry link or consume their deposit credit. The gate:
  // link only when the estimate belongs to the resolved customer
  // (customer_id match, or — customer-less estimate — a contact match:
  // last-10 phone, email only when the estimate has no phone). Mismatch
  // books UNLINKED with a warn (fail-open, like the unknown-id path).
  //
  // These run the flow past the customer resolution into the booking
  // transaction; a mock captures the scheduled_services insert (the row the
  // link is stamped on) and then aborts with a sentinel, so no post-commit
  // side effects (SMS/reminders) are reached.
  const OTHER_EST = 'bbbb2222-cc33-4d44-8e55-ffff6666aaaa';
  const PHONE_EST = 'cccc3333-dd44-4e55-8f66-aaaa7777bbbb';
  const MISMATCH_EST = 'dddd4444-ee55-4f66-8a77-bbbb8888cccc';
  const CUST = {
    id: 'cust-1', account_id: 'acct-1', phone: '(941) 555-0100', email: 'ada@example.com', city: 'Sarasota',
    address_line1: '123 Fixture Lane', address_line2: 'Unit 2', state: 'FL', zip: '34236',
    latitude: LAT, longitude: LNG,
  };
  const SIBLING = {
    ...CUST,
    id: 'cust-2',
    address_line1: '456 Sibling Lane',
    address_line2: 'Unit 4',
  };
  const OTHER_CUST = { ...CUST, id: 'cust-other', account_id: 'acct-other' };
  const customerFixture = (id, { fenced = false } = {}) => {
    if (String(id) === String(loadedCustomer?.id)) return fenced ? fencedCustomer : loadedCustomer;
    return ({ [CUST.id]: CUST, [SIBLING.id]: SIBLING, [OTHER_CUST.id]: OTHER_CUST })[String(id)] || null;
  };
  const priceableEstimate = (overrides = {}) => ({
    source: 'admin',
    status: 'sent',
    annual_total: 387.96,
    estimate_data: {
      engineResult: {
        lineItems: [{ service: 'pest_control', monthly: 32.33, perApp: 96.99, visitsPerYear: 4 }],
      },
    },
    ...overrides,
  });
  const ESTIMATES = {
    [EST_ID]: priceableEstimate({ id: EST_ID, customer_id: 'cust-1' }),
    // someone ELSE's estimate — linked to a different customer
    [OTHER_EST]: priceableEstimate({
      id: OTHER_EST,
      customer_id: 'cust-other',
      customer_phone: '(941) 555-0999',
      customer_email: 'mallory@example.com',
    }),
    // customer-less estimate whose contact phone (freeform) matches CUST
    [PHONE_EST]: { id: PHONE_EST, customer_id: null, customer_phone: '941-555-0100', customer_email: null },
    // customer-less estimate whose contact matches NOBODY on this booking
    [MISMATCH_EST]: { id: MISMATCH_EST, customer_id: null, customer_phone: '(555) 000-1111', customer_email: 'someone@else.example' },
  };
  const SENTINEL = 'stop-after-scheduled-services-insert';
  let capturedScheduledInsert;
  let returnScheduledInsert;
  let fencedCustomer;
  let loadedCustomer;

  function trxTable(table) {
    if (table === 'self_booked_appointments') {
      let counting = false;
      const b = {
        where: () => b,
        whereNot: () => b,
        // Effective-date day-cap predicate (SELF_BOOKING_EFFECTIVE_DATE_SQL)
        whereRaw: () => b,
        modify(fn) { fn(b); return b; },
        count: () => { counting = true; return b; },
        // replay lookup → none; global day-cap count → 0 (under cap)
        first: () => Promise.resolve(counting ? { count: 0 } : null),
        insert: () => ({ returning: () => Promise.resolve([{ id: 'sb-1' }]) }),
      };
      return b;
    }
    if (table === 'leads') {
      // Exercise the real address-verdict lookup shape while returning no
      // matching lead. Invoke nested predicates so this fixture does not
      // silently bypass the guard's contact-pair query construction.
      const b = {
        where(arg) { if (typeof arg === 'function') arg(b); return b; },
        orWhere(arg) { if (typeof arg === 'function') arg(b); return b; },
        whereNull: () => b,
        whereRaw: () => b,
        forUpdate: () => b,
        first: async () => null,
        select: async () => [],
      };
      return b;
    }
    if (table === 'scheduled_services') {
      let counting = false;
      const b = {
        leftJoin: () => b,
        where: () => b,
        whereNotIn: () => b,
        whereRaw: () => b,
        // The day cap counts VOICE bookings off this table too (they write no
        // self_booked_appointments row) — none here, so the cap is unchanged.
        count: () => { counting = true; return b; },
        first: () => Promise.resolve(counting ? { count: 0 } : null), // conflict re-check → free
        // Global tech-blind probe (shared occupancy module, round 3): its
        // chain tails with .select(...).orderBy(...) and resolves rows —
        // empty here, so the probe passes and the flow reaches the insert.
        select: () => b,
        orderBy: () => Promise.resolve([]),
        insert: (row) => {
          capturedScheduledInsert = row;
          if (!returnScheduledInsert) throw new Error(SENTINEL);
          return { returning: async () => [{ ...row, id: 'scheduled-1' }] };
        },
      };
      return b;
    }
    if (table === 'customers') {
      // The rung-6 comms fence re-reads the fingerprint columns under the
      // lock — serve the same row as the db-level pre-fence read so the
      // compare passes and the flow reaches the insert.
      // …and the county-verdict stored-pair read (#4667: email + phone of
      // the resolved customer, before the comms fence) — same row.
      const b = {
        _id: null,
        where(arg, value) {
          if (arg && typeof arg === 'object') b._id = arg.id ?? b._id;
          else if (arg === 'id') b._id = value;
          return b;
        },
        whereNull: () => b,
        forShare: () => b,
        forUpdate: () => b,
        first: async () => customerFixture(b._id || loadedCustomer.id, { fenced: true }),
      };
      return b;
    }
    if (table === 'estimates') {
      // The r35 estimate-linkage revalidation re-reads stamped refs under
      // the fence — serve the fixture rows (customer-less rows pass the
      // owner check; unlinked bookings never reach this read).
      const b = {
        _id: null,
        where(arg) { b._id = (arg && typeof arg === 'object') ? arg.id : arg; return b; },
        forShare: () => b,
        first: async () => ESTIMATES[String(b._id)] || null,
      };
      return b;
    }
    if (table === 'technician_absences') {
      // assertAssignableTechnician also reads the tech's absence for the
      // booking date (GATE_TECH_OUT_REDISTRIBUTE) — none here.
      return { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    }
    if (table === 'technicians') {
      // In-transaction eligibility re-check (technician-eligibility.js).
      return {
        where: jest.fn().mockReturnThis(),
        forShare: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: TECH_ID, employment_status: 'active', field_dispatchable: true }),
      };
    }
    throw new Error(`unexpected trx table ${table}`);
  }

  function mockOwnershipTables() {
    db.mockImplementation((table) => {
    // Blackout redemption re-check (PR #2733): nothing blocked in these
    // scenarios — resolve empty so the fail-open warn never fires.
    // system_settings backs the weekly days-off layer — same empty resolve.
    if (table === 'schedule_blackout_dates' || table === 'system_settings') {
      const bb = { where: () => bb, whereBetween: () => bb, first: async () => undefined, select: async () => [] };
      return bb;
    }
      if (table === 'estimates') {
        const builder = {
          _id: null,
          _ids: null,
          where(_field, id) { builder._id = id; return builder; },
          whereIn(_field, ids) { builder._ids = ids; return builder; },
          select: jest.fn(async () => (builder._ids || [])
            .map(id => ESTIMATES[String(id)])
            .filter(Boolean)
            .map(row => ({ id: row.id, customer_id: row.customer_id }))),
          first: jest.fn(() => Promise.resolve(ESTIMATES[String(builder._id)] || null)),
        };
        return builder;
      }
      if (table === 'booking_config') {
        return { first: jest.fn().mockResolvedValue({}) };
      }
      if (table === 'technician_absences') {
        // assertAssignableTechnician also reads the tech's absence for the
        // booking date (GATE_TECH_OUT_REDISTRIBUTE) — none here.
        return { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
      }
      if (table === 'technicians') {
        return {
          where: jest.fn().mockReturnThis(),
          forShare: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ id: TECH_ID, employment_status: 'active', field_dispatchable: true }),
        };
      }
      if (table === 'customers') {
        // Phone lookup and the by-id lookup both resolve CUST — identity
        // lands on cust-1 for every path in this describe.
        const builder = {
          _id: null,
          whereRaw: jest.fn(() => builder),
          where: jest.fn((arg, value) => {
            if (arg && typeof arg === 'object') builder._id = arg.id ?? builder._id;
            else if (arg === 'id') builder._id = value;
            return builder;
          }),
          whereNull: jest.fn(() => builder),
          andWhere: jest.fn(() => builder),
          first: jest.fn(async () => customerFixture(builder._id || loadedCustomer.id)),
        };
        return builder;
      }
      if (table === 'notification_prefs' || table === 'property_preferences') {
        // Both rows are seeded via createDefaultCustomerRows for every
        // resolved customer (canonical NULL-consent seeding).
        return { insert: () => ({ onConflict: () => ({ ignore: () => Promise.resolve() }) }) };
      }
      if (table === 'service_zones') {
        return { select: () => Promise.resolve([]) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    db.transaction = jest.fn(async (fn) => fn(Object.assign(
      (table) => trxTable(table),
      {
        raw: jest.fn().mockResolvedValue(undefined),
        fn: { now: () => new Date() },
        // Real knex exposes trx.schema; the insert path introspects the
        // deploy-order-guarded source_estimate_generation column.
        schema: { hasColumn: jest.fn().mockResolvedValue(true) },
      },
    )));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    capturedScheduledInsert = undefined;
    returnScheduledInsert = false;
    fencedCustomer = { ...CUST };
    loadedCustomer = { ...CUST };
    mockOwnershipTables();
  });

  async function runToScheduledInsert(overrides) {
    const sig = mintSlotOfferField(offerPayload());
    await expect(createSelfBooking(confirmPayload(sig, overrides))).rejects.toThrow(SENTINEL);
    expect(capturedScheduledInsert).toBeDefined();
    return capturedScheduledInsert;
  }

  function callbackPayload(overrides = {}) {
    return {
      slot_date: SLOT_DATE,
      slot_start: '09:00',
      technician_id: TECH_ID,
      source: 'reservice_link',
      authedCustomer: loadedCustomer,
      payAtVisit: false,
      customersOnly: false,
      callbackVisit: {
        serviceKey: 'pest_re_service',
        serviceId: 'eeee4444-ff55-4666-8777-aaaa8888bbbb',
        serviceType: 'Pest Control Re-Service',
        durationMinutes: 30,
      },
      ...overrides,
    };
  }

  async function runCallbackToScheduledInsert(overrides) {
    await expect(createSelfBooking(callbackPayload(overrides))).rejects.toThrow(SENTINEL);
    expect(capturedScheduledInsert).toBeDefined();
    return capturedScheduledInsert;
  }

  test("someone ELSE's estimate UUID books UNLINKED (no source_estimate_id stamp) with a warn", async () => {
    const row = await runToScheduledInsert({ source_estimate_id: OTHER_EST });
    expect(row.source_estimate_id).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not belong'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(OTHER_EST));
  });

  test("the customer's OWN linked estimate (customer_id match) stamps the link", async () => {
    const row = await runToScheduledInsert({ source_estimate_id: EST_ID });
    expect(row.source_estimate_id).toBe(EST_ID);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a sibling property's estimate keeps its source link and frozen pay-at-visit price", async () => {
    loadedCustomer = { ...SIBLING };
    fencedCustomer = { ...SIBLING };
    const duplicateGuard = jest.spyOn(require('../services/recurring-appointment-seeder'), 'checkActiveSeriesLocked')
      .mockResolvedValue({ matches: [], guardError: null });
    const pricing = jest.spyOn(require('../services/booking-pay-at-visit'), 'resolveBookingVisitPrice')
      .mockReturnValue({ amount: 96.99, followUpAmount: 96.99, sourceEstimateId: EST_ID, serviceKey: 'pest_control' });
    try {
      const row = await runToScheduledInsert({
        authedCustomer: loadedCustomer,
        source_estimate_id: EST_ID,
        payAtVisit: true,
        recurring_pattern: 'quarterly',
      });
      expect(row.customer_id).toBe(SIBLING.id);
      expect(row.source_estimate_id).toBe(EST_ID);
      expect(row.estimated_price).toBe(96.99);
      expect(row.payment_method_preference).toBe('pay_at_visit');
      expect(row.create_invoice_on_complete).toBe(true);
      expect(pricing).toHaveBeenCalledWith(expect.objectContaining({
        estimate: expect.objectContaining({ id: EST_ID }),
        serviceKey: 'pest_control',
        bookingVisits: 4,
      }));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('does not belong'));
    } finally {
      pricing.mockRestore();
      duplicateGuard.mockRestore();
    }
  });

  test("another account's priceable estimate is rejected again under the booking fence", async () => {
    loadedCustomer = { ...SIBLING };
    fencedCustomer = { ...SIBLING };
    const sig = mintSlotOfferField(offerPayload());
    await expect(createSelfBooking(confirmPayload(sig, {
      estimate_id: OTHER_EST,
      authedCustomer: loadedCustomer,
      source_estimate_id: OTHER_EST,
      payAtVisit: true,
      recurring_pattern: 'quarterly',
    }))).resolves.toEqual({
      ok: false,
      status: 409,
      error: 'Your quote was just updated — please refresh and book again.',
      code: 'CUSTOMER_CHANGED_RETRY',
    });
    expect(capturedScheduledInsert).toBeUndefined();
  });

  test('a customer-less estimate whose contact PHONE matches the booking customer stamps the link', async () => {
    const row = await runToScheduledInsert({ source_estimate_id: PHONE_EST });
    expect(row.source_estimate_id).toBe(PHONE_EST);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('phone-resolved identity (customer_id + phone, no estimate token) gets the same contact-match link', async () => {
    const row = await runToScheduledInsert({
      estimate_id: undefined,
      customer_id: 'cust-1',
      new_customer: { phone: '9415550100', lat: LAT, lng: LNG },
      source_estimate_id: PHONE_EST,
    });
    expect(row.source_estimate_id).toBe(PHONE_EST);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a customer pin moved to another signed-offer grid cell under the booking fence requires a fresh slot', async () => {
    fencedCustomer = { ...CUST, latitude: 27.41, longitude: -82.61 };
    const sig = mintSlotOfferField(offerPayload());

    await expect(createSelfBooking(confirmPayload(sig))).resolves.toEqual({
      ok: false,
      status: 409,
      error: 'Your address just changed — please pick a time again.',
      code: 'LOCATION_CHANGED_RETRY',
    });
    expect(capturedScheduledInsert).toBeUndefined();
  });

  test('an account reassignment under the booking fence requires a fresh customer resolution', async () => {
    fencedCustomer = { ...CUST, account_id: 'acct-moved' };
    const sig = mintSlotOfferField(offerPayload());

    await expect(createSelfBooking(confirmPayload(sig))).resolves.toEqual({
      ok: false,
      status: 409,
      error: 'Your account details just changed — please refresh and book again.',
      code: 'CUSTOMER_CHANGED_RETRY',
    });
    expect(capturedScheduledInsert).toBeUndefined();
  });

  test.each([
    ['true', 'true'], ['true', 'false'], ['false', 'true'], ['false', 'false'],
  ])('a geocoded offer with no stored customer pin survives confirm (capacity=%s, commit=%s)', async (capacity, commit) => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    process.env.GATE_SCHEDULING_CAPACITY = capacity;
    process.env.GATE_BOOK_CAPACITY_COMMIT = commit;
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const exactPin = { lat: 27.339, lng: -82.531 };
    let transactionStarted = false;
    const runTransaction = db.transaction.getMockImplementation();
    db.transaction.mockImplementation((...args) => { transactionStarted = true; return runTransaction(...args); });
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockImplementation(async (address) => {
      expect(address).toBe('123 Fixture Lane, Sarasota, FL, 34236');
      expect(transactionStarted).toBe(false);
      return exactPin;
    });
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const prepared = { options: { prospective: exactPin } };
    const prepareSpy = jest.spyOn(arrivalRoute, 'prepareArrivalCapacity').mockResolvedValue(prepared);
    const verifySpy = jest.spyOn(arrivalRoute, 'verifyArrivalCapacity')
      .mockResolvedValue({ feasible: true, routeOrder: ['__candidate__'] });
    const conflictSpy = jest.spyOn(require('../services/scheduling/occupancy'), 'findConflictingVisits').mockResolvedValue([]);
    try {
      const row = await runToScheduledInsert();
      expect(row).toMatchObject({
        ...exactPin,
        service_address_line1: CUST.address_line1, service_address_line2: CUST.address_line2,
        service_address_city: CUST.city, service_address_state: CUST.state, service_address_zip: CUST.zip,
      });
      expect(loadedCustomer.latitude).toBeNull();
      expect(fencedCustomer.latitude).toBeNull();
      expect(conflictSpy).toHaveBeenCalledWith(expect.objectContaining({ travel: expect.objectContaining(exactPin) }));
      if (capacity === 'true' && commit === 'true') {
        expect(prepareSpy).toHaveBeenCalledWith(expect.objectContaining({ prospective: expect.objectContaining(exactPin) }));
        expect(verifySpy).toHaveBeenCalledWith(prepared, expect.objectContaining({ conn: expect.any(Function) }));
      } else {
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(verifySpy).not.toHaveBeenCalled();
      }
      expect(geocodeSpy).toHaveBeenCalledTimes(1);
      const { recurringServiceAddress } = require('../services/booking/visit-financial-stamps');
      expect(recurringServiceAddress(row)).toMatchObject({ lat: exactPin.lat, lng: exactPin.lng, service_address_line1: CUST.address_line1 });
    } finally {
      geocodeSpy.mockRestore(); prepareSpy.mockRestore(); verifySpy.mockRestore(); conflictSpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('the booking persists its certified route order after inserting the candidate in the same transaction', async () => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    returnScheduledInsert = true;
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const fit = { feasible: true, routeOrder: ['earlier', '__candidate__', 'later'] };
    const prepared = { options: { prospective: { lat: LAT, lng: LNG } } };
    const prepareSpy = jest.spyOn(arrivalRoute, 'prepareArrivalCapacity').mockResolvedValue(prepared);
    const verifySpy = jest.spyOn(arrivalRoute, 'verifyArrivalCapacity').mockResolvedValue(fit);
    const persistSpy = jest.spyOn(arrivalRoute, 'persistArrivalOrder').mockImplementation(async () => {
      expect(capturedScheduledInsert).toBeDefined();
      throw new Error(SENTINEL);
    });
    const conflictSpy = jest.spyOn(require('../services/scheduling/occupancy'), 'findConflictingVisits').mockResolvedValue([]);
    try {
      await runToScheduledInsert();
      expect(persistSpy).toHaveBeenCalledTimes(1);
      const verifyTrx = verifySpy.mock.calls[0][1].conn;
      expect(persistSpy).toHaveBeenCalledWith(verifyTrx, fit, 'scheduled-1');
      const dayFenceCalls = verifyTrx.raw.mock.calls
        .map((call, index) => ({ call, order: verifyTrx.raw.mock.invocationCallOrder[index] }))
        .filter(({ call }) => call[1]?.[0] === 'slot-reserve')
        .filter(({ call }) => call[1]?.[1] === `${TECH_ID}:${SLOT_DATE}` || call[1]?.[1] === `unassigned:${SLOT_DATE}`);
      expect(dayFenceCalls.map(({ call }) => call[1][1])).toEqual([
        `${TECH_ID}:${SLOT_DATE}`, `unassigned:${SLOT_DATE}`,
      ]);
      expect(dayFenceCalls.every(({ order }) => order < verifySpy.mock.invocationCallOrder[0])).toBe(true);
    } finally {
      prepareSpy.mockRestore(); verifySpy.mockRestore(); persistSpy.mockRestore(); conflictSpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('the production booking contract rejects an infeasible whole-route re-check as SLOT_TAKEN', async () => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const prepared = { options: { prospective: { lat: LAT, lng: LNG } } };
    const prepareSpy = jest.spyOn(arrivalRoute, 'prepareArrivalCapacity').mockResolvedValue(prepared);
    const verifySpy = jest.spyOn(arrivalRoute, 'verifyArrivalCapacity').mockRejectedValue(Object.assign(
      new Error('This time is no longer available. Please choose another appointment.'),
      { code: 'SLOT_UNAVAILABLE', reason: 'arrival_window', statusCode: 409, isOperational: true },
    ));
    const conflictSpy = jest.spyOn(require('../services/scheduling/occupancy'), 'findConflictingVisits').mockResolvedValue([]);
    try {
      const sig = mintSlotOfferField(offerPayload());
      await expect(createSelfBooking(confirmPayload(sig))).resolves.toMatchObject({
        ok: false,
        status: 409,
        code: 'SLOT_TAKEN',
      });
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(capturedScheduledInsert).toBeUndefined();
    } finally {
      prepareSpy.mockRestore();
      verifySpy.mockRestore();
      conflictSpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('a missing-coordinate re-service uses one canonical pin for conflict, capacity, and the visit stamp', async () => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const exactPin = { lat: 27.339, lng: -82.531 };
    let transactionStarted = false;
    const runTransaction = db.transaction.getMockImplementation();
    db.transaction.mockImplementation((...args) => { transactionStarted = true; return runTransaction(...args); });
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockImplementation(async (address) => {
      expect(address).toBe('123 Fixture Lane, Sarasota, FL, 34236');
      expect(transactionStarted).toBe(false);
      return exactPin;
    });
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const prepared = { options: { prospective: exactPin } };
    const prepareSpy = jest.spyOn(arrivalRoute, 'prepareArrivalCapacity').mockResolvedValue(prepared);
    const verifySpy = jest.spyOn(arrivalRoute, 'verifyArrivalCapacity')
      .mockResolvedValue({ feasible: true, routeOrder: ['__candidate__'] });
    const conflictSpy = jest.spyOn(require('../services/scheduling/occupancy'), 'findConflictingVisits').mockResolvedValue([]);
    const laneSpy = jest.spyOn(require('../services/reservice-scheduler'), 'openCallbackExistsForLane').mockResolvedValue(false);
    try {
      const row = await runCallbackToScheduledInsert();
      expect(row).toMatchObject({
        ...exactPin,
        is_callback: true,
        service_address_line1: CUST.address_line1, service_address_line2: CUST.address_line2,
        service_address_city: CUST.city, service_address_state: CUST.state, service_address_zip: CUST.zip,
      });
      expect(loadedCustomer.latitude).toBeNull();
      expect(fencedCustomer.latitude).toBeNull();
      expect(conflictSpy).toHaveBeenCalledWith(expect.objectContaining({ travel: expect.objectContaining(exactPin) }));
      expect(prepareSpy).toHaveBeenCalledWith(expect.objectContaining({ prospective: expect.objectContaining(exactPin) }));
      expect(verifySpy).toHaveBeenCalledWith(prepared, expect.objectContaining({ conn: expect.any(Function) }));
      expect(geocodeSpy).toHaveBeenCalledTimes(1);
    } finally {
      geocodeSpy.mockRestore(); prepareSpy.mockRestore(); verifySpy.mockRestore(); conflictSpy.mockRestore(); laneSpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('a re-service address changed while its missing pin resolves is refused under the customer fence', async () => {
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockImplementation(async () => {
      fencedCustomer = { ...fencedCustomer, address_line1: '456 Changed Avenue' };
      return { lat: LAT, lng: LNG };
    });
    try {
      await expect(createSelfBooking(callbackPayload())).resolves.toMatchObject({
        ok: false, status: 409, code: 'CUSTOMER_CHANGED_RETRY',
      });
      expect(geocodeSpy).toHaveBeenCalledTimes(1);
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); }
  });

  test.each([
    ['changed longitude with capacity off', { latitude: null, longitude: LNG }, { latitude: null, longitude: LNG - 0.02 }, TECH_ID, 'false'],
    ['changed latitude without a technician', { latitude: LAT, longitude: null }, { latitude: LAT + 0.02, longitude: null }, null, 'true'],
    ['cleared complete pin with capacity off', { latitude: LAT, longitude: LNG }, { latitude: null, longitude: null }, TECH_ID, 'false'],
  ])('re-service refuses an invalidated pin before any conflict probe: %s', async (_label, before, after, technicianId, gate) => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    process.env.GATE_SCHEDULING_CAPACITY = gate;
    process.env.GATE_BOOK_CAPACITY_COMMIT = gate;
    loadedCustomer = { ...CUST, ...before };
    fencedCustomer = { ...loadedCustomer, ...after };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue({ lat: LAT, lng: LNG });
    const conflictSpy = jest.spyOn(require('../services/scheduling/occupancy'), 'findConflictingVisits').mockResolvedValue([]);
    try {
      await expect(createSelfBooking(callbackPayload({ technician_id: technicianId }))).resolves.toMatchObject({
        ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY',
      });
      expect(conflictSpy).not.toHaveBeenCalled();
      expect(capturedScheduledInsert).toBeUndefined();
    } finally {
      geocodeSpy.mockRestore(); conflictSpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('an assessment callback with its own expected location is not independently re-geocoded', async () => {
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue({ lat: LAT, lng: LNG });
    try {
      await expect(createSelfBooking(callbackPayload({
        callbackVisit: {
          serviceKey: 'lawn_inspection',
          serviceId: 'ffff5555-aa66-4777-8888-bbbb9999cccc',
          serviceType: 'Waves Assessment',
          durationMinutes: 30,
          isCallback: false,
          expectedLocation: { lat: LAT, lng: LNG },
        },
      }))).resolves.toMatchObject({ ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY' });
      expect(geocodeSpy).not.toHaveBeenCalled();
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); }
  });

  test('a complete customer pin cleared while confirm waits is not resurrected from the signed echo', async () => {
    fencedCustomer = { ...CUST, latitude: null, longitude: null };
    const sig = mintSlotOfferField(offerPayload());
    await expect(createSelfBooking(confirmPayload(sig))).resolves.toMatchObject({ ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY' });
    expect(capturedScheduledInsert).toBeUndefined();
  });

  test.each([
    { latitude: null, longitude: LNG }, { latitude: LAT, longitude: null },
  ])('a stable incomplete legacy pair is replaced as a whole on the visit: %p', async (pair) => {
    loadedCustomer = { ...CUST, ...pair };
    fencedCustomer = { ...loadedCustomer };
    const pin = { lat: 27.339, lng: -82.531 };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue(pin);
    try {
      const row = await runToScheduledInsert();
      expect(row).toMatchObject(pin);
    } finally { geocodeSpy.mockRestore(); }
  });

  test.each([
    [{ latitude: null, longitude: LNG }, { latitude: null, longitude: LNG - 0.02 }],
    [{ latitude: LAT, longitude: null }, { latitude: LAT + 0.02, longitude: null }],
  ])('an incomplete legacy pair changed during geocoding requires a fresh slot: %p', async (before, after) => {
    loadedCustomer = { ...CUST, ...before };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockImplementation(async () => {
      fencedCustomer = { ...fencedCustomer, ...after };
      return { lat: LAT, lng: LNG };
    });
    try {
      const sig = mintSlotOfferField(offerPayload());
      await expect(createSelfBooking(confirmPayload(sig))).resolves.toMatchObject({
        ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY',
      });
      expect(geocodeSpy).toHaveBeenCalledTimes(1);
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); }
  });

  test('a canonical address changed during geocoding requires a fresh booking attempt', async () => {
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockImplementation(async () => {
      fencedCustomer = { ...fencedCustomer, address_line1: '456 Changed Avenue' };
      return { lat: LAT, lng: LNG };
    });
    try {
      const sig = mintSlotOfferField(offerPayload());
      await expect(createSelfBooking(confirmPayload(sig))).resolves.toMatchObject({
        ok: false, status: 409, code: 'CUSTOMER_CHANGED_RETRY',
      });
      expect(geocodeSpy).toHaveBeenCalledTimes(1);
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); }
  });

  test('a canonical geocode outside the signed grid cannot certify the client echo', async () => {
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue({ lat: 27.5, lng: -82.4 });
    try {
      const sig = mintSlotOfferField(offerPayload());
      await expect(createSelfBooking(confirmPayload(sig))).resolves.toMatchObject({ ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY' });
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); }
  });

  test.each(['public', 're-service'])('a staff review hold recorded during geocoding prevents a new %s visit pin', async (surface) => {
    loadedCustomer = { ...CUST, latitude: null, longitude: null };
    fencedCustomer = { ...loadedCustomer };
    const geocodeSpy = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue({ lat: LAT, lng: LNG });
    const reviewSpy = jest.spyOn(require('../services/customer-geocode-review'), 'reviewedServiceLocation')
      .mockResolvedValueOnce(null).mockResolvedValue({ location: null, reason: 'address_review_required' });
    try {
      const sig = mintSlotOfferField(offerPayload());
      const payload = surface === 'public' ? confirmPayload(sig) : callbackPayload();
      await expect(createSelfBooking(payload)).resolves.toMatchObject({ ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY' });
      expect(capturedScheduledInsert).toBeUndefined();
    } finally { geocodeSpy.mockRestore(); reviewSpy.mockRestore(); }
  });

  test('an exact pin correction after traffic preparation requires a fresh offer', async () => {
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    const freshPin = { lat: 27.339, lng: -82.531 };
    fencedCustomer = { ...CUST, latitude: freshPin.lat, longitude: freshPin.lng };
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const occupancy = require('../services/scheduling/occupancy');
    const prepareSpy = jest.spyOn(arrivalRoute, 'prepareArrivalCapacity').mockResolvedValue({
      options: { prospective: { lat: LAT, lng: LNG } },
    });
    const verifySpy = jest.spyOn(arrivalRoute, 'verifyArrivalCapacity');
    const conflictSpy = jest.spyOn(occupancy, 'findConflictingVisits').mockResolvedValue([]);
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    try {
      await expect(createSelfBooking(confirmPayload(mintSlotOfferField(offerPayload()))))
        .resolves.toMatchObject({ ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY' });
      expect(prepareSpy).toHaveBeenCalledWith(expect.objectContaining({
        prospective: expect.objectContaining({ lat: LAT, lng: LNG }),
      }));
      expect(verifySpy).not.toHaveBeenCalled();
      expect(conflictSpy).not.toHaveBeenCalled();
      expect(capturedScheduledInsert).toBeUndefined();
    } finally {
      conflictSpy.mockRestore();
      prepareSpy.mockRestore();
      verifySpy.mockRestore();
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
    }
  });

  test('a customer-less estimate with a NON-matching contact books UNLINKED with a warn', async () => {
    const row = await runToScheduledInsert({ source_estimate_id: MISMATCH_EST });
    expect(row.source_estimate_id).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not belong'));
  });
});
