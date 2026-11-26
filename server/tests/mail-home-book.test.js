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
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerEmail: jest.fn(async () => {}) }));
jest.mock('../services/customer-default-rows', () => ({ createDefaultCustomerRows: jest.fn(async () => {}) }));

const { verifyEstimateHandoffToken } = require('../utils/estimate-handoff-token');
const realQuote = require('../services/mail/home-quote');
const {
  getHomeTimes, bookHome, draftIdFor, validContact, validOffer, validShownPrice, offersOf, findOwnCustomer: findOwnCustomerReal, mintCustomer: mintCustomerReal,
  findCommittedBookingCustomer: findCommittedBookingCustomerReal, commitGuardFor, termsFor, priceIsHeld,
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
function txConn({ emailRow } = {}) {
  const inserted = [];
  const emailQuery = {};
  emailQuery.whereRaw = jest.fn(() => emailQuery);
  emailQuery.whereNull = jest.fn(() => emailQuery);
  emailQuery.first = jest.fn(async () => emailRow);
  const trx = jest.fn(() => Object.assign(emailQuery, {
    insert: jest.fn((r) => { inserted.push(r); return { returning: jest.fn(async () => [{ id: 'cust-9' }]) }; }),
  }));
  trx.emailQuery = emailQuery;
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
    memberAtAddressOn: jest.fn((conn) => ({ memberAt: conn })),
    memberStatusOf: jest.fn(async () => null),
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
    resolveBookingVisitPrice: jest.fn(() => ({ amount: 156.75, followUpAmount: 156.75 })),
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

  test('the booking carries the postcard first touch (print, no click id) so it is attributed to the New-home postcard source', async () => {
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res.status).toBe(200);
    const sent = booking.createSelfBooking.mock.calls[0][0];
    expect(sent.attribution).toEqual({ observed: true, utm: { source: 'new_home_postcard', medium: 'print' } });
    expect(sent.source).toBe('mail_new_home');
    const { determineLeadSource } = require('../services/lead-source-classify');
    const u = sent.attribution.utm;
    expect(determineLeadSource('', '', u.source, u.medium, '', '')).toMatchObject({ source: 'new_home_postcard', channel: 'offline' });
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
    // An email already on any live profile (several profiles sharing it make the wizard matcher return nothing), found
    // under the email fence: refused.
    findExistingCustomer.mockResolvedValue(null);
    const shared = txConn({ emailRow: { id: 'shares-email' } });
    const sharedErr = await mintCustomerReal({ row: mockRow }, validContact(INPUT()), { lat: 27.5, lng: -82.5 }, { db: shared.conn, findExistingCustomer }).catch((e) => e);
    expect(sharedErr.code).toBe('CONTACT_ON_FILE');
    expect(shared.inserted).toEqual([]);
    expect(shared.trx.emailQuery.whereRaw).toHaveBeenCalledWith("LOWER(TRIM(COALESCE(email, ''))) = ?", ['sample@example.com']);
    expect(shared.trx.emailQuery.whereNull).toHaveBeenCalledWith('deleted_at');
    // Any other error is not hidden.
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
    expect(admin.ensureCustomerAccount).toHaveBeenCalledWith(trx, { firstName: 'Sample', lastName: 'Person', phone: '9415550142', email: 'sample@example.com', lockPhone: true, matchEmail: true });
    // The email fence, after the phone fence and before the checks and the insert.
    expect(require('../utils/customer-comms-lock').lockCustomerEmail).toHaveBeenCalledWith(trx, 'sample@example.com');
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
      { id: 'other-home', phone: '+19415550142', email: 'sample@example.com', address_line1: '9 OTHER ST', zip: '34212' },
      { id: 'mine', phone: '+19415550142', email: 'sample@example.com', address_line1: '101 Example Trl', zip: '34212' },
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
    // A retry that changes the email is another contact: the row is not reused (the existing-contact check then runs).
    const changed = { ...validContact(INPUT()), email: 'someone.else@example.com' };
    expect(await findOwnCustomerReal({ row: mockRow }, changed, { db: jest.fn(() => q), booking: { addressMatchesCustomer: matches } })).toBeNull();
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

  test('a disclosed setup fee is frozen into the draft as the wizard freezes it (estimate_data.setupFeeQuote); no fee freezes an explicit zero', async () => {
    mockRow = row({ price_setup_fee: '99.00' });
    const input = { ...INPUT(), price: { annual: 627, setupFee: 99 } };
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 99, digest: 'd' } });
    expect((await bookHome(TOKEN, input, deps)).status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ source: 'quote_wizard', lead_source: 'mail_new_home' });
    expect(updates[0].estimate_data.sql).toMatch(/COALESCE\(estimate_data, '\{\}'::jsonb\) \|\| \?::jsonb/);
    // The draft also carries the prospect it was made for: the server-side link the first-booking claim follows.
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toMatchObject({ mailProspectId: 'prospect-1', setupFeeQuote: { amount: 99, kind: 'waveguard_membership' } });
    updates.length = 0;
    mockRow = row();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 0, priceDigest: 'd' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 0, digest: 'd' } });
    expect((await bookHome(TOKEN, INPUT(), deps)).status).toBe(200);
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toEqual({ mailProspectId: 'prospect-1', mailShownKey: draftIdFor('prospect-1', validContact(INPUT()), SHOWN), setupFeeQuote: { amount: 0, kind: 'waveguard_membership' } });
  });

  test('the booking carries a commit guard that re-reads the gates and the locked prospect row inside its transaction', async () => {
    await bookHome(TOKEN, INPUT(), deps);
    const { commitGuard } = booking.createSelfBooking.mock.calls[0][0];
    expect(typeof commitGuard).toBe('function');
    // What createSelfBooking resolved for the visit just before it calls the guard.
    const STAMP = { custId: 'cust-1', visitPrice: 156.75, followUpVisitPrice: 156.75, paymentPref: 'pay_at_visit', sourceEstimateId: 'est-1' };
    const guard = (t, ctx = STAMP) => commitGuard(t, ctx);
    const DRAFT = { annual_total: '627.00', pricing_authority: 'SERVER', estimate_data: { mailProspectId: 'prospect-1', setupFeeQuote: { amount: 0, kind: 'waveguard_membership' } } };
    const trxFor = (found, liveVisit = undefined, draft = DRAFT) => {
      const prospect = {};
      prospect.where = jest.fn(() => prospect);
      prospect.forShare = jest.fn(() => prospect);
      prospect.first = jest.fn(async () => found);
      const estimate = {};
      estimate.where = jest.fn(() => estimate);
      estimate.forShare = jest.fn(() => estimate);
      estimate.first = jest.fn(async () => draft);
      const live = {};
      for (const m of ['join', 'whereRaw', 'whereNot', 'whereNotIn']) live[m] = jest.fn(() => live);
      live.first = jest.fn(async () => liveVisit);
      const tables = { mail_prospects: prospect, estimates: estimate };
      const trx = jest.fn((table) => tables[table] || live);
      trx.raw = jest.fn(async () => ({}));
      return Object.assign(trx, { prospect, estimate, live });
    };
    const ok = { price_annual: '627.00', price_setup_fee: '0.00' };
    const liveTrx = trxFor(ok);
    expect(await guard(liveTrx)).toBe(true);
    // The first-booking claim: an advisory lock on this prospect, taken before the row and the bookings are read.
    expect(liveTrx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['mail-home-first-booking', 'prospect-1']);
    expect(liveTrx.raw.mock.invocationCallOrder[0]).toBeLessThan(liveTrx.prospect.first.mock.invocationCallOrder[0]);
    expect(liveTrx).toHaveBeenCalledWith('mail_prospects');
    expect(liveTrx.prospect.where).toHaveBeenCalledWith({ id: 'prospect-1', list_key: 'new_home', status: 'eligible', price_status: 'priced' });
    expect(liveTrx.prospect.forShare).toHaveBeenCalled();
    // The draft the visit is priced from is read FOR SHARE on this transaction, by the id the booking was made for.
    expect(liveTrx.estimate.where).toHaveBeenCalledWith({ id: 'est-1' });
    expect(liveTrx.estimate.forShare).toHaveBeenCalled();
    // The first-booking check follows the prospect id the draft carries (no address match, no cap, no source string), and
    // reads the visit's own status: cancelled, skipped and rescheduled visits are not live.
    expect(liveTrx.live.whereRaw).toHaveBeenCalledWith("e.estimate_data->>'mailProspectId' = ?", ['prospect-1']);
    expect(liveTrx.live.whereNotIn).toHaveBeenCalledWith('ss.status', ['cancelled', 'skipped', 'rescheduled']);
    // Linked through the visit's own source_estimate_id (the exact draft), never through the customer.
    expect(liveTrx.live.join).toHaveBeenCalledWith('estimates as e', 'e.id', 'ss.source_estimate_id');
    expect(JSON.stringify(liveTrx.live.whereRaw.mock.calls)).not.toMatch(/source/);
    // The strict member check runs again on THIS transaction.
    expect(quote.memberAtAddressOn).toHaveBeenCalledWith(liveTrx);
    expect(quote.memberStatusOf).toHaveBeenCalledWith(mockRow, { memberAt: liveTrx });
    for (const status of ['exact', 'near']) {
      quote.memberStatusOf.mockResolvedValueOnce(status);
      expect(await guard(trxFor(ok))).toBe(false);
    }
    quote.memberStatusOf.mockRejectedValueOnce(new Error('lookup down'));
    expect(await guard(trxFor(ok))).toBe(false);
    // The price this booking is about to stamp is the one resolveBookingVisitPrice gives for the locked draft, cent-exact,
    // linked to that draft, pay-at-visit. Missing or different refuses; with pay-at-visit off nothing is stamped or checked.
    expect(deps.resolveBookingVisitPrice).toHaveBeenCalledWith({ estimate: DRAFT, serviceKey: 'pest_control', bookingVisits: 4 });
    for (const bad of [
      { ...STAMP, visitPrice: null }, { ...STAMP, visitPrice: 156.76 }, { ...STAMP, followUpVisitPrice: undefined }, { ...STAMP, followUpVisitPrice: 150 },
      { ...STAMP, paymentPref: null }, { ...STAMP, sourceEstimateId: 'another-draft' }, { ...STAMP, sourceEstimateId: null },
    ]) {
      expect(await guard(trxFor(ok), bad)).toBe(false);
    }
    deps.resolveBookingVisitPrice.mockReturnValueOnce(null); // the draft cannot be priced per visit
    expect(await guard(trxFor(ok))).toBe(false);
    deps.resolveBookingVisitPrice.mockReturnValueOnce({ amount: 156.75 }); // no separate follow-up amount: the same amount
    expect(await guard(trxFor(ok))).toBe(true);
    gates.isEnabled.mockImplementation((name) => name !== 'bookingPayAtVisit');
    expect(await guard(trxFor(ok), { custId: 'cust-1' })).toBe(true);
    gates.isEnabled.mockImplementation(() => true);
    // The prospect held back, repriced (annual or setup fee) or gone since the check: refused.
    expect(await guard(trxFor(undefined))).toBe(false);
    expect(await guard(trxFor({ price_annual: '641.50', price_setup_fee: '0.00' }))).toBe(false);
    expect(await guard(trxFor({ price_annual: '627.00', price_setup_fee: '99.00' }))).toBe(false);
    // The draft revised after the price check (annual, or the frozen setup fee), or gone, or no longer a server price: refused.
    expect(await guard(trxFor(ok, undefined, { ...DRAFT, annual_total: '650.00' }))).toBe(false);
    expect(await guard(trxFor(ok, undefined, { ...DRAFT, estimate_data: { setupFeeQuote: { amount: 99 } } }))).toBe(false);
    expect(await guard(trxFor(ok, undefined, { ...DRAFT, pricing_authority: 'CLIENT_FALLBACK' }))).toBe(false);
    expect(await guard(trxFor(ok, undefined, undefined))).toBe(true); // control: the default draft holds
    expect(await guard(trxFor(ok, undefined, null))).toBe(false);
    // Another household member's first booking of this home is live: refused (the second of two simultaneous bookings,
    // once the first has committed under the lock).
    expect(await guard(trxFor(ok, { id: 'ss-other' }))).toBe(false);
    // A draft carrying the frozen setup fee at the shown amount holds.
    const feeGuard = commitGuardFor({ row: row({ price_setup_fee: '99.00' }) }, { annualCents: 62700, setupCents: 9900 }, 'est-1', deps);
    expect(await feeGuard(trxFor({ price_annual: '627.00', price_setup_fee: '99.00' }, undefined, { ...DRAFT, estimate_data: { setupFeeQuote: { amount: 99, kind: 'waveguard_membership' } } }), STAMP)).toBe(true);
    // The mail gate or /book turned off since: refused before the lock or the row is touched.
    gates.mailHomePageLive.mockReturnValue(false);
    const off = trxFor(ok);
    expect(await guard(off)).toBe(false);
    expect(off).not.toHaveBeenCalled();
    expect(off.raw).not.toHaveBeenCalled();
    gates.mailHomePageLive.mockReturnValue(true);
    gates.isEnabled.mockImplementation((name) => name !== 'selfBooking');
    expect(await guard(trxFor(ok))).toBe(false);
  });

  test('an identical retry of a booking that committed (the customer has moved past the pre-customer stage) goes to createSelfBooking for its replay', async () => {
    findCommittedBookingCustomer.mockResolvedValue('cust-1');
    findOwnCustomer.mockResolvedValue(null); // the promoted row is no longer a pre-customer row
    findExistingCustomer.mockResolvedValue({ id: 'cust-1' }); // and the matcher finds it as a customer
    quote.priceHome.mockResolvedValue({ status: 'not_clean', reason: 'member_address' }); // a member at the address now
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' } } }); // a replay carries no price
    expect(findCommittedBookingCustomer).toHaveBeenCalledWith(expect.objectContaining({ row: mockRow }), expect.objectContaining({ phone10: '9415550142' }), expect.objectContaining({ date: '2026-12-02', start: '09:00' }), draftIdFor('prospect-1', validContact(INPUT()), SHOWN), deps);
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

  test('findCommittedBookingCustomer follows the prospect id the draft carries to a live visit at this slot, and matches the customer by phone, in any stage', async () => {
    const calls = [];
    const q = {};
    // A where(callback) runs its callback on the same recorder (the grouped "this draft id, or a draft carrying this key").
    for (const m of ['join', 'where', 'whereNot', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereRaw', 'limit']) {
      q[m] = jest.fn((...a) => { if (typeof a[0] === 'function') a[0](q); else calls.push([m, ...a]); return q; });
    }
    const rows = [
      { id: 'other', phone: '+19415550199', source_estimate_id: 'est-other' },
      { id: 'mine', phone: '+19415550142', source_estimate_id: 'est-held' },
    ];
    q.select = jest.fn(async () => rows);
    const conn = jest.fn(() => q);
    const id = await findCommittedBookingCustomerReal({ row: mockRow }, validContact(INPUT()), { date: '2026-12-02', start: '09:00' }, 'est-x', { db: conn });
    // The customer and the draft the committed visit is linked to (with a held price that draft's id is not the key).
    expect(id).toEqual({ customerId: 'mine', estimateId: 'est-held' });
    expect(conn).toHaveBeenCalledWith('scheduled_services as ss');
    expect(calls).toEqual(expect.arrayContaining([
      ['whereRaw', "e.estimate_data->>'mailProspectId' = ?", ['prospect-1']], ['where', 'ss.source_estimate_id', 'est-x'],
      ['orWhereRaw', "e.estimate_data->>'mailShownKey' = ?", ['est-x']],
      ['whereNot', 'sba.status', 'cancelled'], ['whereNotIn', 'ss.status', ['cancelled', 'skipped', 'rescheduled']],
      ['where', 'sba.date', '2026-12-02'], ['where', 'sba.start_time', '09:00'], ['whereNull', 'c.deleted_at'],
    ]));
    // Neither a source string nor a pipeline stage decides: the booking has promoted the customer, and a request can send any source.
    expect(JSON.stringify(calls)).not.toMatch(/pipeline_stage|sba\.source"|lead_source/);
    rows.length = 0;
    expect(await findCommittedBookingCustomerReal({ row: mockRow }, validContact(INPUT()), { date: '2026-12-02', start: '09:00' }, 'est-x', { db: conn })).toBeNull();
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
    expect(await bookHome(TOKEN, noEnd, deps)).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' }, price: { annual: 627, monthly: 52.25, setupFee: 0 } } });
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
    expect(res).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '11:00' }, price: { annual: 627, monthly: 52.25, setupFee: 0 } } });

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
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ source: 'quote_wizard', lead_source: 'mail_new_home', lead_source_detail: 'new_home_postcard' });
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toEqual({ mailProspectId: 'prospect-1', mailShownKey: draftIdFor('prospect-1', validContact(INPUT()), SHOWN), setupFeeQuote: { amount: 0, kind: 'waveguard_membership' } });

    expect(booking.createSelfBooking).toHaveBeenCalledTimes(1);
    const payload = booking.createSelfBooking.mock.calls[0][0];
    expect(payload).toMatchObject({
      pricing_estimate_id: 'est-1',
      slot_date: '2026-12-02', slot_start: '09:00', slot_end: '10:00', technician_id: TECH, slot_sig: 'sig-2026-12-02-09:00',
      service_id: 'pest_control', service_type: 'Pest Control', recurring_pattern: 'quarterly', source: 'mail_new_home',
      customer_id: 'cust-1', source_estimate_id: 'est-1', payAtVisit: true, customersOnly: true, authedCustomer: null, callbackVisit: null,
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

// The postcard says "Held 60 days" (owner 2026-09-26: a sent quote is honored as sent; owner 2026-11-25: never more than
// the card, and the lower live price when ours went down).
describe('the printed price is held for a mailed home', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000);
  const snap = (annual, setupFee) => ({ plan: 'pest_quarterly', annual, monthly: Math.round((annual * 100) / 12) / 100, setupFee, pricedAt: '2026-11-22T22:00:00.000Z' });
  // A mailed home: the printed price lives in the snapshot (the columns are frozen to the same amounts).
  const held = (over = {}) => {
    const base = row({ mailed_at: daysAgo(3), ...over });
    return { mailed_price: snap(Number(base.price_annual), Number(base.price_setup_fee)), ...base };
  };
  const savedAt = (annual) => saveEstimate.mockImplementation(async (body) => ({ estimate: { id: 'est-1', annual_total: annual, address: body.address }, reused: false, memberLinkageWarning: null }));

  test('priceIsHeld: through the 60th Eastern day after mailing, never for a home that was not mailed', () => {
    const mailed = new Date('2026-11-24T15:00:00Z'); // held until 2027-01-23 (Eastern)
    expect(priceIsHeld(mailed, new Date('2026-11-24T16:00:00Z'))).toBe(true);
    expect(priceIsHeld(mailed, new Date('2027-01-24T04:30:00Z'))).toBe(true); // still Jan 23 in Eastern time
    expect(priceIsHeld(mailed, new Date('2027-01-24T05:30:00Z'))).toBe(false); // Jan 24, 12:30 AM Eastern
    expect(priceIsHeld(null)).toBe(false);
    expect(priceIsHeld('not a date')).toBe(false);
  });

  test('termsFor: the lower of the printed and the live amount for each of the annual price and the setup fee', () => {
    const shown = { annualCents: 62700, setupCents: 9900 };
    const on = { held: true };
    expect(termsFor(on, shown, { annualCents: 62700, setupCents: 9900 })).toEqual({ annualCents: 62700, setupCents: 9900, discountCents: 0, liveSetupCents: 9900, held: false });
    expect(termsFor(on, shown, { annualCents: 66000, setupCents: 9900 })).toEqual({ annualCents: 62700, setupCents: 9900, discountCents: 3300, liveSetupCents: 9900, held: true });
    expect(termsFor(on, shown, { annualCents: 60000, setupCents: 12900 })).toEqual({ annualCents: 60000, setupCents: 9900, discountCents: 0, liveSetupCents: 12900, held: true });
    expect(termsFor(on, shown, { annualCents: 66000, setupCents: 0 })).toEqual({ annualCents: 62700, setupCents: 0, discountCents: 3300, liveSetupCents: 0, held: true });
    // No hold: only the exact shown price books.
    expect(termsFor({ held: false }, shown, { annualCents: 66000, setupCents: 9900 })).toBeNull();
    expect(termsFor({ held: false }, shown, { annualCents: 62700, setupCents: 9900 })).toMatchObject({ discountCents: 0 });
    // A live price that is no amount never books.
    expect(termsFor(on, shown, { annualCents: NaN, setupCents: 0 })).toBeNull();
    expect(termsFor(on, shown, { annualCents: 0, setupCents: 0 })).toBeNull();
  });

  test('our price went up: the visit books at the printed price through a fixed discount on the estimate', async () => {
    mockRow = held();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 660, priceSetupFee: 0, priceDigest: 'd2' });
    savedAt(627); // the save applied the discount
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toMatchObject({ status: 200, body: { booked: true, price: { annual: 627, monthly: 52.25, setupFee: 0 } } });
    const body = saveEstimate.mock.calls[0][0];
    expect(body.estimateData.operatorPriceAdjustment).toEqual({ type: 'FIXED', value: 33, label: 'Postcard price held', internalReason: expect.stringMatching(/held 60 days/) });
    // The draft's id follows the terms and the discount, and it carries the shown-price key for the retry recovery.
    expect(body.clientDraftId).toBe(draftIdFor('prospect-1', validContact(INPUT()), { ...SHOWN, discountCents: 3300 }));
    expect(body.clientDraftId).not.toBe(draftIdFor('prospect-1', validContact(INPUT()), SHOWN));
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toMatchObject({ mailShownKey: draftIdFor('prospect-1', validContact(INPUT()), SHOWN) });
  });

  test('a save that did not land on the printed price is refused, never booked', async () => {
    mockRow = held();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 660, priceSetupFee: 0, priceDigest: 'd2' });
    quote.judge.mockReturnValue({ price: { annual: 660, setupFee: 0, digest: 'd2' } }); // the discount did not apply
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(booking.createSelfBooking).not.toHaveBeenCalled();
  });

  test('our price went down: the visit books at the lower live price, with no discount, and the answer says the price', async () => {
    mockRow = held();
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 600, priceSetupFee: 0, priceDigest: 'd3' });
    quote.judge.mockReturnValue({ price: { annual: 600, setupFee: 0, digest: 'd3' } });
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toMatchObject({ status: 200, body: { booked: true, price: { annual: 600, monthly: 50, setupFee: 0 } } });
    const body = saveEstimate.mock.calls[0][0];
    expect(body.estimateData.operatorPriceAdjustment).toBeUndefined();
    // Another draft than the shown-price one, so a draft saved at an older price is never handed back.
    const terms = { annualCents: 60000, setupCents: 0 };
    expect(body.clientDraftId).toBe(draftIdFor('prospect-1', validContact(INPUT()), terms));
    expect(body.clientDraftId).not.toBe(draftIdFor('prospect-1', validContact(INPUT()), SHOWN));
  });

  test('a setup fee that went up stays the printed one: the draft freezes the printed fee', async () => {
    mockRow = held({ price_setup_fee: '49.00' });
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd4' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 99, digest: 'd4' } });
    const res = await bookHome(TOKEN, { ...INPUT(), price: { annual: 627, setupFee: 49 } }, deps);
    expect(res).toMatchObject({ status: 200, body: { price: { annual: 627, setupFee: 49 } } });
    expect(JSON.parse(updates[0].estimate_data.bindings[0])).toMatchObject({ setupFeeQuote: { amount: 49, kind: 'waveguard_membership' } });
    // The engine's fee is part of the draft key: a draft saved before the fee moved again is not reused.
    const contact = validContact(INPUT());
    const capped = { annualCents: 62700, setupCents: 4900, discountCents: 0 };
    expect(saveEstimate.mock.calls[0][0].clientDraftId).toBe(draftIdFor('prospect-1', contact, { ...capped, liveSetupCents: 9900 }));
    expect(draftIdFor('prospect-1', contact, { ...capped, liveSetupCents: 9900 })).not.toBe(draftIdFor('prospect-1', contact, { ...capped, liveSetupCents: 12900 }));
    // With no cap the key is the plain one.
    expect(draftIdFor('prospect-1', contact, { ...capped, liveSetupCents: 4900 })).toBe(draftIdFor('prospect-1', contact, { annualCents: 62700, setupCents: 4900 }));
  });

  test('a card that promised no setup fee freezes an explicit zero when the engine now has one, and conversion adds none', async () => {
    mockRow = held(); // printed setup fee 0
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 99, priceDigest: 'd5' });
    quote.judge.mockReturnValue({ price: { annual: 627, setupFee: 99, digest: 'd5' } });
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toMatchObject({ status: 200, body: { price: { setupFee: 0 } } });
    const frozen = JSON.parse(updates[0].estimate_data.bindings[0]);
    expect(frozen.setupFeeQuote).toEqual({ amount: 0, kind: 'waveguard_membership' });
    // The converter's own rule: a frozen zero means the quote disclosed no fee, so a later conversion adds none.
    const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');
    const recurring = [{ service: 'pest_control', name: 'Pest Control' }];
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: recurring, estimateData: frozen })).toBe(false);
  });

  test('the live fee fell to zero: the draft freezes an explicit zero too', async () => {
    mockRow = held({ price_setup_fee: '99.00' });
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627, priceSetupFee: 0, priceDigest: 'd6' });
    const res = await bookHome(TOKEN, { ...INPUT(), price: { annual: 627, setupFee: 99 } }, deps);
    expect(res).toMatchObject({ status: 200, body: { price: { setupFee: 0 } } });
    const frozen = JSON.parse(updates[0].estimate_data.bindings[0]);
    expect(frozen.setupFeeQuote).toEqual({ amount: 0, kind: 'waveguard_membership' });
    const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: [{ service: 'pest_control', name: 'Pest Control' }], estimateData: frozen })).toBe(false);
  });

  test('a mailed home books on its PRINTED price (the snapshot the page shows), never the columns', async () => {
    // The page shows 627.01 from the snapshot; the columns say 700.
    mockRow = { ...row({ mailed_at: daysAgo(3), price_annual: '700.00' }), mailed_price: snap(627.01, 0) };
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627.01, priceSetupFee: 0, priceDigest: 'd7' });
    quote.judge.mockReturnValue({ price: { annual: 627.01, setupFee: 0, digest: 'd7' } });
    const res = await bookHome(TOKEN, { ...INPUT(), price: { annual: 627.01, setupFee: 0 } }, deps);
    expect(res).toMatchObject({ status: 200, body: { booked: true } });
    // The columns' price is not the shown one.
    expect(await bookHome(TOKEN, { ...INPUT(), price: { annual: 700, setupFee: 0 } }, deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    // A mailed home whose snapshot cannot be read has no page price: the same 404 as an unknown token.
    mockRow = { ...row({ mailed_at: daysAgo(3) }), mailed_price: { plan: 'pest_quarterly' } };
    expect(await bookHome(TOKEN, INPUT(), deps)).toBeNull();
  });

  test('the retry of a committed booking answers with the price its draft holds', async () => {
    mockRow = held();
    findCommittedBookingCustomer.mockResolvedValue({ customerId: 'cust-1', estimateId: 'est-held' });
    mockEstimateRow = { id: 'est-held', annual_total: '600.00', estimate_data: { setupFeeQuote: { amount: 0, kind: 'waveguard_membership' } } };
    booking.createSelfBooking.mockResolvedValue({ ok: true, body: { replayed: true, booking: { id: 'b1' } } });
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toMatchObject({ status: 200, body: { booked: true, price: { annual: 600, monthly: 50, setupFee: 0 } } });
    expect(booking.createSelfBooking.mock.calls[0][0].pricing_estimate_id).toBe('est-held');
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('a concurrent submission that createSelfBooking answers as a replay carries no price', async () => {
    booking.createSelfBooking.mockResolvedValue({ ok: true, body: { replayed: true, booking: { id: 'b1' } } });
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('price');
  });

  test('after the 60 days, and for a home never mailed, a moved price is still price_changed', async () => {
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 660, priceSetupFee: 0, priceDigest: 'd2' });
    mockRow = held({ mailed_at: daysAgo(62) });
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    mockRow = row(); // never mailed
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('the page must still send the printed price: a held home does not accept another shown price', async () => {
    mockRow = held();
    expect(await bookHome(TOKEN, { ...INPUT(), price: { annual: 600, setupFee: 0 } }, deps)).toEqual({ status: 409, body: { error: 'price_changed' } });
    expect(quote.priceHome).not.toHaveBeenCalled();
  });

  test('the commit guard checks the draft at the terms, and refuses held terms once the hold has ended', async () => {
    const shown = { annualCents: 62700, setupCents: 0 };
    const terms = { annualCents: 60000, setupCents: 0, discountCents: 0, liveSetupCents: 0, held: true };
    const lockedRow = (mailedAt) => (mailedAt
      ? { price_annual: '627.00', price_setup_fee: '0.00', mailed_at: mailedAt, mailed_price: snap(627, 0) }
      : { price_annual: '627.00', price_setup_fee: '0.00', mailed_at: null, mailed_price: null });
    const trxFor = (draft, locked = lockedRow(daysAgo(3))) => {
      const prospect = {}; prospect.where = jest.fn(() => prospect); prospect.forShare = jest.fn(() => prospect);
      prospect.first = jest.fn(async () => locked);
      const estimate = {}; estimate.where = jest.fn(() => estimate); estimate.forShare = jest.fn(() => estimate); estimate.first = jest.fn(async () => draft);
      const live = {}; for (const m of ['join', 'whereRaw', 'whereNot', 'whereNotIn']) live[m] = jest.fn(() => live);
      live.first = jest.fn(async () => undefined);
      const trx = jest.fn((table) => ({ mail_prospects: prospect, estimates: estimate }[table] || live));
      trx.raw = jest.fn(async () => ({}));
      return trx;
    };
    gates.isEnabled.mockImplementation((name) => name !== 'bookingPayAtVisit');
    const draftAt = (annual, data = { setupFeeQuote: { amount: 0, kind: 'waveguard_membership' } }) => ({ annual_total: annual, pricing_authority: 'SERVER', estimate_data: data });
    const home = (mailedAt) => ({ row: { ...row(), mailed_at: mailedAt } });
    // Held: the draft must hold the terms (600), not the shown price (627).
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, terms)(trxFor(draftAt('600.00')))).toBe(true);
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, terms)(trxFor(draftAt('627.00')))).toBe(false);
    // The hold ended between the price check and the commit.
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, terms)(trxFor(draftAt('600.00'), lockedRow(daysAgo(62))))).toBe(false);
    // A discount that brings the price back to the shown one still relies on the hold (the amounts are equal).
    const discounted = { annualCents: 62700, setupCents: 0, discountCents: 3300, liveSetupCents: 0, held: true };
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, discounted)(trxFor(draftAt('627.00')))).toBe(true);
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, discounted)(trxFor(draftAt('627.00'), lockedRow(daysAgo(62))))).toBe(false);
    // The locked row's printed snapshot is the price compared, not its columns.
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, discounted)(trxFor(draftAt('627.00'), { ...lockedRow(daysAgo(3)), mailed_price: snap(650, 0) }))).toBe(false);
    // A draft whose frozen setup fee was dropped before the commit is refused: it would convert with the live fee.
    expect(await commitGuardFor(home(daysAgo(3)), shown, 'est-1', deps, discounted)(trxFor(draftAt('627.00', {})))).toBe(false);
    // Terms equal to the shown price need no hold.
    expect(await commitGuardFor(home(null), shown, 'est-1', deps)(trxFor(draftAt('627.00'), lockedRow(null)))).toBe(true);
  });
});
