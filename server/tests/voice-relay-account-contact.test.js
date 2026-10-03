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
    // Stand-in for booking's own matcher (covered by its own suites): same
    // street once "Street"/"St" are folded, and no ZIP disagreement.
    addressMatchesCustomer: (customer, address, zip) => {
      const norm = (v) => String(v || '').toLowerCase().replace(/\bstreet\b/g, 'st').replace(/[^a-z0-9]/g, '');
      return norm(customer.address_line1) === norm(address) && (!zip || !customer.zip || String(zip) === String(customer.zip));
    },
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
jest.mock('../services/scheduling/parse-when', () => ({ parseWhen: jest.fn(), summarizeWindow: jest.fn() }));

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

describe('the exception lives at system priority, only when the caller-context lane is on', () => {
  test('context on: the intake exception is in the system prompt (so a late-arriving caller block is covered); context off: untouched', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    expect(buildBasePrompt(true)).toMatch(/is the exception to gathering a name, address and\s+email/);
    expect(buildBasePrompt(true)).toMatch(/start of the call or partway through/);
    // Open times need no address from a known customer; a written estimate still confirms its details.
    expect(buildBasePrompt(true)).toMatch(/Open times for such a customer need no address/);
    expect(buildBasePrompt(true)).toMatch(/pass an address only when they say the visit is for a different property/);
    expect(buildBasePrompt(true)).toMatch(/written estimate does need the full name, email and service address/);
    expect(buildBasePrompt(false)).not.toMatch(/KNOWN CALLER/);
  });
});
