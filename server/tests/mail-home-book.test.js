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

const { verifyEstimateHandoffToken } = require('../utils/estimate-handoff-token');
const realQuote = require('../services/mail/home-quote');
const { getHomeTimes, bookHome, draftIdFor, validContact, validOffer, offersOf } = require('../services/mail/home-book');

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

const INPUT = () => ({ offer: offer('2026-12-02', '09:00'), name: 'Sample Person', phone: '(941) 555-0142', email: 'Sample@Example.com' });

let gates;
let booking;
let quote;
let saveEstimate;
let updates;
let deps;

beforeEach(() => {
  mockRow = row();
  gates = { isEnabled: jest.fn(() => true) };
  booking = {
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
    q.update = jest.fn(async (set) => { updates.push(set); return 1; });
    return q;
  });
  deps = {
    gates, booking, quote, saveEstimate, db: conn, buildEngineInput: jest.fn(() => ({ engine: 'input' })),
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

  test('/book off is not_available', async () => {
    gates.isEnabled.mockImplementation((name) => name !== 'selfBooking');
    expect(await bookHome(TOKEN, INPUT(), deps)).toEqual({ status: 503, body: { error: 'not_available' } });
    expect(saveEstimate).not.toHaveBeenCalled();
  });

  test('saves the estimate (not a dry run) from the stored facts plus the contact, then books through createSelfBooking with a valid handoff token', async () => {
    const res = await bookHome(TOKEN, INPUT(), deps);
    expect(res).toEqual({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '10:00' } } });

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
      clientDraftId: draftIdFor('prospect-1', validContact(INPUT())),
      billByInvoice: false,
      showOneTimeOption: false,
    });
    expect(body.customerId).toBeUndefined();
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
      payAtVisit: true, customersOnly: true, authedCustomer: null, callbackVisit: null,
      new_customer: {
        first_name: 'Sample', last_name: 'Person', phone: '9415550142', email: 'sample@example.com',
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
    // Rounding (under $0.50 a year) is not a change.
    quote.priceHome.mockResolvedValue({ status: 'priced', priceAnnual: 627.4, priceSetupFee: 0, priceDigest: 'd' });
    expect((await bookHome(TOKEN, INPUT(), deps)).status).toBe(200);
    saveEstimate.mockClear();
    booking.createSelfBooking.mockClear();
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
