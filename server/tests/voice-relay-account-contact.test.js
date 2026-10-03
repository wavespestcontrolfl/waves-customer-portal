// Sandy P1: a known customer is not asked again for what is on their account,
// and their open times are for the property on that account (owner rulings
// 2026-10-03). The location comes from the SAME resolver request_booking
// commits at; a different property gets no times and goes to a person.

jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/voice-agent/relay-booking', () => ({
  ...jest.requireActual('../services/voice-agent/relay-booking'),
  resolveAccountBookingLocation: jest.fn(),
}));
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn(),
    resolveBookingCoords: jest.fn(),
    buildBookingAvailability: jest.fn(),
    // Booking's REAL matcher semantics, rebuilt from the same normalizer
    // (requiring the whole route file here would load the booking router):
    // same street once units are peeled and the line is normalized, and no
    // ZIP disagreement. Like the real one, a submitted unit matches a
    // unitless record.
    addressMatchesCustomer: (customer, address, zip) => {
      const { splitStreetLineUnit } = jest.requireActual('../utils/address-normalizer');
      const norm = (v) => splitStreetLineUnit(String(v || '')).street.toLowerCase().replace(/\bstreet\b/g, 'st').replace(/[^a-z0-9]/g, '');
      return norm(customer.address_line1) === norm(address) && (!zip || !customer.zip || String(zip) === String(customer.zip));
    },
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
jest.mock('../services/scheduling/parse-when', () => ({ parseWhen: jest.fn(), summarizeWindow: jest.fn() }));
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(),
  surfaceEstimateRequestForCustomer: jest.fn(async () => ({ persisted: true, suppressed: false })),
  isLeadStage: jest.requireActual('../services/lead-from-extraction').isLeadStage,
  nameConflicts: jest.requireActual('../services/lead-from-extraction').nameConflicts,
}));

const db = require('../models/db');
const { executeTool } = require('../services/voice-agent/relay-tools');
const { isEnabled } = require('../config/feature-gates');
const booking = require('../routes/booking')._internals;
const { resolveAccountBookingLocation } = require('../services/voice-agent/relay-booking');
const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');

const ACCOUNT = { id: 'c-1', address_line1: '12 Test Street', city: 'Bradenton', state: 'FL', zip: '34205', latitude: 27.49, longitude: -82.57 };
const ACCOUNT_PIN = { lat: 27.4912, lng: -82.5712 }; // the property's own pin, not a fresh geocode
const SLOTS = [{ date: '2026-07-01', start_time: '09:00', start_label: '9:00 AM' }, { date: '2026-07-01', start_time: '13:00', start_label: '1:00 PM' }];
const fullTier = (over = {}) => ({ from: '+19415550131', callSid: 'CA-acct-1', callerVerified: true, customerId: 'c-1', customerTier: 'full', ...over });

let customerReads;
let customerFilter;
beforeEach(() => {
  jest.clearAllMocks();
  customerReads = 0;
  customerFilter = null;
  db.mockImplementation(() => ({
    where: (w) => ({ whereNull: (col) => { customerFilter = { ...w, [col]: null }; return { first: async () => { customerReads += 1; return ACCOUNT; } }; } }),
  }));
  resolveAccountBookingLocation.mockResolvedValue({ status: 'ok', coords: ACCOUNT_PIN, propertyLinkage: { propertyId: 'p-1' } });
  isEnabled.mockReturnValue(true);
  booking.loadBookingConfig.mockResolvedValue({ advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00' });
  booking.resolveBookingCoords.mockResolvedValue({ lat: 27.1, lng: -82.4 });
  booking.buildBookingAvailability.mockResolvedValue({ slots: SLOTS, days: [{ slots: SLOTS }], nearby: true, total_feasible: 2 });
  parseWhen.mockReturnValue({ startDate: '2026-07-01', endDate: '2026-07-07' });
  summarizeWindow.mockReturnValue('Next week');
});

const builtAt = () => { const a = booking.buildBookingAvailability.mock.calls[0][0]; return { lat: a.lat, lng: a.lng }; };

describe('a known customer\'s open times are for the property on their account', () => {
  test.each(['get_availability', 'find_slots'])('%s with no address → built at the account\'s own pin, stamped as an account offer, never recited', async (name) => {
    const rememberSlot = jest.fn(() => 'S1');
    const out = await executeTool(name, name === 'find_slots' ? { when: 'next week' } : {}, fullTier({ rememberSlot }));
    expect(customerFilter).toEqual({ id: 'c-1', deleted_at: null });
    expect(resolveAccountBookingLocation).toHaveBeenCalledWith(db, ACCOUNT); // the resolver request_booking commits at
    expect(booking.resolveBookingCoords).not.toHaveBeenCalled(); // no second, address-only geocode
    expect(builtAt()).toEqual(ACCOUNT_PIN);
    expect(rememberSlot.mock.calls[0][1]).toMatchObject({ ...ACCOUNT_PIN, accountCustomerId: 'c-1' });
    expect(out).toMatch(/Open times/);
    expect(out).toMatch(/These times are for the service address on the caller's account/);
    expect(out).not.toMatch(/12 Test Street|34205/);
  });

  test.each([
    [{ address_line1: '12 Test St', zip: '34205' }],
    [{ address_line1: '12 test street', city: 'bradenton' }],
    [{ address_line1: '12 Test Street' }],
  ])('the caller restating their own address %j is still the account\'s property', async (stated) => {
    const out = await executeTool('find_slots', { when: 'next week', ...stated }, fullTier());
    expect(builtAt()).toEqual(ACCOUNT_PIN);
    expect(out).toMatch(/on the caller's account/);
  });

  test.each([
    [{ address_line1: '9 Rental Road', city: 'Venice', zip: '34285' }],
    [{ address_line1: '9 Rental Road', city: 'Bradenton', zip: '34205' }],
    [{ address_line1: '12 Test Street Apt B' }], // a unit the account does not hold is another premise
    [{ address_line1: '12 Test Street #4', zip: '34205' }],
    [{ address_line1: '12 Test Street Space 4' }],
    [{ address_line1: '12 Test Street Floor 2' }],
    [{ address_line1: '12 Test Street', city: 'Venice' }],
    [{ city: 'Venice' }],
    [{ zip: '34285' }],
  ])('a DIFFERENT property %j gets no times: the request goes to a person (owner ruling 2026-10-03)', async (stated) => {
    for (const name of ['get_availability', 'find_slots']) {
      const out = await executeTool(name, { when: 'next week', ...stated }, fullTier());
      expect(out).toMatch(/not the service address on this caller's account, so do NOT offer any times/);
      expect(out).toMatch(/capture_lead[\s\S]*a Waves team member will call you back to confirm/);
    }
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    expect(booking.resolveBookingCoords).not.toHaveBeenCalled();
  });

  test.each([[{ city: 'Bradenton' }], [{ zip: '34205-1234' }], [{ city: 'bradenton', zip: '34205' }]])('the account\'s own city or ZIP alone %j does not say WHICH property: no times, and the agent is told how to say which', async (stated) => {
    const rememberSlot = jest.fn();
    const out = await executeTool('find_slots', { when: 'next week', ...stated }, fullTier({ rememberSlot }));
    expect(out).toMatch(/does not say which property[\s\S]*call this tool again with NO address[\s\S]*that property's street address/);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    expect(rememberSlot).not.toHaveBeenCalled(); // a rental in the same town never gets an account-stamped offer
  });

  test('naming a different property revokes times already offered for the account\'s: the old slot_ref no longer books', async () => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const ctx = new RelayConversation({ send: jest.fn() })._buildToolCtx();
    const ref = ctx.rememberSlot(SLOTS[0], { ...ACCOUNT_PIN, duration: 60, accountCustomerId: 'c-1' });
    const stated = ctx.rememberSlot(SLOTS[1], { lat: 27.1, lng: -82.4, duration: 60 });
    expect(ctx.resolveSlotRef(ref).accountCustomerId).toBe('c-1');
    const out = await executeTool('find_slots', { when: 'next week', address_line1: '9 Rental Road', city: 'Venice' }, fullTier({ revokeAccountSlots: ctx.revokeAccountSlots }));
    expect(out).toMatch(/do NOT offer any times and do\s+NOT place a booking request/);
    expect(out).toMatch(/will call you back to confirm a time/); // wording the close records as an owed callback
    expect(ctx.resolveSlotRef(ref)).toMatchObject({ date: SLOTS[0].date, lat: ACCOUNT_PIN.lat });
    expect(ctx.resolveSlotRef(ref).accountCustomerId).toBeUndefined(); // request_booking's fence refuses it
    expect(ctx.resolveSlotRef(stated)).toBeTruthy();
  });

  test('an address the lookup could not check against the account (a failed read) also revokes earlier account offers', async () => {
    const revokeAccountSlots = jest.fn();
    db.mockImplementation(() => ({ where: () => ({ whereNull: () => ({ first: async () => { throw new Error('db down'); } }) }) }));
    const out = await executeTool('find_slots', { when: 'next week', address_line1: '9 Rental Road', city: 'Venice' }, fullTier({ revokeAccountSlots }));
    expect(out).toMatch(/Open times/); // the ordinary path, for the stated address
    expect(revokeAccountSlots).toHaveBeenCalledTimes(1);
    // No address stated: nothing says the visit moved, so nothing is revoked.
    await executeTool('find_slots', { when: 'next week' }, fullTier({ revokeAccountSlots }));
    expect(revokeAccountSlots).toHaveBeenCalledTimes(1);
  });

  test('find_slots with another property but NO timeframe still refuses and revokes, before asking for the day', async () => {
    const revokeAccountSlots = jest.fn();
    const out = await executeTool('find_slots', { address_line1: '9 Rental Road', city: 'Venice' }, fullTier({ revokeAccountSlots }));
    expect(out).toMatch(/not the service address on this caller's account/);
    expect(revokeAccountSlots).toHaveBeenCalledTimes(1);
    expect(await executeTool('find_slots', {}, fullTier())).toMatch(/Ask the caller what day or timeframe/);
  });

  test('the scheduling kill switch answers before any account read', async () => {
    isEnabled.mockReturnValue(false);
    expect(await executeTool('find_slots', { when: 'next week' }, fullTier())).toMatch(/Live scheduling is not available/);
    expect(customerReads).toBe(0);
    expect(resolveAccountBookingLocation).not.toHaveBeenCalled();
  });

  test('the tool descriptions carry the known-customer exception the prompt states', () => {
    const { TOOLS } = require('../services/voice-agent/relay-tools');
    for (const name of ['get_availability', 'find_slots']) {
      expect(TOOLS.find((t) => t.name === name).description).toMatch(/already a customer: call\s+it with NO address and\s+it uses the property on their account/);
    }
  });

  test.each(['count_failed', 'multi_property', 'unresolved_property', 'no_location'])('an account whose property a person must sort out (%s) keeps the ordinary path, and its offers are not account offers', async (status) => {
    resolveAccountBookingLocation.mockResolvedValue({ status });
    booking.resolveBookingCoords.mockResolvedValueOnce({});
    expect(await executeTool('find_slots', { when: 'next week' }, fullTier())).toMatch(/Ask the caller for their street address or ZIP/);
    const rememberSlot = jest.fn(() => 'S1');
    const out = await executeTool('find_slots', { when: 'next week', city: 'Venice' }, fullTier({ rememberSlot }));
    expect(booking.resolveBookingCoords).toHaveBeenLastCalledWith({ address: null, city: 'Venice' });
    expect(rememberSlot.mock.calls[0][1].accountCustomerId).toBeNull();
    expect(out).not.toMatch(/on the caller's account/);
  });

  test.each([
    ['a recognised-only caller', { customerTier: 'redacted' }],
    ['an unverified match', { callerVerified: false }],
    ['an unmatched caller', { customerId: null }],
  ])('%s never reads the account: the stated location is used as before', async (_label, over) => {
    const out = await executeTool('find_slots', { when: 'next week', city: 'Venice' }, fullTier(over));
    expect(customerReads).toBe(0);
    expect(resolveAccountBookingLocation).not.toHaveBeenCalled();
    expect(booking.resolveBookingCoords).toHaveBeenCalledWith({ address: null, city: 'Venice' });
    expect(out).toMatch(/Open times/);
    expect(out).not.toMatch(/on the caller's account/);
  });

  test('a failed account read, or a deleted account, falls back to the ordinary path', async () => {
    db.mockImplementation(() => ({ where: () => ({ whereNull: () => ({ first: async () => { throw new Error('db down'); } }) }) }));
    await executeTool('find_slots', { when: 'next week', city: 'Venice' }, fullTier());
    expect(booking.resolveBookingCoords).toHaveBeenLastCalledWith({ address: null, city: 'Venice' });
    db.mockImplementation(() => ({ where: () => ({ whereNull: () => ({ first: async () => undefined }) }) }));
    await executeTool('find_slots', { when: 'next week', city: 'Venice' }, fullTier());
    expect(resolveAccountBookingLocation).not.toHaveBeenCalled();
  });
});

describe('a written estimate for an established customer: ONE yes/no question (owner ruling 2026-10-03)', () => {
  const { createLeadFromExtraction, surfaceEstimateRequestForCustomer } = require('../services/lead-from-extraction');
  const HOLDER = { first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205', pipeline_stage: 'active_customer' };
  let holder;
  let properties;
  const estimateCtx = (over = {}) => fullTier({ markCaptured: jest.fn(), ...over });
  const ask = (input = {}, ctx = estimateCtx()) => executeTool('capture_lead', { call_summary: 'Wants a written estimate for lawn care.', estimate_requested: true, ...input }, ctx);
  beforeEach(() => {
    holder = { ...HOLDER };
    properties = 1;
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    db.mockImplementation((table) => (table === 'customer_properties'
      ? { where: () => ({ count: () => ({ first: async () => ({ count: String(properties) }) }) }) }
      : { where: () => ({ whereNull: () => ({ first: async () => { customerReads += 1; return holder; } }) }) }));
  });

  test('without the yes nothing is taken from the account: the details are missing, and the result offers the one question', async () => {
    const out = await ask();
    expect(out).toMatch(/still missing: first_name, last_name, email, address_line1/);
    expect(out).toMatch(/ask ONE question — "Should it go to the email and service address on your account\?"/);
    expect(out).toMatch(/use_account_details: true/);
    expect(out).not.toMatch(/dana@example\.com|12 Test Street/); // never recited
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ email: null, address_line1: null });
  });

  test('after a yes the account\'s name, email and address complete the request, and the card says they were confirmed', async () => {
    const noteEstimateFields = jest.fn();
    const out = await ask({ use_account_details: true }, estimateCtx({ noteEstimateFields }));
    expect(out).toMatch(/IS on the office queue/);
    const [customerId, details, opts] = surfaceEstimateRequestForCustomer.mock.calls[0];
    expect(customerId).toBe('c-1');
    expect(details).toMatchObject({ first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' });
    expect(opts.accountDetailsConfirmed).toEqual(['name', 'email', 'address']);
    // Confirmed details are remembered and written like stated ones.
    expect(noteEstimateFields).toHaveBeenCalledWith(expect.objectContaining({ email: 'dana@example.com', address_line1: '12 Test Street' }));
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ email: 'dana@example.com', address_line1: '12 Test Street' });
  });

  test('what the caller said on the call wins: only what they did not give comes from the account, and a location is never mixed', async () => {
    await ask({ use_account_details: true, email: 'other@example.com', city: 'Venice' });
    const out = await ask({ use_account_details: true, email: 'other@example.com', city: 'Venice' });
    expect(out).toMatch(/still missing: address_line1/); // a stated city is that property: the account's street does not complete it
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ first_name: 'Dana', email: 'other@example.com', city: 'Venice', address_line1: null });
  });

  // The call's real store (relay-conversation): adds non-empty fields, drops on request.
  const callStore = () => {
    let bag = {};
    return {
      bag: () => bag,
      getEstimateFields: () => ({ ...bag }),
      noteEstimateFields: (f) => { bag = { ...bag, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && String(v).trim() !== '')) }; },
      clearEstimateFields: (keys) => { for (const k of keys) delete bag[k]; },
    };
  };

  test('a request completed over two captures keeps saying which details were the account\'s', async () => {
    holder.email = null; // the account has no email: the yes fills the name and address only
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: email/);
    expect(await ask({ email: 'dana@work.example.com' }, ctx)).toMatch(/IS on the office queue/);
    const [, details, opts] = surfaceEstimateRequestForCustomer.mock.calls[0];
    expect(details).toMatchObject({ email: 'dana@work.example.com', address_line1: '12 Test Street' });
    expect(opts.accountDetailsConfirmed).toEqual(['name', 'address']); // the address is still the account's, the email is theirs
  });

  test('a detail the caller replaces after the yes drops the account\'s copy: a new city never keeps the account\'s street, a new email never keeps the account\'s', async () => {
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/IS on the office queue/);
    surfaceEstimateRequestForCustomer.mockClear();
    const moved = await ask({ city: 'Venice' }, ctx);
    expect(moved).toMatch(/still missing: address_line1/);
    expect(store.bag()).toMatchObject({ city: 'Venice', email: 'dana@example.com', details_from_account: 'name,email' });
    expect(store.bag().address_line1).toBeUndefined();
    const garbled = await ask({ email: 'dana at work dot' }, ctx);
    expect(garbled).toMatch(/still missing: email, address_line1/); // the account's email does not stand in
    expect(store.bag().email).toBeUndefined();
    expect(store.bag().details_from_account).toBe('name');
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test('the account has no last name: the caller adding it keeps the confirmed first name and completes the request', async () => {
    holder.last_name = null;
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: last_name/);
    expect(await ask({ last_name: 'Sample' }, ctx)).toMatch(/IS on the office queue/);
    const [, details, opts] = surfaceEstimateRequestForCustomer.mock.calls[0];
    expect(details).toMatchObject({ first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street' });
    expect(opts.accountDetailsConfirmed).toEqual(['name', 'email', 'address']);
  });

  test('a different person\'s name given after the yes takes back every detail kept from the account', async () => {
    holder.last_name = null; // the yes leaves the last name missing, so the call goes on
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: last_name/);
    expect(store.bag()).toMatchObject({ email: 'dana@example.com', address_line1: '12 Test Street' });
    const out = await ask({ first_name: 'Robin', last_name: 'Other' }, ctx);
    expect(out).toMatch(/still missing: email, address_line1/);
    expect(out).not.toMatch(/ONE question/);
    expect(store.bag()).toMatchObject({ first_name: 'Robin', last_name: 'Other', details_from_account: 'none' });
    expect(store.bag().email).toBeUndefined();
    expect(store.bag().address_line1).toBeUndefined();
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test('an unreadable email given on the capture is not replaced by the account\'s', async () => {
    const out = await ask({ use_account_details: true, email: 'dana at work dot' });
    expect(out).toMatch(/still missing: email/);
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test.each([
    ['a customer still in the lead pipeline', () => { holder.pipeline_stage = 'estimate_sent'; }, {}],
    ['a different person on the account\'s line', () => {}, { first_name: 'Robin' }],
    ['an account with more than one property', () => { properties = 2; }, {}],
    ['a deleted account', () => { holder = undefined; }, {}],
  ])('%s gets the ordinary intake: the flag is ignored and the question is not offered', async (_label, arrange, input) => {
    arrange();
    const out = await ask({ use_account_details: true, ...input });
    expect(out).toMatch(/still missing: /);
    expect(out).toMatch(/email, address_line1/);
    expect(out).not.toMatch(/ONE question/);
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test.each([
    ['a recognised-only caller', { customerTier: 'redacted' }],
    ['an unverified match', { callerVerified: false }],
  ])('%s never has the account read for an estimate', async (_label, over) => {
    jest.spyOn(require('../services/voice-agent/relay-alert'), 'alertOfficeContactFollowUp').mockResolvedValue(true);
    customerReads = 0;
    await ask({ use_account_details: true }, estimateCtx(over));
    expect(customerReads).toBe(0);
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test('use_account_details is a capture_lead input only while the caller-context lane is on', () => {
    const { activeTools, TOOLS } = require('../services/voice-agent/relay-tools');
    const props = (tools) => Object.keys(tools.find((t) => t.name === 'capture_lead').input_schema.properties);
    const saved = process.env.VOICE_RELAY_CONTEXT_ENABLED;
    try {
      process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
      expect(props(activeTools())).toContain('use_account_details');
      delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
      expect(props(activeTools())).not.toContain('use_account_details');
      expect(props(TOOLS)).not.toContain('use_account_details');
    } finally {
      if (saved === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED; else process.env.VOICE_RELAY_CONTEXT_ENABLED = saved;
    }
  });

  test('a capture that is already complete, or is not an estimate, never reads the account', async () => {
    customerReads = 0;
    await ask({ first_name: 'Dana', last_name: 'Sample', email: 'd@example.com', address_line1: '1 A St' });
    await executeTool('capture_lead', { call_summary: 'Just a note.', use_account_details: true }, estimateCtx());
    expect(customerReads).toBe(0);
  });
});

describe('the exception lives at system priority, only when the caller-context lane is on', () => {
  test('context on: the intake exception is in the system prompt (so a late-arriving caller block is covered); context off: untouched', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    expect(buildBasePrompt(true)).toMatch(/is the exception to gathering a name, address and\s+email/);
    expect(buildBasePrompt(true)).toMatch(/start of the call or partway through/);
    // Open times need no address from a known customer; a written estimate still confirms its details.
    expect(buildBasePrompt(true)).toMatch(/Open times for such a customer need no address/);
    expect(buildBasePrompt(true)).toMatch(/pass an address only when they say the visit is for a different property/);
    expect(buildBasePrompt(true)).toMatch(/written estimate ask ONE question: "Should it go to the email and service address on your\s+account\?"/);
    expect(buildBasePrompt(true)).toMatch(/use_account_details both\s+true/);
    expect(buildBasePrompt(false)).not.toMatch(/KNOWN CALLER/);
  });
});
