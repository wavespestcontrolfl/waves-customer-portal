// Sandy P1 (#5751): what is already on a customer's account is not asked for
// again — and the TOOLS make that true. A full-tier caller's missing location
// or estimate fields come from their own account; a recognised-only or
// unmatched caller gets nothing; a location the caller states always wins.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(),
  surfaceEstimateRequestForCustomer: jest.fn(async () => ({ persisted: true, suppressed: false })),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn(),
    resolveBookingCoords: jest.fn(),
    buildBookingAvailability: jest.fn(),
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
jest.mock('../services/scheduling/parse-when', () => ({ parseWhen: jest.fn(), summarizeWindow: jest.fn() }));

const db = require('../models/db');
const { executeTool } = require('../services/voice-agent/relay-tools');
const { isEnabled } = require('../config/feature-gates');
const booking = require('../routes/booking')._internals;
const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
const { createLeadFromExtraction, surfaceEstimateRequestForCustomer } = require('../services/lead-from-extraction');

const ACCOUNT = { first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' };
const SLOTS = [{ date: '2026-07-01', start_label: '9:00 AM' }, { date: '2026-07-01', start_label: '1:00 PM' }];
const fullTier = (over = {}) => ({ from: '+19415550131', callSid: 'CA-acct-1', callerVerified: true, customerId: 'c-1', customerTier: 'full', markCaptured: jest.fn(), ...over });

let customerReads;
beforeEach(() => {
  jest.clearAllMocks();
  customerReads = 0;
  db.mockImplementation((table) => ({
    where: () => ({ first: async () => { if (table === 'customers') customerReads += 1; return table === 'customers' ? ACCOUNT : undefined; } }),
  }));
  isEnabled.mockReturnValue(true);
  booking.loadBookingConfig.mockResolvedValue({ advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00' });
  booking.resolveBookingCoords.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  booking.buildBookingAvailability.mockResolvedValue({ slots: SLOTS, days: [{ slots: SLOTS }], nearby: true, total_feasible: 2 });
  parseWhen.mockReturnValue({ startDate: '2026-07-01', endDate: '2026-07-07' });
  summarizeWindow.mockReturnValue('Next week');
});

describe('availability uses the service address on a full-tier caller\'s account', () => {
  test.each(['get_availability', 'find_slots'])('%s with no location stated → the account address, never recited', async (name) => {
    const out = await executeTool(name, name === 'find_slots' ? { when: 'next week' } : {}, fullTier());
    expect(booking.resolveBookingCoords).toHaveBeenCalledWith({ address: '12 Test Street, Bradenton, 34205, FL', city: 'Bradenton' });
    expect(out).toMatch(/Open times/);
    expect(out).toMatch(/These times are for the service address on the caller's account/);
    expect(out).not.toMatch(/12 Test Street|34205/); // the agent must not have it to read out
  });

  test('a location the caller states wins, and the account is not read', async () => {
    const out = await executeTool('find_slots', { when: 'next week', city: 'Venice' }, fullTier());
    expect(booking.resolveBookingCoords).toHaveBeenCalledWith({ address: null, city: 'Venice' });
    expect(customerReads).toBe(0);
    expect(out).not.toMatch(/on the caller's account/);
  });

  test.each([
    ['a recognised-only (secondary slot) caller', { customerTier: 'redacted' }],
    ['an unverified session', { callerVerified: false }],
    ['an unmatched caller', { customerId: null }],
  ])('%s gets no account address — the tool still asks for a location', async (_label, over) => {
    booking.resolveBookingCoords.mockResolvedValue({});
    const out = await executeTool('find_slots', { when: 'next week' }, fullTier(over));
    expect(customerReads).toBe(0);
    expect(booking.resolveBookingCoords).toHaveBeenCalledWith({ address: null, city: null });
    expect(out).toMatch(/Ask the caller for their street address or ZIP/);
  });

  test('an account with no address on file still asks, and a failed read is "not on file"', async () => {
    booking.resolveBookingCoords.mockResolvedValue({});
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ first_name: 'Dana' }) }) }));
    expect(await executeTool('find_slots', { when: 'next week' }, fullTier())).toMatch(/Ask the caller for their street address or ZIP/);
    db.mockImplementation(() => ({ where: () => ({ first: async () => { throw new Error('db down'); } }) }));
    expect(await executeTool('find_slots', { when: 'next week' }, fullTier())).toMatch(/Ask the caller for their street address or ZIP/);
  });
});

describe('a written estimate for a customer on file asks for nothing twice', () => {
  test('full tier: name, email and address come from the account, so the request is deliverable at once', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    const noteEstimateFields = jest.fn();
    const out = await executeTool('capture_lead', { call_summary: 'Wants a written estimate for lawn care.', estimate_requested: true, requested_service: 'Lawn Care Program' },
      fullTier({ noteEstimateFields, officeOpenNow: () => true }));
    expect(noteEstimateFields).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Dana', last_name: 'Sample', email: 'dana@example.com' }));
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' });
    expect(out).not.toMatch(/still missing/i);
    expect(surfaceEstimateRequestForCustomer).toHaveBeenCalled();
  });

  test('what the caller gives on the call wins over the account', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    const noteEstimateFields = jest.fn();
    await executeTool('capture_lead', { call_summary: 'Estimate to a different email.', estimate_requested: true, email: 'other@example.com' }, fullTier({ noteEstimateFields }));
    expect(noteEstimateFields).toHaveBeenCalledWith(expect.objectContaining({ email: 'other@example.com', first_name: 'Dana' }));
  });

  test('a location stated on the call is never completed from the account: a new city alone leaves the street missing', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    const noteEstimateFields = jest.fn();
    const out = await executeTool('capture_lead', { call_summary: 'Estimate for their rental in Venice.', estimate_requested: true, city: 'Venice' }, fullTier({ noteEstimateFields }));
    const fields = noteEstimateFields.mock.calls[0][0];
    expect(fields).toMatchObject({ city: 'Venice', address_line1: null, zip: null, first_name: 'Dana', email: 'dana@example.com' });
    expect(out).toMatch(/address/i); // still missing — asked for, not borrowed
    expect(surfaceEstimateRequestForCustomer).not.toHaveBeenCalled();
  });

  test('an account address an earlier capture used is not remembered as stated: a city given later is never mixed with it, on that capture or the next', async () => {
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    // The call's real store only ADDS non-empty fields (relay-conversation).
    let bag = {};
    const ctx = fullTier({ getEstimateFields: () => ({ ...bag }), noteEstimateFields: (f) => { bag = { ...bag, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && String(v).trim() !== '')) }; } });
    await executeTool('capture_lead', { call_summary: 'Wants an estimate.', estimate_requested: true }, ctx);
    expect(createLeadFromExtraction.mock.calls[0][0]).toMatchObject({ address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' });
    expect(bag.address_line1).toBeUndefined();
    await executeTool('capture_lead', { call_summary: 'Actually for the Venice rental.', estimate_requested: true, city: 'Venice' }, ctx);
    expect(createLeadFromExtraction.mock.calls[1][0]).toMatchObject({ city: 'Venice', address_line1: null });
    const out = await executeTool('capture_lead', { call_summary: 'Still the Venice rental.', estimate_requested: true }, ctx);
    expect(createLeadFromExtraction.mock.calls[2][0]).toMatchObject({ city: 'Venice', address_line1: null });
    expect(bag).toMatchObject({ city: 'Venice' });
    expect(bag.address_line1).toBeUndefined();
    expect(out).toMatch(/address/i);
  });

  test('a recognised-only caller gets nothing filled, and an ordinary capture never reads the account', async () => {
    const relayAlert = require('../services/voice-agent/relay-alert');
    const bell = jest.spyOn(relayAlert, 'alertOfficeContactFollowUp').mockResolvedValue(true);
    const noteEstimateFields = jest.fn();
    await executeTool('capture_lead', { call_summary: 'Wants an estimate.', estimate_requested: true }, fullTier({ customerTier: 'redacted', noteEstimateFields }));
    expect(noteEstimateFields).toHaveBeenCalledWith(expect.objectContaining({ first_name: null, email: null, address_line1: null }));
    createLeadFromExtraction.mockResolvedValue({ leadId: null, customerId: 'c-1', created: false });
    customerReads = 0;
    await executeTool('capture_lead', { call_summary: 'Just a note.' }, fullTier());
    expect(customerReads).toBe(0);
    bell.mockRestore();
  });
});

describe('the exception lives at system priority, only when the caller-context lane is on', () => {
  test('context on: the intake exception is in the system prompt (so a late-arriving caller block is covered); context off: untouched', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    expect(buildBasePrompt(true)).toMatch(/is the exception to gathering a name, address and\s+email/);
    expect(buildBasePrompt(true)).toMatch(/start of the call or partway through/);
    expect(buildBasePrompt(false)).not.toMatch(/KNOWN CALLER/);
  });
});
