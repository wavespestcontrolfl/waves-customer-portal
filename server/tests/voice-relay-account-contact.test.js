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
  const HOME = { address_line1: '12 Test Street', city: 'Bradenton', zip: '34205', active: true };
  let holder;
  let properties; // the account's customer_properties rows
  let siblingProfile; // another live customer profile on the same account
  // A card FILED (or rewritten) as deliverable. An incomplete capture also
  // calls the writer, revise-only (stillMissing), which files nothing new.
  const filedCards = () => surfaceEstimateRequestForCustomer.mock.calls.filter((c) => !((c[2] || {}).stillMissing || []).length);
  // The call's real store (relay-conversation): it only ADDS non-empty fields.
  // `offered`: the tool already offered the question on an earlier capture,
  // so a yes on the next one is an answer to it.
  const callStore = ({ offered = true } = {}) => {
    let bag = offered ? { account_question_offered: 'true' } : {};
    return {
      bag: () => bag,
      getEstimateFields: () => ({ ...bag }),
      noteEstimateFields: (f) => { bag = { ...bag, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && String(v).trim() !== '')) }; },
    };
  };
  const estimateCtx = (over = {}) => fullTier({ markCaptured: jest.fn(), ...callStore(), ...over });
  let savedGate;
  beforeEach(() => { savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED; process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });
  afterEach(() => { if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED; else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate; });
  const ask = (input = {}, ctx = estimateCtx()) => executeTool('capture_lead', { call_summary: 'Wants a written estimate for lawn care.', estimate_requested: true, ...input }, ctx);
  beforeEach(() => {
    holder = { ...HOLDER };
    properties = [{ ...HOME }];
    siblingProfile = undefined;
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    // customers: `.where({id})` reads the caller's own row; `.where(fn)` is the sibling-profile probe.
    const siblingProbe = { whereNot: () => siblingProbe, whereNull: () => siblingProbe, andWhere: () => siblingProbe, first: async () => siblingProfile };
    db.mockImplementation((table) => (table === 'customer_properties'
      ? { where: () => ({ select: async () => properties }) }
      : { where: (w) => (typeof w === 'function' ? siblingProbe : { whereNull: () => ({ first: async () => { customerReads += 1; return holder; } }) }) }));
  });

  test('without the yes nothing is taken from the account: the details are missing, and the result offers the one question', async () => {
    const out = await ask({}, estimateCtx(callStore({ offered: false })));
    expect(out).toMatch(/still missing: first_name, last_name, email, address_line1/);
    expect(out).toMatch(/ask ONE question — "Should it go to the email and service address on your account\?"/);
    expect(out).toMatch(/use_account_details: true/);
    expect(out).not.toMatch(/dana@example\.com|12 Test Street/); // never recited
    expect(filedCards()).toEqual([]);
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ email: null, address_line1: null });
  });

  test('after a yes the account\'s name, email and address complete the request, the card says they were confirmed, and the call stores only the yes', async () => {
    const store = callStore();
    const out = await ask({ use_account_details: true }, estimateCtx(store));
    expect(out).toMatch(/IS on the office queue/);
    const [customerId, details, opts] = filedCards()[0];
    expect(customerId).toBe('c-1');
    expect(details).toMatchObject({ first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' });
    expect(opts.accountDetailsConfirmed).toEqual(['name', 'email', 'address']);
    // Nothing of the account's is remembered as something the caller said.
    expect(store.bag()).toEqual({ account_question_offered: 'true', account_details_confirmed: 'true' });
  });

  test('the yes carries to later captures on the call without the flag being passed again', async () => {
    holder.email = null; // the account has no email: the yes fills the name and address only
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: email/);
    expect(await ask({ email: 'dana@work.example.com' }, ctx)).toMatch(/IS on the office queue/);
    const [, details, opts] = filedCards()[0];
    expect(details).toMatchObject({ email: 'dana@work.example.com', address_line1: '12 Test Street' });
    expect(opts.accountDetailsConfirmed).toEqual(['name', 'address']); // the address is the account's, the email is theirs
  });

  test('what the caller says wins, on that capture and every later one: a new city never gets the account\'s street, a named email never becomes the account\'s', async () => {
    const store = callStore();
    const ctx = estimateCtx(store);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/IS on the office queue/);
    surfaceEstimateRequestForCustomer.mockClear();
    expect(await ask({ city: 'Venice' }, ctx)).toMatch(/still missing: address_line1/);
    expect(await ask({ email: 'dana at work dot' }, ctx)).toMatch(/still missing: email, address_line1/);
    expect(await ask({}, ctx)).toMatch(/still missing: email, address_line1/); // neither comes back
    expect(filedCards()).toEqual([]);
    expect(store.bag()).toEqual({ city: 'Venice', account_question_offered: 'true', account_details_confirmed: 'true', email_unreadable: 'true' });
    // The same after a reconnect, which restores the call's fields by merging them: there is nothing to un-delete.
    const resumed = callStore();
    resumed.noteEstimateFields(store.bag());
    expect(await ask({}, estimateCtx(resumed))).toMatch(/still missing: email, address_line1/);
  });

  test('the account has no last name: the caller adding it completes the request', async () => {
    holder.last_name = null;
    const ctx = estimateCtx(callStore());
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: last_name/);
    expect(await ask({ last_name: 'Sample' }, ctx)).toMatch(/IS on the office queue/);
    expect(filedCards()[0][1]).toMatchObject({ first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street' });
  });

  test('a different person\'s name given after the yes gets none of the account\'s details', async () => {
    holder.last_name = null;
    const ctx = estimateCtx(callStore());
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/still missing: last_name/);
    const out = await ask({ first_name: 'Robin', last_name: 'Other' }, ctx);
    expect(out).toMatch(/still missing: email, address_line1/);
    expect(out).not.toMatch(/ONE question/);
    expect(filedCards()).toEqual([]);
  });

  test('the address is the account\'s one ACTIVE property, read directly — not the customers-row mirror of a retired primary', async () => {
    properties = [{ ...HOME, active: false }, { address_line1: '40 Active Ave', city: 'Parrish', zip: '34219', active: true }];
    expect(await ask({ use_account_details: true })).toMatch(/IS on the office queue/);
    expect(filedCards()[0][1]).toMatchObject({ address_line1: '40 Active Ave', city: 'Parrish', zip: '34219' });
  });

  test('a legacy account with no property rows at all uses the address on the customer record', async () => {
    properties = [];
    expect(await ask({ use_account_details: true })).toMatch(/IS on the office queue/);
    expect(filedCards()[0][1]).toMatchObject({ address_line1: '12 Test Street' });
  });

  test.each([
    ['a customer still in the lead pipeline', () => { holder.pipeline_stage = 'estimate_sent'; }, {}],
    ['a different person on the account\'s line', () => {}, { first_name: 'Robin' }],
    ['an account with more than one active property', () => { properties = [{ ...HOME }, { ...HOME, address_line1: '9 Rental Rd' }]; }, {}],
    ['an account whose properties are all retired', () => { properties = [{ ...HOME, active: false }]; }, {}],
    ['an account that holds another property as a sibling customer profile', () => { siblingProfile = { id: 'c-2' }; }, {}],
    ['a deleted account', () => { holder = undefined; }, {}],
  ])('%s gets the ordinary intake: the flag is ignored and the question is not offered', async (_label, arrange, input) => {
    arrange();
    const out = await ask({ use_account_details: true, ...input });
    expect(out).toMatch(/still missing: /);
    expect(out).toMatch(/email, address_line1/);
    expect(out).not.toMatch(/ONE question/);
    expect(filedCards()).toEqual([]);
  });

  test.each([
    ['a recognised-only caller', { customerTier: 'redacted' }],
    ['an unverified match', { callerVerified: false }],
  ])('%s never has the account read for an estimate', async (_label, over) => {
    jest.spyOn(require('../services/voice-agent/relay-alert'), 'alertOfficeContactFollowUp').mockResolvedValue(true);
    customerReads = 0;
    await ask({ use_account_details: true }, estimateCtx(over));
    expect(customerReads).toBe(0);
    expect(filedCards()).toEqual([]);
  });

  test('a capture that failed never showed the offer, so its retry still makes it', async () => {
    const ctx = estimateCtx(callStore({ offered: false }));
    createLeadFromExtraction.mockRejectedValueOnce(new Error('db down'));
    const failed = await ask({}, ctx);
    expect(failed).not.toMatch(/ONE question/);
    expect(await ask({}, ctx)).toMatch(/ONE question/);
  });

  test('ONE question means asked once: after the offer, a caller giving their own details is not asked again', async () => {
    const ctx = estimateCtx(callStore({ offered: false }));
    expect(await ask({}, ctx)).toMatch(/ONE question/);
    const next = await ask({ email: 'own@example.com' }, ctx); // they said no and gave their own email
    expect(next).toMatch(/still missing: first_name, last_name, address_line1/);
    expect(next).not.toMatch(/ONE question/);
    // A yes that comes later is still honoured.
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/IS on the office queue/);
    expect(filedCards()[0][1]).toMatchObject({ email: 'own@example.com', address_line1: '12 Test Street' });
  });

  test('a correction after the card is queued rewrites the card, keeps the promise and its timing, and is fenced to the session', async () => {
    const promises = new Map();
    const notePromise = jest.fn((k, verdict, extra) => promises.set(k, { verdict, expectation: extra && extra.expectation }));
    const ctx = estimateCtx({ ...callStore(), sessionKey: 'sk-1', notePromise, getPromise: (k) => promises.get(k) || null, officeOpenNow: () => true });
    const saved = process.env.VOICE_RELAY_CONTEXT_ENABLED;
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    try {
      expect(await ask({ use_account_details: true }, ctx)).toMatch(/usually goes out in about 15 minutes/);
      expect(notePromise).toHaveBeenLastCalledWith('send_estimate', true, { expectation: 'about_15_minutes' });
      // The office has closed by the time the caller corrects the address.
      ctx.officeOpenNow = () => false;
      // Incomplete correction: the standing card is revised and the caller is NOT told the estimate was dropped.
      const incomplete = await ask({ city: 'Venice' }, ctx);
      expect(incomplete).toMatch(/still missing: address_line1/);
      expect(incomplete).toMatch(/stays on the office queue[\s\S]*will call you back to confirm where to send it/);
      expect(incomplete).not.toMatch(/the estimate is dropped/);
      const revise = surfaceEstimateRequestForCustomer.mock.calls.at(-1);
      expect(revise[1]).toMatchObject({ city: 'Venice', address_line1: null });
      expect(revise[2]).toMatchObject({ stillMissing: ['address_line1'], sessionKey: 'sk-1', callSid: 'CA-acct-1', spokenExpectation: 'about_15_minutes' });
      // Declining is a capture WITHOUT the flag: it releases the keep-open hold and withdraws nothing.
      expect(incomplete).toMatch(/call capture_lead again WITHOUT estimate_requested[\s\S]*the estimate already promised stays owed/);
      expect(ctx.markCaptured).toHaveBeenLastCalledWith(expect.objectContaining({ holdOpen: true }));
      const writes = surfaceEstimateRequestForCustomer.mock.calls.length;
      await executeTool('capture_lead', { call_summary: 'Declined to give the new street.' }, ctx);
      expect(ctx.markCaptured).toHaveBeenLastCalledWith(expect.objectContaining({ holdOpen: false })); // the call can end
      expect(surfaceEstimateRequestForCustomer.mock.calls.length).toBe(writes); // the card is left as revised
      expect(notePromise).toHaveBeenCalledTimes(1); // the promise still stands
      // If that card write fails, the result does not claim the office saw the change.
      surfaceEstimateRequestForCustomer.mockResolvedValueOnce({ persisted: false, suppressed: false });
      const unsaved = await ask({ city: 'Venice' }, ctx);
      expect(unsaved).toMatch(/still owed, but this change could NOT be\s+saved to the office queue/);
      expect(unsaved).not.toMatch(/marked that these/);
      expect(unsaved).toMatch(/will call you back to\s+confirm where to send it/);
      // Completed correction: the card is rewritten with the new address, same promise, same timing.
      expect(await ask({ address_line1: '9 Rental Rd', city: 'Venice' }, ctx)).toMatch(/usually goes out in about 15 minutes/);
      const rewrite = surfaceEstimateRequestForCustomer.mock.calls.at(-1);
      expect(rewrite[1]).toMatchObject({ address_line1: '9 Rental Rd', city: 'Venice', email: 'dana@example.com' });
      expect(rewrite[2]).toMatchObject({ sessionKey: 'sk-1', spokenExpectation: 'about_15_minutes', accountDetailsConfirmed: ['name', 'email'] });
      expect(notePromise).toHaveBeenCalledTimes(1); // never overwritten, never re-timed
    } finally {
      if (saved === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED; else process.env.VOICE_RELAY_CONTEXT_ENABLED = saved;
    }
  });

  test('the callback number the caller chose stays on the card when a later capture omits it', async () => {
    const ctx = estimateCtx(callStore());
    await ask({ use_account_details: true, callback_phone: '941-555-0177' }, ctx);
    expect(filedCards()[0][2].phone).toBe('+19415550177');
    await ask({ email: 'new@example.com' }, ctx); // a correction, no number repeated
    expect(filedCards()[1][1]).toMatchObject({ email: 'new@example.com' });
    expect(filedCards()[1][2].phone).toBe('+19415550177'); // not the inbound number
    await ask({ callback_phone: '941-555-0188' }, ctx);
    expect(filedCards()[2][2].phone).toBe('+19415550188');
  });

  test('a yes counts only as the answer to a question the tool offered: the flag on a first capture confirms nothing', async () => {
    const ctx = estimateCtx(callStore({ offered: false }));
    const eager = await ask({ use_account_details: true }, ctx);
    expect(eager).toMatch(/still missing: first_name, last_name, email, address_line1/);
    expect(eager).toMatch(/ONE question/); // the offer is made now
    expect(filedCards()).toEqual([]);
    expect(await ask({ use_account_details: true }, ctx)).toMatch(/IS on the office queue/); // the yes to it
  });

  test('the question is offered only when the account would supply the email or the address, not for a name alone', async () => {
    const ctx = estimateCtx(callStore({ offered: false }));
    const out = await ask({ email: 'own@example.com', address_line1: '9 Rental Rd', city: 'Venice' }, ctx);
    expect(out).toMatch(/still missing: first_name, last_name/);
    expect(out).not.toMatch(/ONE question/);
  });

  test('the caller-context kill switch is read at execution time: off, the account is not read even with the flag', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    customerReads = 0;
    const out = await ask({ use_account_details: true });
    expect(out).toMatch(/still missing: first_name, last_name, email, address_line1/);
    expect(out).not.toMatch(/ONE question/);
    expect(customerReads).toBe(0);
  });

  test('a complete correction whose card write fails keeps the promise and does not repeat it with the new details', async () => {
    const ctx = estimateCtx({ getPromise: () => ({ verdict: true, expectation: 'about_15_minutes' }), notePromise: jest.fn() });
    surfaceEstimateRequestForCustomer.mockResolvedValueOnce({ persisted: false, suppressed: false });
    const out = await ask({ first_name: 'Dana', last_name: 'Sample', email: 'new@example.com', address_line1: '9 Rental Rd' }, ctx);
    expect(out).toMatch(/already promised on this call is still owed, but these corrected details\s+could NOT be saved/);
    expect(out).toMatch(/will call you back to confirm where to send it/);
    expect(out).not.toMatch(/could NOT be queued — do NOT promise/);
    expect(ctx.notePromise).not.toHaveBeenCalled();
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
    // The question is asked only when the tool's result offers it (the tool knows who is eligible).
    expect(buildBasePrompt(true)).toMatch(/written estimate, call capture_lead with estimate_requested first/);
    expect(buildBasePrompt(true)).toMatch(/ONLY when that result offers it, ask the one\s+question "Should it go to the email and service address on your account\?"/);
    expect(buildBasePrompt(true)).toMatch(/When the result does not offer it, ask for what is missing/);
    expect(buildBasePrompt(false)).not.toMatch(/KNOWN CALLER/);
  });
});
