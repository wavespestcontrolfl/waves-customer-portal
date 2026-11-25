/**
 * A practice line (the GPT-Live trial's brain) and the paid availability stages.
 * find_slots / get_availability can start paid calls (geocode, the date parser
 * with its provider fallback, road times): each stage checks the brain's
 * call-scoped cancellation first, so a lookup that outlives its call or its
 * timeout starts nothing new. Their results promise no callback on a practice
 * line. The booking engine and the parser are stubs: no paid call is made.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));

const mockBooking = {
  loadBookingConfig: jest.fn(async () => ({ slot_duration_minutes: 60, advance_days_min: 1, advance_days_max: 14 })),
  resolveBookingCoords: jest.fn(async () => ({ lat: 27.5, lng: -82.5 })),
  buildBookingAvailability: jest.fn(async () => ({ slots: [{ date: '2026-12-01', start: '09:00', startMinutes: 540 }], days: [], nearby: false })),
  MAX_BOOKING_HORIZON_DAYS: 60,
};
jest.mock('../routes/booking', () => ({ _internals: mockBooking }));
const mockParse = {
  parseWhen: jest.fn(async () => ({ dateFrom: '2026-12-01', dateTo: '2026-12-07', timeOfDay: 'any' })),
  summarizeWindow: jest.fn(() => 'For next week.'),
};
jest.mock('../services/scheduling/parse-when', () => mockParse);
jest.mock('../services/voice-agent/relay-context', () => {
  const actual = jest.requireActual('../services/voice-agent/relay-context');
  return {
    ...actual,
    pricingText: jest.fn(async () => 'PRICING TEXT'),
    servicesCatalogText: jest.fn(async () => 'CATALOG TEXT'),
  };
});

const featureGates = require('../config/feature-gates');
const relayContext = require('../services/voice-agent/relay-context');
const { executeTool, resolveAvailability, availabilityResultToText } = require('../services/voice-agent/relay-tools');
const { LiveBrain } = require('../services/voice-agent/live-brain');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');

const OLD_CTX = process.env.VOICE_RELAY_CONTEXT_ENABLED;
let gateSpy;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED; // the account-context gate is OFF
  gateSpy = jest.spyOn(featureGates, 'isEnabled').mockReturnValue(true);
});
afterEach(() => gateSpy.mockRestore());
afterAll(() => {
  if (OLD_CTX === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = OLD_CTX;
});

const practiceCtx = (extra = {}) => ({ practiceLine: true, sandbox: true, callSid: 'CA-pa-1', from: '+19415551234', ...extra });

describe('public reads run with the account-context gate off', () => {
  test('get_pricing and get_services_catalog execute on a practice line', async () => {
    await expect(executeTool('get_pricing', { service: 'pest' }, practiceCtx())).resolves.toBe('PRICING TEXT');
    await expect(executeTool('get_services_catalog', {}, practiceCtx())).resolves.toBe('CATALOG TEXT');
    expect(relayContext.isContextEnabled()).toBe(false);
  });

  test('an ordinary session with the gate off still refuses them (unchanged)', async () => {
    const out = await executeTool('get_pricing', { service: 'pest' }, { callSid: 'CA-ord' });
    expect(out).toMatch(/That lookup is not available/);
    expect(relayContext.pricingText).not.toHaveBeenCalled();
  });

  test('the practice conversation builds the prompt that quotes prices even with the gate off', () => {
    const convo = new RelayConversation({ callSid: 'CA-pa-2', from: '+19415551234', send: jest.fn(), sandbox: true, practiceLine: true });
    expect(convo._practiceLine).toBe(true);
    expect(relayContext.isContextEnabled()).toBe(false);
  });
});

describe('practice-aware availability text', () => {
  const ctx = practiceCtx();
  test('success: nothing booked, no promised call or confirmation, says the practice line cannot hold the time', () => {
    const res = { status: 'ok', summary: 'For next week.', availability: { slots: [{ date: '2026-12-01', start: '09:00', startMinutes: 540 }] }, offerContext: {} };
    const text = availabilityResultToText(res, ctx);
    expect(text).toMatch(/Open times: /);
    expect(text).toMatch(/NOTHING IS BOOKED/);
    expect(text).toMatch(/this practice line can't hold the time/);
    expect(text).toMatch(/Do NOT promise a call, a confirmation/);
    expect(text).not.toMatch(/Waves team member will call|call to confirm|lock it in|request_booking|slot_ref/i);
  });

  test.each([
    ['empty', { status: 'ok', summary: 'For next week.', availability: { slots: [] }, offerContext: {} }],
    ['unavailable', { status: 'unavailable' }],
    ['cancelled', { status: 'cancelled' }],
    ['need_location', { status: 'need_location' }],
  ])('%s result promises no callback', (_name, res) => {
    const text = availabilityResultToText(res, ctx);
    expect(text).not.toMatch(/will call|call to confirm|confirmation call|lock it in|call you back|follow up|team member will|capture the lead/i);
  });

  test('a tool failure on a practice line promises no follow-up', async () => {
    mockBooking.loadBookingConfig.mockRejectedValueOnce(new Error('boom'));
    const ctxFail = practiceCtx();
    const out = await executeTool('find_slots', { when: 'next week', address_line1: '1 Palm Ave', city: 'Bradenton', zip: '34205' }, ctxFail);
    expect(out).toMatch(/practice line/);
    expect(out).toMatch(/Do not promise a callback/);
    expect(out).not.toMatch(/Waves team member will|capture the lead/i);
    expect(ctxFail.toolFailed).toBe(true);
  });

  test('an ordinary session keeps the production wording', () => {
    const text = availabilityResultToText({ status: 'ok', summary: null, availability: { slots: [] }, offerContext: {} }, {});
    expect(text).toMatch(/Waves team member will call to find a time/);
  });
});

describe('call-scoped cancellation of paid stages', () => {
  const where = { when: 'next week', address_line1: '1 Palm Ave', city: 'Bradenton', zip: '34205' };
  const noPaidCall = () => {
    expect(mockBooking.resolveBookingCoords).not.toHaveBeenCalled();
    expect(mockParse.parseWhen).not.toHaveBeenCalled();
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  };

  test('cancelled before it starts: no paid stage runs', async () => {
    await expect(resolveAvailability({ ...where, isCancelled: () => true })).resolves.toEqual({ status: 'cancelled' });
    noPaidCall();
  });

  test('cancelled while the geocode runs: neither the date parser nor road times start', async () => {
    let cancelled = false;
    mockBooking.resolveBookingCoords.mockImplementationOnce(async () => { cancelled = true; return { lat: 27.5, lng: -82.5 }; });
    await expect(resolveAvailability({ ...where, isCancelled: () => cancelled })).resolves.toEqual({ status: 'cancelled' });
    expect(mockBooking.resolveBookingCoords).toHaveBeenCalledTimes(1);
    expect(mockParse.parseWhen).not.toHaveBeenCalled();
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('cancelled while the date parser runs: road times never start', async () => {
    let cancelled = false;
    mockParse.parseWhen.mockImplementationOnce(async () => { cancelled = true; return { dateFrom: '2026-12-01', dateTo: '2026-12-07', timeOfDay: 'any' }; });
    await expect(resolveAvailability({ ...where, isCancelled: () => cancelled })).resolves.toEqual({ status: 'cancelled' });
    expect(mockParse.parseWhen).toHaveBeenCalledTimes(1);
    expect(mockBooking.buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('an uncancelled lookup (and every ordinary caller) runs all its stages', async () => {
    const res = await resolveAvailability(where);
    expect(res.status).toBe('ok');
    expect(mockBooking.resolveBookingCoords).toHaveBeenCalledTimes(1);
    expect(mockParse.parseWhen).toHaveBeenCalledTimes(1);
    expect(mockBooking.buildBookingAvailability).toHaveBeenCalledTimes(1);
  });

  test('find_slots and get_availability on a practice line refuse to start once the call is cancelled', async () => {
    for (const name of ['find_slots', 'get_availability']) {
      const out = await executeTool(name, where, practiceCtx({ isCancelled: () => true }));
      expect(out).toMatch(/Could not check that right now/);
    }
    noPaidCall();
  });

  test('cancelled while the booking config loads: no geocode starts', async () => {
    let cancelled = false;
    mockBooking.loadBookingConfig.mockImplementationOnce(async () => { cancelled = true; return { slot_duration_minutes: 60 }; });
    await expect(resolveAvailability({ ...where, isCancelled: () => cancelled })).resolves.toEqual({ status: 'cancelled' });
    noPaidCall();
  });

  test('the call-scoped signal is handed to every paid stage (geocode, date parser, road times)', async () => {
    const controller = new AbortController();
    await resolveAvailability({ ...where, signal: controller.signal });
    expect(mockBooking.resolveBookingCoords.mock.calls[0][0].signal).toBe(controller.signal);
    expect(mockParse.parseWhen.mock.calls[0][1].signal).toBe(controller.signal);
    expect(mockBooking.buildBookingAvailability.mock.calls[0][0].signal).toBe(controller.signal);
    // the no-timeframe path (get_availability) reaches road times with it too
    mockBooking.buildBookingAvailability.mockClear();
    await resolveAvailability({ address_line1: where.address_line1, city: where.city, zip: where.zip, signal: controller.signal });
    expect(mockBooking.buildBookingAvailability.mock.calls[0][0].signal).toBe(controller.signal);
  });

  test('after LiveBrain.end() or a retirement the conversation reports cancelled, and no paid stub is called', async () => {
    const make = (args) => new RelayConversation(args);
    const db = jest.fn(() => ({ where: () => ({ first: async () => ({ source: 'voice_relay_sandbox', from_phone: '+19415551234', to_phone: '+19412412993' }) }) }));
    const brain = await LiveBrain.open({ callSid: 'CA-pa-3', db, make });
    const ctx = brain.convo._buildToolCtx();
    expect(ctx.isCancelled()).toBe(false);
    await brain.end('twilio_stop');
    expect(ctx.isCancelled()).toBe(true);
    const out = await executeTool('find_slots', where, { ...ctx, practiceLine: true });
    expect(out).toMatch(/Could not check that right now/);
    noPaidCall();

    const second = await LiveBrain.open({ callSid: 'CA-pa-4', db, make });
    second.retired = true;
    second.convo.ended = true; // what a hard timeout does
    expect(second.convo._buildToolCtx().isCancelled()).toBe(true);
  });
});
