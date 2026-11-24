/**
 * services/mail/home-book.js with a mocked database and mocked /book and estimate dependencies: the times (soonest first,
 * the /book finder at the address's pin), the contact checks, the live price check, the canonical estimate save (not a dry
 * run, from the stored facts plus the typed contact), the booking through createSelfBooking with a handoff token that
 * verifies, a repeat tap, a taken slot, and the refusals.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'home-book-test-secret';

let mockRow;
const mockDb = jest.fn(() => {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => mockRow);
  return q;
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-customers', () => ({ ensureCustomerAccount: jest.fn() }));
jest.mock('../services/customer-default-rows', () => ({ createDefaultCustomerRows: jest.fn(async () => {}) }));

const { verifyEstimateHandoffToken } = require('../utils/estimate-handoff-token');
const realQuote = require('../services/mail/home-quote');
const {
  getHomeTimes, bookHome, draftIdFor, validContact, validOffer, validShownPrice, offersOf, findOwnCustomer: findOwnCustomerReal, mintCustomer: mintCustomerReal,
  findCommittedBookingCustomer: findCommittedBookingCustomerReal, commitGuardFor,
} = require('../services/mail/home-book');

const TOKEN = '0123456789abcdef0123456789abcdef';
const row = (over) => ({
  id: 'prospect-1', address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212',
  price_annual: '627.00', price_setup_fee: '0.00',
  home_sqft: 2400, home_sqft_source: 'parcel_map', home_stories: '1.0', lot_sqft: 9000,
  ...over,
});
const TECH = '11111111-1111-4111-8111-111111111111';
const offer = (date, start, sig = `sig-${date}-${start}`) => ({
  date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, start_label: start, end_label: null, technician_id: TECH, slot_sig: sig,
});
const slot = (start, sig) => ({ start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, start_label: start, end_label: '', technician_id: TECH, slot_sig: sig });

const SHOWN = { annualCents: 62700, setupCents: 0 };
const INPUT = () => ({
  offer: offer('2026-12-02', '09:00'), name: 'Sample Person', phone: '(941) 555-0142', email: 'Sample@Example.com',
  price: { annual: 627, setupFee: 0 },
});

// A knex-shaped handle whose transaction runs its callback on a transaction handle that records the customers inserts.
function txConn() {
  const inserted = [];
  const trx = jest.fn(() => ({ insert: jest.fn((r) => { inserted.push(r); return { returning: jest.fn(async () => [{ id: 'cust-9' }]) }; }) }));
  const conn = jest.fn();
  conn.transaction = jest.fn(async (fn) => fn(trx));
  return { conn, trx, inserted };
}

let gates;
let verifySlotOfferField;
let findCommittedBookingCustomer;
let mockEstimateRow;
let booking;
let quote;
let saveEstimate;
let updates;
let deps;
let findOwnCustomer;
let findExistingCustomer;
let mintCustomer;

beforeEach(() => {
  mockRow = row();
  gates = { isEnabled: jest.fn(() => true), mailHomePageLive: jest.fn(() => true) };
  mockEstimateRow = { id: 'est-1' };
  verifySlotOfferField = jest.fn(() => true);
  findCommittedBookingCustomer = jest.fn(async () => null);
  booking = {
    loadBookingConfig: jest.fn(async () => ({ slot_duration_minutes: 60 })),
    bookingOfferLocationKey: jest.fn((lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`),
    resolveBookingDuration: jest.fn(() => 60),
    bookOfferPolicyLive: jest.fn(() => 'policy'),
    addressMatchesCustomer: jest.fn(() => true),
    resolveOfferCoords: jest.fn(async () => ({ lat: 27.5, lng: -82.5, disclosable: true })),
    availabilityForPin: jest.fn(async () => ({
      days: [
        { date: '2026-12-03', slots: [slot('13:00', 's-3-13'), slot('09:00', 's-3-09')] },
        { date: '2026-12-02', slots: [slot('14:00', 's-2-14'), slot('08:00', 's-2-08')] },
      ],
    })),
    createSelfBooking: jest.fn(async () => ({ ok: true, body: { booking: { id: 'b1' }, confirmationCode: 'WPC-1' } })),
  };
  quote = {
    estimateBody: realQuote.estimateBody,
    engineInputFor: realQuote.engineInputFor,
    priceHome: jest.fn(async () => ({ status: 'priced', priceAnnual: 627, priceSetupFee: 0, priceDigest: 'd' })),
    judge: jest.fn(() => ({ price: { annual: 627, setupFee: 0, digest: 'd' } })),
  };
  saveEstimate = jest.fn(async (body) => ({ estimate: { id: 'est-1', annual_total: 627, address: body.address }, reused: false, memberLinkageWarning: null }));
  updates = [];
  const conn = jest.fn(() => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.first = jest.fn(async () => mockEstimateRow);
    q.update = jest.fn(async (set) => { updates.push(set); return 1; });
    return q;
  });
  conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  findOwnCustomer = jest.fn(async () => null);
  findExistingCustomer = jest.fn(async () => null);
  mintCustomer = jest.fn(async () => 'cust-1');
  deps = {
    gates, booking, quote, saveEstimate, db: conn, buildEngineInput: jest.fn(() => ({ engine: 'input' })),
    findOwnCustomer, findExistingCustomer, mintCustomer, verifySlotOfferField, findCommittedBookingCustomer,
  };
});

describe('getHomeTimes', () => {
  test('an unknown token, a malformed one and a home with no price or no fact are null (the 404)', async () => {
    mockRow = undefined;
    expect(await getHomeTimes(TOKEN, deps)).toBeNull();
    expect(await getHomeTimes('short', deps)).toBeNull();
    mockRow = row({ price_annual: null });
    expect(await getHomeTimes(TOKEN, deps)).toBeNull();
    mockRow = row({ home_sqft: null });
    expect(await getHomeTimes(TOKEN, deps)).toBeNull();
    expect(booking.availabilityForPin).not.toHaveBeenCalled();
  });

  test('offers come from the /book finder at the address pin for the pest service, soonest first', async () => {
    const res = await getHomeTimes(TOKEN, deps);
    expect(booking.resolveOfferCoords).toHaveBeenCalledWith({ address: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212' });
    expect(booking.availabilityForPin).toHaveBeenCalledWith({ lat: 27.5, lng: -82.5, serviceKey: 'pest_control' });
    expect(res.offers.map((o) => `${o.date} ${o.start_time}`)).toEqual([
      '2026-12-02 08:00', '2026-12-02 14:00', '2026-12-03 09:00', '2026-12-03 13:00',
    ]);
    expect(res.offers[0]).toEqual({
      date: '2026-12-02', start_time: '08:00', end_time: '09:00', start_label: '08:00', end_label: null, technician_id: TECH, slot_sig: 's-2-08',
    });
  });

  test('the list is capped and a slot with no signature is left out', () => {
    const slots = Array.from({ length: 50 }, (_, i) => slot(`${String(8 + (i % 9)).padStart(2, '0')}:00`, `sig-${i}`));
    slots.push({ ...slot('17:00', null), slot_sig: undefined });
    const offers = offersOf({ days: [{ date: '2026-12-02', slots }] });
    expect(offers).toHaveLength(30);
    expect(offers.every((o) => o.slot_sig)).toBe(true);
  });

  test('/book off, an address with no pin, or no finder answer is not_available', async () => {
    gates.isEnabled.mockReturnValue(false);
    expect(await getHomeTimes(TOKEN, deps)).toEqual({ error: 'not_available' });
    gates.isEnabled.mockReturnValue(true);
    booking.resolveOfferCoords.mockResolvedValue({ lat: null, lng: null });
    expect(await getHomeTimes(TOKEN, deps)).toEqual({ error: 'not_available' });
    booking.resolveOfferCoords.mockResolvedValue({ lat: 27.5, lng: -82.5 });
    booking.availabilityForPin.mockResolvedValue(null);
    expect(await getHomeTimes(TOKEN, deps)).toEqual({ error: 'not_available' });
  });
});

describe('the contact and the offer', () => {
  test('each of name, phone and email is required and checked', () => {
    const good = { name: 'Sample Person', phone: '941-555-0142', email: 'a@example.com' };
    expect(validContact(good)).toMatchObject({ name: 'Sample Person', first: 'Sample', last: 'Person', phone: '+19415550142', phone10: '9415550142' });
    for (const [field, bad] of [
      ['name', { ...good, name: '' }], ['name', { ...good, name: 'X' }], ['name', { ...good, name: '1234' }], ['name', { ...good, name: 42 }],
      ['phone', { ...good, phone: '' }], ['phone', { ...good, phone: '123' }], ['phone', { ...good, phone: '(111) 555-0142' }], ['phone', { ...good, phone: 9415550142 }],
      ['email', { ...good, email: '' }], ['email', { ...good, email: 'not-an-email' }], ['email', { ...good, email: undefined }],
    ]) {
      expect(validContact(bad)).toEqual({ invalid: field });
    }
    expect(validContact(null)).toEqual({ invalid: 'name' });
    // A one-word name is kept (first name only).
    expect(validContact({ ...good, name: 'Sample' })).toMatchObject({ first: 'Sample', last: '' });
  });

  test('an offer is the object /times returned: date, start, optional end and technician, a signature', () => {
    expect(validOffer(offer('2026-12-02', '09:00'))).toEqual({ date: '2026-12-02', start: '09:00', end: '10:00', technicianId: TECH, sig: 'sig-2026-12-02-09:00' });
    for (const bad of [null, 'sig', [], {}, { ...offer('2026-12-02', '09:00'), date: '12/02' }, { ...offer('2026-12-02', '09:00'), start_time: '9am' },
      { ...offer('2026-12-02', '09:00'), technician_id: 'tech' }, { ...offer('2026-12-02', '09:00'), slot_sig: '' }]) {
      expect(validOffer(bad)).toBeNull();
    }
  });
});

describe('bookHome', () => {
  test('an unknown token or a home with no price is null (the 404), before any check', async () => {
    mockRow = undefined;
    expect(await bookHome(TOKEN, INPUT(), deps)).toBeNull();
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('each missing or bad contact field is a 400 invalid_contact naming the field, and nothing is saved or booked', async () => {
    for (const [field, patch] of [['name', { name: '' }], ['phone', { phone: '555' }], ['email', { email: 'nope' }]]) {
      const res = await bookHome(TOKEN, { ...INPUT(), ...patch }, deps);
      expect(res).toEqual({ status: 400, body: { error: 'invalid_contact', field } });
    }
    expect(await bookHome(TOKEN, { ...INPUT(), offer: undefined }, deps)).toEqual({ status: 400, body: { error: 'invalid_offer' } });
    expect(quote.priceHome).not.toHaveBeenCalled();
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a contact that is already a customer is 409 contact_on_file: no row minted, nothing priced, saved or booked', async () => {
    findExistingCustomer.mockResolvedValue({ id: 'someone' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'contact_on_file' } });
    expect(findExistingCustomer).toHaveBeenCalledWith(expect.objectContaining({ row: mockRow }), expect.objectContaining({ phone10: '9415550142', email: 'sample@example.com' }), deps);
    expect(mintCustomer).not.toHaveBeenCalled();
    expect(quote.priceHome).not.toHaveBeenCalled();
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a new contact gets one pre-customer row after the price check, and the estimate is saved with its id', async () => {
    await bookHome(TOKEN, INPUT(), deps);
    expect(mintCustomer).toHaveBeenCalledTimes(1);
    expect(mintCustomer.mock.calls[0][2]).toEqual({ lat: 27.5, lng: -82.5 });
    expect(quote.priceHome.mock.invocationCallOrder[0]).toBeLessThan(mintCustomer.mock.invocationCallOrder[0]);
    expect(mintCustomer.mock.invocationCallOrder[0]).toBeLessThan(saveEstimate.mock.invocationCallOrder[0]);
    expect(saveEstimate.mock.calls[0][0].customerId).toBe('cust-1');
  });

  test('a repeat tap reuses the row an earlier tap minted: no second row, no existing-customer refusal', async () => {
    findOwnCustomer.mockResolvedValue('cust-1');
    findExistingCustomer.mockResolvedValue({ id: 'cust-1' }); // the matcher would find our own row: it must not be asked
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res.status).toBe(200);
    expect(findExistingCustomer).not.toHaveBeenCalled();
    expect(mintCustomer).not.toHaveBeenCalled();
    expect(saveEstimate.mock.calls[0][0].customerId).toBe('cust-1');
    expect(booking.createSelfBooking.mock.calls[0][0].customer_id).toBe('cust-1');
  });

  test('a refused price mints no row', async () => {
    quote.priceHome.mockResolvedValue({ status: 'not_clean', reason: 'member_address' });
    await bookHome(TOKEN, INPUT(), deps);
    expect(mintCustomer).not.toHaveBeenCalled();
  });

  test('mintCustomer fails closed: an account it did not create, a phone or email refusal, or a contact found under the fence writes nothing', async () => {
    const admin = require('../routes/admin-customers');
    const attempt = async () => {
      const t = txConn();
      const err = await mintCustomerReal({ row: mockRow }, validContact(INPUT()), { lat: 27.5, lng: -82.5 }, { db: t.conn, findExistingCustomer }).catch((e) => e);
      return { err, inserted: t.inserted };
    };
    // ensureCustomerAccount attached to an existing account (no created flag).
    admin.ensureCustomerAccount.mockResolvedValue({ accountId: 'acct-existing', existingCustomer: { id: 'x' } });
    let out = await attempt();
    expect(out.err.code).toBe('CONTACT_ON_FILE');
    expect(out.inserted).toEqual([]);
    // Its own 409s for a phone or an email that matches.
    for (const code of ['PHONE_MATCH_CONFIRM', 'EMAIL_MATCH_CONFIRM', 'EMAIL_MATCH_AMBIGUOUS']) {
      admin.ensureCustomerAccount.mockRejectedValue(Object.assign(new Error('match'), { statusCode: 409, code }));
      out = await attempt();
      expect(out.err.code).toBe('CONTACT_ON_FILE');
      expect(out.inserted).toEqual([]);
    }
    // A customer the wizard's matcher finds once the fence is held (a tap that committed just before).
    admin.ensureCustomerAccount.mockReset().mockResolvedValue({ accountId: 'acct-1', existingCustomer: null, created: true });
    findExistingCustomer.mockResolvedValue({ id: 'just-minted' });
    out = await attempt();
    expect(out.err.code).toBe('CONTACT_ON_FILE');
    expect(out.inserted).toEqual([]);
    // Any other error is not hidden.
    findExistingCustomer.mockResolvedValue(null);
    admin.ensureCustomerAccount.mockRejectedValue(Object.assign(new Error('db down'), { code: '57P01' }));
    out = await attempt();
    expect(out.err.message).toBe('db down');
  });

  test('a mint refusal is 409 contact_on_file, with nothing saved or booked', async () => {
    mintCustomer.mockRejectedValue(Object.assign(new Error('contact on file'), { code: 'CONTACT_ON_FILE' }));
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'contact_on_file' } });
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('mintCustomer inserts the wizard columns that apply, with no lot or property size', async () => {
    const admin = require('../routes/admin-customers');
    admin.ensureCustomerAccount.mockResolvedValue({ accountId: 'acct-1', existingCustomer: null });
    admin.ensureCustomerAccount.mockResolvedValue({ accountId: 'acct-1', existingCustomer: null, created: true });
    const { conn, trx, inserted } = txConn();
    const id = await mintCustomerReal({ row: mockRow }, validContact(INPUT()), { lat: 27.5, lng: -82.5 }, { db: conn, findExistingCustomer });
    expect(id).toBe('cust-9');
    // One transaction, under the phone fence, with the contact recheck inside it.
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    expect(admin.ensureCustomerAccount).toHaveBeenCalledWith(trx, { firstName: 'Sample', lastName: 'Person', phone: '9415550142', email: 'sample@example.com', lockPhone: true });
    expect(findExistingCustomer).toHaveBeenCalledWith({ row: mockRow }, expect.objectContaining({ phone10: '9415550142' }), expect.objectContaining({ db: trx }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      account_id: 'acct-1', is_primary_profile: true, profile_label: 'Primary', first_name: 'Sample', last_name: 'Person',
      email: 'sample@example.com', state: 'FL', zip: '34212', latitude: 27.5, longitude: -82.5,
      pipeline_stage: 'new_lead', lead_source: 'mail_new_home', lead_source_detail: 'new_home_postcard',
      lead_source_area: expect.any(String), lead_service_interest: 'Pest Control', active: true,
    });
    expect(inserted[0].referral_code).toMatch(/^WAVES-[A-Z2-9]{4}$/);
    expect(inserted[0].pipeline_stage_changed_at).toBeInstanceOf(Date);
    expect(inserted[0].last_contact_date).toBeInstanceOf(Date);
    expect(inserted[0].address_line1).toMatch(/example trl/i);
    expect(inserted[0]).not.toHaveProperty('lot_sqft');
    expect(inserted[0]).not.toHaveProperty('property_sqft');
  });

  test('findOwnCustomer matches only a pre-customer mail_new_home row with the same phone and this home address', async () => {
    const rows = [
      { id: 'other-home', phone: '+19415550142', address_line1: '9 OTHER ST', zip: '34212' },
      { id: 'mine', phone: '+19415550142', address_line1: '101 Example Trl', zip: '34212' },
    ];
    const calls = [];
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'whereNull', 'limit']) q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
    q.select = jest.fn(async () => rows);
    const matches = jest.fn((customer, line1) => customer.address_line1.toLowerCase() === line1.toLowerCase());
    const id = await findOwnCustomerReal({ row: mockRow }, validContact(INPUT()), { db: jest.fn(() => q), booking: { addressMatchesCustomer: matches } });
    expect(id).toBe('mine');
    expect(calls).toEqual(expect.arrayContaining([
      ['where', { lead_source: 'mail_new_home' }],
      ['whereIn', 'pipeline_stage', expect.arrayContaining(['new_lead'])],
      ['whereNull', 'deleted_at'],
    ]));
    expect(calls.find(([m]) => m === 'whereIn')[2]).not.toContain('active_customer');
    expect(matches).toHaveBeenCalledWith(rows[1], '101 EXAMPLE TRL', '34212', null);
    rows.pop();
    expect(await findOwnCustomerReal({ row: mockRow }, validContact(INPUT()), { db: jest.fn(() => q), booking: { addressMatchesCustomer: matches } })).toBeNull();
  });

  test('the signed offer is verified (the funnel check, this pin and service) before any lookup or write; a bad one is 400 invalid_offer', async () => {
    verifySlotOfferField.mockReturnValue(false);
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 400, body: { error: 'invalid_offer' } });
    expect(findOwnCustomer).not.toHaveBeenCalled();
    expect(findExistingCustomer).not.toHaveBeenCalled();
    expect(findCommittedBookingCustomer).not.toHaveBeenCalled();
    expect(quote.priceHome).not.toHaveBeenCalled();
    expect(mintCustomer).not.toHaveBeenCalled();
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
    verifySlotOfferField.mockReturnValue(true);
    await bookHome(TOKEN, INPUT(), deps);
    expect(verifySlotOfferField).toHaveBeenLastCalledWith({
      surface: 'booking', scopeId: '', serviceKey: 'pest_control', locationKey: '27.50,-82.50', date: '2026-12-02', startMinutes: 540,
      technicianId: TECH, durationMinutes: 60, policy: 'policy',
    }, 'sig-2026-12-02-09:00');
  });

  test('the price the page showed must be sent, and must be the stored price to the cent, before anything is written', async () => {
    for (const price of [undefined, null, 'x', { annual: 'abc' }, { annual: 0 }, { annual: 627, setupFee: -1 }]) {
      expect(await bookHome(TOKEN, { ...INPUT(), price }, deps)).toEqual({ status: 400, body: { error: 'invalid_price' } });
    }
    for (const price of [{ annual: 627.01, setupFee: 0 }, { annual: 626.99, setupFee: 0 }, { annual: 627, setupFee: 0.01 }, { annual: 600, setupFee: 0 }]) {
      expect(await bookHome(TOKEN, { ...INPUT(), price }, deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    }
    expect(findOwnCustomer).not.toHaveBeenCalled();
    expect(mintCustomer).not.toHaveBeenCalled();
    expect(saveEstimate).not.toHaveBeenCalled();
    // A setup fee the page never showed, then repriced on the row: the sent price is the old one.
    mockRow = row({ price_setup_fee: '99.00' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
  });

  test('the saved draft must carry the shown annual AND the shown setup fee', async () => {
    mockRow = row({ price_setup_fee: '99.00' });
    const input = { ...INPUT(), price: { annual: 627, setupFee: 99 } };
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 0, digest: 'd' } });
    expect(await bookHome(TOKEN, input, deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(updates).toEqual([]);
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a disclosed setup fee is frozen into the draft as the wizard freezes it (estimate_data.setupFeeQuote); no fee writes none', async () => {
    mockRow = row({ price_setup_fee: '99.00' });
    const input = { ...INPUT(), price: { annual: 627, setupFee: 99 } };
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 99, digest: 'd' } });
    expect((await bookHome(TOKEN, input, deps)).status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ source: 'quote_wizard', lead_source: 'mail_new_home' });
    expect(updates[0].estimate_data.sql).toMatch(/COALESCE\(estimate_data, '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toEqual({ setupFeeQuote: { amount: 99, kind: 'waveguard_membership' } });
    updates.length = 0;
    mockRow = row();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 0, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 0, digest: 'd' } });
    expect((await bookHome(TOKEN, INPUT(), deps)).status).toBe(200);
    expect(updates[0]).not.toHaveProperty('estimate_data');
  });

  test('the booking carries a commit guard that re-reads the gates and the locked prospect row inside its transaction', async () => {
    await bookHome(TOKEN, INPUT(), deps);
    const { commitGuard } = booking.createSelfBooking.mock.calls[0][0];
    expect(typeof commitGuard).toBe('function');
    const trxFor = (found, liveRows = []) => {
      const prospect = {};
      prospect.where = jest.fn(() => prospect);
      prospect.forShare = jest.fn(() => prospect);
      prospect.first = jest.fn(async () => found);
      const live = {};
      for (const m of ['join', 'where', 'whereNot', 'whereRaw', 'limit']) live[m] = jest.fn(() => live);
      live.select = jest.fn(async () => liveRows);
      const trx = jest.fn((table) => (table === 'mail_prospects' ? prospect : live));
      trx.raw = jest.fn(async () => ({}));
      return Object.assign(trx, { prospect, live });
    };
    const ok = { price_annual: '627.00', price_setup_fee: '0.00' };
    const liveTrx = trxFor(ok);
    expect(await commitGuard(liveTrx)).toBe(true);
    // The first-booking claim: an advisory lock on this prospect, taken before the row and the bookings are read.
    expect(liveTrx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['mail-home-first-booking', 'prospect-1']);
    expect(liveTrx.raw.mock.invocationCallOrder[0]).toBeLessThan(liveTrx.prospect.first.mock.invocationCallOrder[0]);
    expect(liveTrx).toHaveBeenCalledWith('mail_prospects');
    expect(liveTrx.prospect.where).toHaveBeenCalledWith({ id: 'prospect-1', list_key: 'new_home', status: 'eligible', price_status: 'priced' });
    expect(liveTrx.prospect.forShare).toHaveBeenCalled();
    expect(liveTrx.live.where).toHaveBeenCalledWith('sba.source', 'mail_new_home');
    expect(liveTrx.live.whereNot).toHaveBeenCalledWith('sba.status', 'cancelled');
    // The prospect held back, repriced (annual or setup fee) or gone since the check: refused.
    expect(await commitGuard(trxFor(undefined))).toBe(false);
    expect(await commitGuard(trxFor({ price_annual: '641.50', price_setup_fee: '0.00' }))).toBe(false);
    expect(await commitGuard(trxFor({ price_annual: '627.00', price_setup_fee: '99.00' }))).toBe(false);
    // Another household member's first booking of this home is live: refused (the second of two simultaneous bookings,
    // once the first has committed under the lock). A booking at another address is not.
    booking.addressMatchesCustomer.mockImplementation((c) => c.id === 'other-member');
    expect(await commitGuard(trxFor(ok, [{ id: 'other-member', address_line1: '101 Example Trl', zip: '34212' }]))).toBe(false);
    expect(await commitGuard(trxFor(ok, [{ id: 'elsewhere', address_line1: '101 Example Ct', zip: '34212' }]))).toBe(true);
    // A home with no house number or zip cannot be matched: fail closed.
    const blankGuard = commitGuardFor({ row: row({ address_line1: 'LOT 4' }) }, SHOWN, deps);
    expect(await blankGuard(trxFor(ok))).toBe(false);
    // The mail gate or /book turned off since: refused before the lock or the row is touched.
    gates.mailHomePageLive.mockReturnValue(false);
    const off = trxFor(ok);
    expect(await commitGuard(off)).toBe(false);
    expect(off).not.toHaveBeenCalled();
    expect(off.raw).not.toHaveBeenCalled();
    gates.mailHomePageLive.mockReturnValue(true);
    gates.isEnabled.mockImplementation((name) => name !== 'selfBooking');
    expect(await commitGuard(trxFor(ok))).toBe(false);
  });

  test('an identical retry of a booking that committed (the customer has moved past the pre-customer stage) goes to createSelfBooking for its replay', async () => {
    findCommittedBookingCustomer.mockResolvedValue('cust-1');
    findOwnCustomer.mockResolvedValue(null); // the promoted row is no longer a pre-customer row
    findExistingCustomer.mockResolvedValue({ id: 'cust-1' }); // and the matcher finds it as a customer
    quote.priceHome.mockResolvedValue({ status: 'not_clean', reason: 'member_address' }); // a member at the address now
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' } } });
    expect(findCommittedBookingCustomer).toHaveBeenCalledWith(expect.objectContaining({ row: mockRow }), expect.objectContaining({ phone10: '9415550142' }), expect.objectContaining({ date: '2026-12-02', start: '09:00' }), deps);
    expect(findOwnCustomer).not.toHaveBeenCalled();
    expect(findExistingCustomer).not.toHaveBeenCalled();
    expect(quote.priceHome).not.toHaveBeenCalled();
    expect(mintCustomer).not.toHaveBeenCalled();
    expect(saveEstimate).not.toHaveBeenCalled();
    const payload = booking.createSelfBooking.mock.calls[0][0];
    expect(payload).toMatchObject({ customer_id: 'cust-1', pricing_estimate_id: draftIdFor('prospect-1', validContact(INPUT()), SHOWN), slot_date: '2026-12-02', slot_start: '09:00' });
    expect(verifyEstimateHandoffToken(payload.pricing_estimate_id, payload.estimate_token)).toBe(true);
    // The signed offer was still checked first.
    expect(verifySlotOfferField).toHaveBeenCalled();
  });

  test('a committed booking whose draft is gone falls back to the normal path', async () => {
    findCommittedBookingCustomer.mockResolvedValue('cust-1');
    mockEstimateRow = undefined;
    await bookHome(TOKEN, INPUT(), deps);
    expect(findOwnCustomer).toHaveBeenCalled();
    expect(saveEstimate).toHaveBeenCalled();
  });

  test('findCommittedBookingCustomer reads a live mail_new_home booking at this slot and matches the customer by phone and home address, in any stage', async () => {
    const calls = [];
    const q = {};
    for (const m of ['join', 'where', 'whereNot', 'whereNull', 'whereRaw', 'limit']) q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
    const rows = [
      { id: 'other', phone: '+19415550199', address_line1: '101 Example Trl', zip: '34212' },
      { id: 'mine', phone: '+19415550142', address_line1: '101 Example Trl', zip: '34212' },
    ];
    q.select = jest.fn(async () => rows);
    const conn = jest.fn(() => q);
    const matches = jest.fn(() => true);
    const id = await findCommittedBookingCustomerReal({ row: mockRow }, validContact(INPUT()), { date: '2026-12-02', start: '09:00' }, { db: conn, booking: { addressMatchesCustomer: matches } });
    expect(id).toBe('mine');
    expect(conn).toHaveBeenCalledWith('self_booked_appointments as sba');
    expect(calls).toEqual(expect.arrayContaining([
      ['where', 'sba.source', 'mail_new_home'], ['where', 'sba.date', '2026-12-02'], ['where', 'sba.start_time', '09:00'],
      ['whereNot', 'sba.status', 'cancelled'], ['where', 'c.lead_source', 'mail_new_home'], ['whereNull', 'c.deleted_at'],
    ]));
    // No pipeline-stage filter: the booking has promoted the customer.
    expect(JSON.stringify(calls)).not.toMatch(/pipeline_stage/);
    rows.length = 0;
    expect(await findCommittedBookingCustomerReal({ row: mockRow }, validContact(INPUT()), { date: '2026-12-02', start: '09:00' }, { db: conn, booking: { addressMatchesCustomer: matches } })).toBeNull();
  });

  test('the phone sent to createSelfBooking has the digits the minted row stores, so its customer_id phone match resolves the same row', async () => {
    const { applyContactNormalization } = require('../utils/intake-normalize');
    const contact = validContact(INPUT());
    const storedPhone = applyContactNormalization({ phone: contact.phone10 }).phone; // what insertCustomer writes
    await bookHome(TOKEN, INPUT(), deps);
    const sent = booking.createSelfBooking.mock.calls[0][0].new_customer.phone;
    expect(sent.replace(/\D/g, '')).toBe(storedPhone.replace(/\D/g, ''));
    expect(sent.replace(/\D/g, '')).toHaveLength(11);
  });

  test('the new customer is seeded with the default notification and property rows, inside the mint transaction', async () => {
    const admin = require('../routes/admin-customers');
    const { createDefaultCustomerRows } = require('../services/customer-default-rows');
    createDefaultCustomerRows.mockClear();
    admin.ensureCustomerAccount.mockReset().mockResolvedValue({ accountId: 'acct-1', existingCustomer: null, created: true });
    const { conn, trx } = txConn();
    await mintCustomerReal({ row: mockRow }, validContact(INPUT()), { lat: 27.5, lng: -82.5 }, { db: conn, findExistingCustomer });
    expect(createDefaultCustomerRows).toHaveBeenCalledWith(trx, 'cust-9');
    // A refused mint seeds nothing.
    createDefaultCustomerRows.mockClear();
    findExistingCustomer.mockResolvedValue({ id: 'x' });
    await expect(mintCustomerReal({ row: mockRow }, validContact(INPUT()), { lat: 27.5, lng: -82.5 }, { db: txConn().conn, findExistingCustomer })).rejects.toMatchObject({ code: 'CONTACT_ON_FILE' });
    expect(createDefaultCustomerRows).not.toHaveBeenCalled();
  });

  test('the disclosed price must be both fields, as JSON numbers in whole cents: a missing fee, a boolean, a string or an array is 400 invalid_price', async () => {
    expect(validShownPrice({ annual: 627, setupFee: 0 })).toEqual({ annualCents: 62700, setupCents: 0 });
    expect(validShownPrice({ annual: 52.25, setupFee: 99.5 })).toEqual({ annualCents: 5225, setupCents: 9950 });
    for (const price of [
      { annual: 627 }, { annual: 627, setupFee: null }, { annual: 627, setupFee: false }, { annual: 627, setupFee: true },
      { annual: 627, setupFee: [0] }, { annual: 627, setupFee: '0' }, { annual: '627', setupFee: 0 }, { annual: [627], setupFee: 0 },
      { annual: true, setupFee: 0 }, { annual: 627.001, setupFee: 0 }, { annual: 627, setupFee: 0.005 }, { annual: 627, setupFee: -1 }, { annual: 0, setupFee: 0 },
    ]) {
      expect(validShownPrice(price)).toBeNull();
      expect(await bookHome(TOKEN, { ...INPUT(), price }, deps)).toEqual({ status: 400, body: { error: 'invalid_price' } });
    }
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('a repriced home gets a fresh draft id, so a draft a slot conflict left behind never pins the old price', async () => {
    mockRow = row({ price_annual: '641.50' });
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 641.5, priceSetupFee: 0, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 641.5, setupFee: 0, digest: 'd' } });
    await bookHome(TOKEN, { ...INPUT(), price: { annual: 641.5, setupFee: 0 } }, deps);
    const repricedId = saveEstimate.mock.calls[0][0].clientDraftId;
    expect(repricedId).not.toBe(draftIdFor('prospect-1', validContact(INPUT()), SHOWN));
    expect(repricedId).toBe(draftIdFor('prospect-1', validContact(INPUT()), { annualCents: 64150, setupCents: 0 }));
    // The same price and contact still reach the same draft (a repeat tap).
    expect(draftIdFor('prospect-1', validContact(INPUT()), SHOWN)).toBe(draftIdFor('prospect-1', validContact(INPUT()), { ...SHOWN }));
  });

  test('the success window is the customer arrival window from the committed start, whatever end the caller sent', async () => {
    const noEnd = { ...INPUT(), offer: { ...offer('2026-12-02', '09:00'), end_time: undefined } };
    expect(await bookHome(TOKEN, noEnd, deps)).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' } } });
    // The committed booking's own start wins over the offer's.
    booking.createSelfBooking.mockResolvedValue({ ok: true, body: { booking: { start_time: '13:00:00' } } });
    expect((await bookHome(TOKEN, INPUT(), deps)).body.window).toEqual({ start: '13:00', end: '15:00' });
  });

  test('/book off is not_available', async () => {
    gates.isEnabled.mockImplementation((name) => name !== 'selfBooking');
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('saves the estimate (not a dry run) from the stored facts plus the contact, then books through createSelfBooking with a valid handoff token', async () => {
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' } } });

    // The price is checked with the stored row and its facts first.
    expect(quote.priceHome).toHaveBeenCalledWith(mockRow, { homeSqft: 2400, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 9000 }, {});

    expect(saveEstimate).toHaveBeenCalledTimes(1);
    const body = saveEstimate.mock.calls[0][0];
    expect(body.dryRun).toBeUndefined();
    expect(body).toMatchObject({
      address: '101 EXAMPLE TRL, SAMPLETON FL 34212',
      customerName: 'Sample Person',
      customerPhone: '+19415550142',
      customerEmail: 'sample@example.com',
      clientDraftId: draftIdFor('prospect-1', validContact(INPUT()), SHOWN),
      billByInvoice: false,
      showOneTimeOption: false,
    });
    // The draft carries the customer's id (the pre-customer row), as the wizard's draft does.
    expect(body.customerId).toBe('cust-1');
    expect(body.estimateData.engineInputs).toEqual({ engine: 'input' });
    expect(body.estimateData.inputs).toMatchObject({ homeSqFt: '2400', lotSqFt: '9000', stories: '1', svcPest: true, pestFreq: '4' });
    expect(deps.buildEngineInput).toHaveBeenCalledTimes(1);

    // The draft is marked as the quote-wizard draft /book accepts, with the postcard lead source.
    expect(updates).toEqual([{ source: 'quote_wizard', lead_source: 'mail_new_home', lead_source_detail: 'new_home_postcard' }]);

    expect(booking.createSelfBooking).toHaveBeenCalledTimes(1);
    const payload = booking.createSelfBooking.mock.calls[0][0];
    expect(payload).toMatchObject({
      pricing_estimate_id: 'est-1',
      slot_date: '2026-12-02', slot_start: '09:00', slot_end: '10:00', technician_id: TECH, slot_sig: 'sig-2026-12-02-09:00',
      service_id: 'pest_control', service_type: 'Pest Control', recurring_pattern: 'quarterly', source: 'mail_new_home',
      customer_id: 'cust-1', payAtVisit: true, customersOnly: true, authedCustomer: null, callbackVisit: null,
      new_customer: {
        first_name: 'Sample', last_name: 'Person', phone: '+19415550142', email: 'sample@example.com',
        address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212', lat: 27.5, lng: -82.5,
      },
    });
    expect(verifyEstimateHandoffToken('est-1', payload.estimate_token)).toBe(true);
    expect(verifyEstimateHandoffToken('est-2', payload.estimate_token)).toBe(false);
  });

  test('the default save is the canonical createOrReuseAdminEstimate, live (not a dry run), with live pricing required', async () => {
    const persistence = require('../services/admin-estimate-persistence');
    const spy = jest.spyOn(persistence, 'createOrReuseAdminEstimate').mockResolvedValue({ estimate: { id: 'est-1' }, reused: false, memberLinkageWarning: null });
    try {
      const { saveEstimate: _unused, ...rest } = deps;
      await bookHome(TOKEN, INPUT(), rest);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0];
      expect(arg.dryRun).toBeFalsy();
      expect(arg).toMatchObject({ requireLivePricing: true, technicianId: null, technician: null });
      expect(arg.body.customerEmail).toBe('sample@example.com');
    } finally {
      spy.mockRestore();
    }
  });

  test('a repeat tap reaches the same draft id (the save reuses the estimate); another contact is another draft', async () => {
    await bookHome(TOKEN, INPUT(), deps);
    await bookHome(TOKEN, INPUT(), deps);
    const ids = saveEstimate.mock.calls.map(([body]) => body.clientDraftId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await bookHome(TOKEN, { ...INPUT(), email: 'other@example.com' }, deps);
    expect(saveEstimate.mock.calls[2][0].clientDraftId).not.toBe(ids[0]);
    // The reused estimate is booked again; the booking's own replay answers a repeat of the same slot.
    saveEstimate.mockResolvedValue({ estimate: { id: 'est-1', annual_total: 627 }, reused: true, memberLinkageWarning: null });
    expect((await bookHome(TOKEN, INPUT(), deps)).status).toBe(200);
  });

  test('a live price that is no longer the one the page showed is 409 price_changed, with nothing saved or booked', async () => {
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 641.5, priceSetupFee: 0, priceDigest: 'd' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    // Any difference is a change: one cent too.
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627.01, priceSetupFee: 0, priceDigest: 'd' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(mintCustomer).not.toHaveBeenCalled();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a member at the address, a quote-required or review price, or an unclean save is 409 not_available; a failed price check is 503', async () => {
    for (const reason of ['member_address', 'member_unchecked', 'engine_review', 'not_one_line', 'no_amount', 'save_refused']) {
      quote.priceHome.mockResolvedValue({ status: 'not_clean', reason });
      expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'not_available' } });
    }
    quote.priceHome.mockResolvedValue({ status: 'failed', reason: 'engine' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
    quote.priceHome.mockRejectedValue(new Error('boom'));
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
    expect(saveEstimate).not.toHaveBeenCalled();
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('a save the server refuses (4xx) is 409 not_available, any other save error is thrown, and a drifted saved price stops before the booking', async () => {
    saveEstimate.mockRejectedValue(Object.assign(new Error('refused'), { statusCode: 422 }));
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'not_available' } });
    saveEstimate.mockRejectedValue(Object.assign(new Error('down'), { statusCode: 503 }));
    await expect(bookHome(TOKEN, INPUT(), deps)).rejects.toThrow('down');
    saveEstimate.mockResolvedValue({ estimate: { id: 'est-1' }, memberLinkageWarning: null });
    quote.judge.mockReturnValue({ reason: 'engine_review' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    quote.judge.mockReturnValue({ price: { annual: 700, setupFee: 0, digest: 'd' } });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a taken slot is 409 slot_taken with the times that are open now', async () => {
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, code: 'SLOT_TAKEN', error: 'Someone just booked that time.' });
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_taken');
    expect(res.body.offers.map((o) => o.slot_sig)).toEqual(['s-2-08', 's-2-14', 's-3-09', 's-3-13']);

    // /book's expired or unsigned offer answers the same way.
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, error: 'That time slot is no longer available — please pick your time again.' });
    expect((await bookHome(TOKEN, INPUT(), deps)).body.error).toBe('slot_taken');
  });

  test('other /book refusals: a phone already on file, the customers-only refusal and a server error', async () => {
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, error: 'This phone number is already on file. Please verify the customer profile before booking.' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'contact_on_file' } });
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 403, customersOnly: true, error: 'Online self-scheduling is for current Waves customers.' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'not_available' } });
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 409, code: 'ADDRESS_UNVERIFIED', error: 'County records could not confirm this house number.' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'not_available' } });
    booking.createSelfBooking.mockResolvedValue({ ok: false, status: 500, error: 'x' });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
  });

  test('no pin for the address is not_available, before any save', async () => {
    booking.resolveOfferCoords.mockResolvedValue({ lat: null, lng: null });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
    expect(saveEstimate).not.toHaveBeenCalled();
  });
});
