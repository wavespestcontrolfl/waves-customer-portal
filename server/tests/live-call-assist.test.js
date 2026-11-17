/**
 * Live call assist (GATE_CALL_LIVE_ASSIST, owner 2026-11-16 "ok build all, use haiku").
 *
 * Pins: gate off = no read and no model call; the cadence (first run at 2 caller lines, 45 s gap, 12 runs, nothing
 * after the call stops, two racing polls admit one); a refusal, bad JSON or an API error keeps the last assist; every
 * model field is validated; price and times are looked up again only when the key changed; one failing lookup leaves
 * the intent and the other lookup in place; the engine's text is shown without its instructions to the voice agent.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));

const mockLedger = jest.fn((provider, model, fn) => fn());
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: (...args) => mockLedger(...args) }));

const mockPricing = jest.fn();
jest.mock('../services/voice-agent/relay-context', () => ({ pricingText: (...a) => mockPricing(...a) }));
const mockAvailability = jest.fn();
jest.mock('../services/voice-agent/relay-tools', () => ({
  resolveAvailability: (...a) => mockAvailability(...a),
  formatSlots: (slots, max) => (slots || []).slice(0, max).map((s) => `${s.date} at ${s.start_label}`).join('; '),
}));
const mockLocate = jest.fn();
jest.mock('../services/voice-agent/relay-booking', () => ({ resolveAccountBookingLocation: (...a) => mockLocate(...a) }));
const mockMatches = jest.fn();
jest.mock('../routes/booking', () => ({ _internals: { addressMatchesCustomer: (...a) => mockMatches(...a) } }));

// call_log holds one row; call_live_utterances is a list; customers is a map. The claim UPDATE runs its compare-and-swap
// against the row's JSON, as the SQL does.
jest.mock('../models/db', () => {
  const state = { call: null, utterances: [], customers: {} };
  const live = () => state.call.metadata.live_transcription;
  function callLog() {
    const q = { raws: [] };
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn((sql, bindings) => { q.raws.push({ sql, bindings }); return q; });
    q.update = jest.fn(async (patch) => {
      const cas = q.raws.find((r) => r.sql.includes("'assist' ->> 'runs'"));
      const l = live();
      if (cas) {
        // The claim also checks stopped_at; the result save (the fence) checks only the run number.
        const claim = q.raws.some((r) => r.sql.includes('stopped_at'));
        if ((Number(l.assist?.runs) || 0) !== cas.bindings[0] || (claim && l.stopped_at)) return 0;
      }
      l.assist = { ...(l.assist || {}), ...JSON.parse(patch.metadata.bindings[0]) };
      return 1;
    });
    return q;
  }
  function utterances() {
    const q = {};
    q.where = jest.fn(() => q);
    q.count = jest.fn(async () => [{ n: String(state.utterances.filter((u) => u.speaker === 'caller').length) }]);
    q.orderBy = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.select = jest.fn(async () => [...state.utterances].sort((a, b) => b.spoken_at - a.spoken_at || b.id - a.id));
    return q;
  }
  function customers() {
    const q = {};
    q.where = jest.fn((cond) => { q.id = cond.id; return q; });
    q.whereNull = jest.fn(() => q);
    q.first = jest.fn(async () => state.customers[q.id]);
    return q;
  }
  const db = jest.fn((table) => (table === 'call_log' ? callLog() : table === 'customers' ? customers() : utterances()));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const MODELS = require('../config/models');
const { refreshAssistIfDue, assistForPanel, _test } = require('../services/live-call-assist');

const SID = 'CA' + 'b'.repeat(32);
const T0 = Date.UTC(2026, 10, 17, 15, 0, 0);
const liveState = () => db.__state.call.metadata.live_transcription;
const assist = () => liveState().assist;
const row = () => JSON.parse(JSON.stringify(db.__state.call));
const run = (opts) => refreshAssistIfDue(row(), opts);

function setCall(live = {}) {
  db.__state.call = { id: 'log-1', twilio_call_sid: SID, metadata: { live_transcription: { status: 'started', live_at: new Date(T0).toISOString(), ...live } } };
}
function speak(n, text = 'I need pest control at my house') {
  let id = db.__state.utterances.length;
  for (let i = 0; i < n; i += 1) { id += 1; db.__state.utterances.push({ id, speaker: 'caller', text: `${text} ${id}`, spoken_at: T0 + id * 1000 }); }
}
const advance = (ms) => jest.setSystemTime(Date.now() + ms);
const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const PEST = { intent: 'Wants quarterly pest control', service: 'pest_control', when: null, address_line1: null, city: null, zip: null, home_sqft: 2000, lot_sqft: null };
const NO_FACTS = {
  service: null, when: null, address_line1: null, city: null, zip: null, home_sqft: null, lot_sqft: null,
  property_type: null, frequency: null, lawn_track: null, lawn_tier: null, mosquito_tier: null,
};
const SLOTS = { status: 'ok', availability: { slots: [1, 2, 3, 4].map((d) => ({ date: `2026-11-1${d}`, start_label: '9:00 AM' })) } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: T0 + 600 * 1000 });
  db.__state.utterances = [];
  db.__state.customers = {};
  isEnabled.mockReturnValue(true);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockResolvedValue(reply(PEST));
  mockPricing.mockResolvedValue('Standard pest control pricing for this property size: $99 per application on the quarterly plan; 4 applications per year. Quote ONLY these numbers. Recurring prices are PER APPLICATION.');
  mockAvailability.mockResolvedValue(SLOTS);
  mockLocate.mockResolvedValue({ status: 'ok', coords: { lat: 27.5, lng: -82.5 } });
  mockMatches.mockReturnValue(true);
  setCall();
  speak(2);
});
afterEach(() => { jest.useRealTimers(); });

describe('live call assist cadence', () => {
  test('gate off: no read, no lookup and no model call', async () => {
    isEnabled.mockReturnValue(false);
    await expect(run()).resolves.toEqual({ ran: false, reason: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPricing).not.toHaveBeenCalled();
    expect(mockAvailability).not.toHaveBeenCalled();
  });

  test('the first run waits for 2 caller lines', async () => {
    db.__state.utterances = [];
    speak(1);
    await expect(run()).resolves.toEqual({ ran: false, reason: 'not_due' });
    expect(mockCreate).not.toHaveBeenCalled();
    speak(1);
    await expect(run()).resolves.toMatchObject({ ran: true, saved: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(assist()).toMatchObject({ runs: 1, caller_count: 2, intent: 'Wants quarterly pest control', service: 'pest_control' });
  });

  test('a later run needs 1 new caller line and 45 s since the last', async () => {
    await run();
    speak(1);
    advance(30 * 1000);
    await expect(run()).resolves.toMatchObject({ reason: 'not_due' });
    advance(16 * 1000);
    await expect(run()).resolves.toMatchObject({ ran: true });
    expect(assist().runs).toBe(2);
    // 45 s later with no new caller line: still not due.
    advance(60 * 1000);
    await expect(run()).resolves.toMatchObject({ reason: 'not_due' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('stops after 12 runs', async () => {
    setCall({ assist: { runs: 12, at: new Date(T0).toISOString(), caller_count: 0 } });
    await expect(run()).resolves.toMatchObject({ reason: 'not_due' });
    setCall({ assist: { runs: 11, at: new Date(T0).toISOString(), caller_count: 0 } });
    await expect(run()).resolves.toMatchObject({ ran: true });
    expect(assist().runs).toBe(12);
  });

  test('a call that has stopped is not read', async () => {
    setCall({ stopped_at: new Date(T0).toISOString() });
    await expect(run()).resolves.toMatchObject({ reason: 'not_due' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a call with no live transcription is skipped', async () => {
    db.__state.call.metadata = {};
    await expect(run()).resolves.toEqual({ ran: false, reason: 'not_live' });
  });

  test('two polls that read the same row admit one run', async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(assist().runs).toBe(1);
  });

  test('the model request: Haiku pin, lane, labeled transcript', async () => {
    db.__state.utterances.push({ id: 99, speaker: 'staff', text: 'How can I help', spoken_at: T0 + 99 * 1000 });
    await run();
    const [provider, model, , options] = mockLedger.mock.calls[0];
    expect([provider, model, options]).toEqual(['anthropic', MODELS.LIVE_CALL, { laneId: 'live_call_assist' }]);
    const body = mockCreate.mock.calls[0][0];
    expect(body.model).toBe(MODELS.LIVE_CALL);
    expect(body.messages[0].content).toMatch(/^Caller: I need pest control at my house 1\nCaller: .* 2\nAgent: How can I help$/);
  });
});

describe('live call assist read', () => {
  test('bad JSON, a refusal and an API error keep the last assist; the run still counts', async () => {
    await run();
    const kept = { ...assist() };
    for (const next of [
      () => mockCreate.mockResolvedValueOnce(reply('sorry, I cannot')),
      () => mockCreate.mockResolvedValueOnce({ stop_reason: 'refusal', content: [] }),
      () => mockCreate.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 529 })),
    ]) {
      speak(1);
      advance(50 * 1000);
      next();
      await expect(run()).resolves.toMatchObject({ ran: true, saved: false });
      expect(assist()).toMatchObject({ intent: kept.intent, price: kept.price, times: kept.times, service: kept.service });
    }
    expect(assist().runs).toBe(4);
  });

  test('validates every field: enum, 5-digit zip, positive sizes, control characters, lengths and card numbers', () => {
    const ok = _test.validate({
      intent: `Wants  pest\u0000 control ${'x'.repeat(200)}`, service: 'lawn_care', when: 'next week', address_line1: '12 Example St',
      city: 'Bradenton', zip: '34202-1234', home_sqft: '2,400', lot_sqft: 9000.4,
    });
    expect(ok.intent).toHaveLength(90);
    expect(ok.intent.startsWith('Wants pest control')).toBe(true);
    expect(ok.facts).toEqual({ ...NO_FACTS, service: 'lawn_care', when: 'next week', address_line1: '12 Example St', city: 'Bradenton', zip: '34202', home_sqft: 2400, lot_sqft: 9000 });
    const bad = _test.validate({ intent: 'ok', service: 'rodent', when: 5, address_line1: {}, city: ['x'], zip: '3420', home_sqft: -3, lot_sqft: 'big' });
    expect(bad.facts).toEqual(NO_FACTS);
    expect(_test.validate({ service: 'pest_control' })).toBeNull();
    expect(_test.validate('text')).toBeNull();
    // A card number the model writes whole is masked before it reaches the screen.
    expect(_test.validate({ intent: 'Pay with 4242 4242 4242 4242 today' }).intent).toBe('Pay with [card ending 4242] today');
  });

  test('a fact the caller said earlier stays after it leaves the window', async () => {
    mockCreate.mockResolvedValueOnce(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    await run();
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValueOnce(reply({ ...PEST, home_sqft: null, address_line1: null, city: null, zip: null }));
    await run();
    expect(assist().facts).toMatchObject({ address_line1: '12 Example St', city: 'Bradenton', zip: '34202', home_sqft: 2000 });
  });
});

describe('live call assist price and times', () => {
  test('price is the engine text without its instructions to the voice agent; times are the soonest 3', async () => {
    await run();
    expect(mockPricing).toHaveBeenCalledWith({ service: 'pest_control', home_sqft: 2000, lot_sqft: undefined });
    expect(assist().price).toBe('Standard pest control pricing for this property size: $99 per application on the quarterly plan; 4 applications per year');
    // No location and no account: no availability lookup at all.
    expect(mockAvailability).not.toHaveBeenCalled();
    expect(assist().times).toBeNull();
  });

  test('a spoken address looks up open times; scheduling off shows none', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, when: 'next week', address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    await run();
    expect(mockAvailability).toHaveBeenCalledWith({ address_line1: '12 Example St', city: 'Bradenton', zip: '34202', when: 'next week', account: null });
    expect(assist().times).toBe('2026-11-11 at 9:00 AM; 2026-11-12 at 9:00 AM; 2026-11-13 at 9:00 AM');
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...PEST, when: 'next week', address_line1: '12 Example St', city: 'Bradenton', zip: '34202', lot_sqft: 9000 }));
    mockAvailability.mockResolvedValue({ status: 'unavailable' });
    await run();
    expect(assist().times).toBeNull();
    expect(assist().price).toContain('$99');
  });

  test('a matched customer: the account pin and the account lot size, no spoken address needed', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', lot_sqft: 8000, property_sqft: 3000 } };
    mockCreate.mockResolvedValue(reply({ ...PEST, service: 'lawn_care' }));
    await run({ customerId: 'cust-1' });
    expect(mockPricing).toHaveBeenCalledWith({ service: 'lawn_care', home_sqft: 2000, lot_sqft: 8000, lawn_sqft: 3000 });
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ account: { kind: 'account', customerId: 'cust-1', coords: { lat: 27.5, lng: -82.5 } } }));
    expect(assist().times).toContain('9:00 AM');
  });

  test('a matched customer who names another street gets times at that street and no account sizes', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', lot_sqft: 8000, property_sqft: 3000 } };
    mockMatches.mockReturnValue(false);
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '9 Other Rd', city: 'Venice', zip: '34285' }));
    await run({ customerId: 'cust-1' });
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '9 Other Rd', account: null }));
    expect(mockPricing).toHaveBeenCalledWith({ service: 'pest_control', home_sqft: 2000, lot_sqft: undefined });
  });

  // No street yet: a city or zip that is not the account's means another property, so the account's pin and sizes stay
  // out (the spoken place is used instead).
  test.each([
    ['another city', { city: 'Venice' }],
    ['another zip', { zip: '34285' }],
  ])('a matched customer who names %s, with no street, gets no account pin or sizes', async (_label, place) => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', city: 'Bradenton', zip: '34202-1234', lot_sqft: 8000, property_sqft: 3000 } };
    mockCreate.mockResolvedValue(reply({ ...PEST, service: 'lawn_care', ...place }));
    await run({ customerId: 'cust-1' });
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ ...place, account: null }));
    expect(mockPricing).toHaveBeenCalledWith({ service: 'lawn_care', home_sqft: 2000, lot_sqft: undefined });
    expect(mockMatches).not.toHaveBeenCalled();
  });

  test('the account\'s own city in other casing and its 5-digit zip still use the account', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', city: 'Bradenton', zip: '34202-1234', lot_sqft: 8000, property_sqft: 3000 } };
    mockCreate.mockResolvedValue(reply({ ...PEST, service: 'lawn_care', city: 'BRADENTON', zip: '34202' }));
    await run({ customerId: 'cust-1' });
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ account: { kind: 'account', customerId: 'cust-1', coords: { lat: 27.5, lng: -82.5 } } }));
    expect(mockPricing).toHaveBeenCalledWith({ service: 'lawn_care', home_sqft: 2000, lot_sqft: 8000, lawn_sqft: 3000 });
  });

  test('no service and no timing: no price or availability lookup', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way' } };
    mockCreate.mockResolvedValue(reply({ ...PEST, service: null }));
    await run({ customerId: 'cust-1' });
    expect(mockPricing).not.toHaveBeenCalled();
    expect(mockAvailability).not.toHaveBeenCalled();
    expect(assist()).toMatchObject({ intent: 'Wants quarterly pest control', price: null, times: null });
  });

  test('an unchanged key reuses price and times without a second lookup', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    await run();
    const first = { price: assist().price, times: assist().times, key: assist().key };
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...PEST, intent: 'Asks about a quarterly plan', address_line1: '12 EXAMPLE ST', city: 'Bradenton', zip: '34202' }));
    await run();
    expect(mockPricing).toHaveBeenCalledTimes(1);
    expect(mockAvailability).toHaveBeenCalledTimes(1);
    expect(assist()).toMatchObject({ ...first, intent: 'Asks about a quarterly plan', runs: 2 });
    // A new size changes the key: both look up again.
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...PEST, home_sqft: 3000, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    await run();
    expect(mockPricing).toHaveBeenCalledTimes(2);
    expect(mockAvailability).toHaveBeenCalledTimes(2);
  });

  test('a lookup error leaves the intent and the other lookup in place and is retried next run', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    mockAvailability.mockRejectedValue(new Error('geocode down'));
    await expect(run()).resolves.toMatchObject({ ran: true, saved: true });
    expect(assist()).toMatchObject({ intent: 'Wants quarterly pest control', times: null, key: null });
    expect(assist().price).toContain('$99');
    speak(1);
    advance(50 * 1000);
    mockAvailability.mockResolvedValue(SLOTS);
    await run();
    expect(mockPricing).toHaveBeenCalledTimes(2);
    expect(mockAvailability).toHaveBeenCalledTimes(2);
    expect(assist().times).toContain('9:00 AM');
    expect(assist().key).toEqual(expect.any(String));
  });

  // resolveAccountBookingLocation reports a property-count or geocode failure as toolFailed, never a throw.
  test('a matched caller whose account location lookup fails is retried next run, not kept as no times', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', lot_sqft: 8000 } };
    mockLocate.mockResolvedValueOnce({ status: 'count_failed', toolFailed: true });
    mockCreate.mockResolvedValue(reply({ ...PEST, when: 'next week' }));
    await run({ customerId: 'cust-1' });
    expect(assist()).toMatchObject({ times: null, key: null });
    expect(mockAvailability).not.toHaveBeenCalled();
    speak(1);
    advance(50 * 1000);
    await run({ customerId: 'cust-1' });
    expect(mockLocate).toHaveBeenCalledTimes(2);
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ account: { kind: 'account', customerId: 'cust-1', coords: { lat: 27.5, lng: -82.5 } } }));
    expect(assist().times).toContain('9:00 AM');
    expect(assist().key).toEqual(expect.any(String));
  });

  test('a real "no location" answer (not a failure) is kept: no retry while the facts stay the same', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', lot_sqft: 8000 } };
    mockLocate.mockResolvedValue({ status: 'multi_property', toolFailed: false });
    mockCreate.mockResolvedValue(reply({ ...PEST, when: 'next week' }));
    await run({ customerId: 'cust-1' });
    expect(assist()).toMatchObject({ times: null, key: expect.any(String) });
    speak(1);
    advance(50 * 1000);
    await run({ customerId: 'cust-1' });
    expect(mockLocate).toHaveBeenCalledTimes(1);
  });

  test('a price lookup error leaves the times in place', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    mockPricing.mockRejectedValue(new Error('db down'));
    await run();
    expect(assist()).toMatchObject({ price: null });
    expect(assist().times).toContain('9:00 AM');
  });

  test('staffPrice keeps the price sentence for custom-quote and missing-size answers too', () => {
    expect(_test.staffPrice('This one needs a custom quote — do not state a price. Tell the caller a Waves team member will go over it.')).toBe('This one needs a custom quote');
    expect(_test.staffPrice("Cannot price lawn care yet — still needed: the home's approximate square footage (home_sqft). Ask the caller, then call get_pricing again. Do NOT guess.")).toBe("Cannot price lawn care yet — still needed: the home's approximate square footage");
  });
});

describe('live call assist property and plan inputs', () => {
  const next = async (obj) => {
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...PEST, ...obj }));
    await run();
  };

  test('the allowed values are the ones get_pricing advertises', () => {
    const { CONTEXT_TOOLS } = jest.requireActual('../services/voice-agent/relay-tools');
    const props = CONTEXT_TOOLS.find((t) => t.name === 'get_pricing').input_schema.properties;
    const valid = (name, value) => _test.validate({ intent: 'x', [name]: value }).facts[name];
    for (const name of ['service', 'property_type', 'frequency', 'lawn_track', 'lawn_tier', 'mosquito_tier']) {
      for (const value of props[name].enum) expect(valid(name, value)).toBe(value);
      expect(valid(name, 'basic')).toBeNull();
    }
  });

  test('a commercial caller is forwarded as commercial and cached', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, property_type: 'commercial' }));
    await run();
    expect(mockPricing).toHaveBeenCalledWith(expect.objectContaining({ service: 'pest_control', property_type: 'commercial' }));
    expect(assist().facts.property_type).toBe('commercial');
    // The same facts again: no second lookup.
    await next({ intent: 'Still asking', property_type: 'commercial' });
    expect(mockPricing).toHaveBeenCalledTimes(1);
  });

  test('monthly pest, lawn track and tier, and mosquito tier are forwarded; the engine default is never filled in', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, frequency: 'monthly' }));
    await run();
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'pest_control', home_sqft: 2000, lot_sqft: undefined, frequency: 'monthly' });
    await next({ service: 'lawn_care', lawn_track: 'bermuda', lawn_tier: 'premium' });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'lawn_care', home_sqft: 2000, lot_sqft: undefined, lawn_track: 'bermuda', lawn_tier: 'premium' });
    expect(assist().facts).toMatchObject({ service: 'lawn_care', lawn_track: 'bermuda', lawn_tier: 'premium', frequency: null });
    await next({ service: 'mosquito', mosquito_tier: 'seasonal9' });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'mosquito', home_sqft: 2000, lot_sqft: undefined, mosquito_tier: 'seasonal9' });
    // Nothing said about a plan: no plan input at all.
    await next({ service: 'pest_control' });
    expect(Object.keys(mockPricing.mock.calls.at(-1)[0]).filter((k) => mockPricing.mock.calls.at(-1)[0][k] !== undefined).sort())
      .toEqual(['home_sqft', 'service']);
  });

  test('an invalid value is dropped, not guessed', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, frequency: 'weekly', property_type: 'mansion', lawn_tier: 'basic', mosquito_tier: 5 }));
    await run();
    expect(assist().facts).toMatchObject({ frequency: null, property_type: null, lawn_tier: null, mosquito_tier: null });
    expect(mockPricing).toHaveBeenCalledWith({ service: 'pest_control', home_sqft: 2000, lot_sqft: undefined });
  });

  test('a changed input forces a new lookup, and the caller correcting it replaces the old value', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, frequency: 'quarterly' }));
    await run();
    await next({ frequency: 'quarterly' });
    expect(mockPricing).toHaveBeenCalledTimes(1);
    for (const [obj, expected] of [[{ frequency: 'monthly' }, 2], [{ property_type: 'condo_ground' }, 3], [{ property_type: 'commercial' }, 4]]) {
      await next(obj);
      expect(mockPricing).toHaveBeenCalledTimes(expected);
    }
    expect(mockPricing).toHaveBeenLastCalledWith(expect.objectContaining({ frequency: 'monthly', property_type: 'commercial' }));
  });
});

describe('live call assist withdrawn facts', () => {
  const next = async (obj) => {
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...NO_FACTS, ...obj }));
    await run();
  };

  test('mergeFacts keeps an unmentioned fact, replaces a changed one and clears a withdrawn one', () => {
    const prev = { ...NO_FACTS, service: 'pest_control', frequency: 'monthly', when: 'Friday', home_sqft: 2000 };
    expect(_test.mergeFacts(prev, NO_FACTS)).toEqual(prev);
    expect(_test.mergeFacts(prev, { ...NO_FACTS, when: 'Monday' }).when).toBe('Monday');
    expect(_test.mergeFacts(prev, NO_FACTS, ['when', 'home_sqft'])).toEqual({ ...prev, when: null, home_sqft: null });
    // A different service drops the plan details said for the old one; a first service does not.
    expect(_test.mergeFacts(prev, { ...NO_FACTS, service: 'lawn_care' })).toMatchObject({ service: 'lawn_care', frequency: null });
    expect(_test.mergeFacts({ ...NO_FACTS, frequency: 'monthly' }, { ...NO_FACTS, service: 'pest_control' }).frequency).toBe('monthly');
    // A new value in the same read as its withdrawal wins.
    expect(_test.mergeFacts(prev, { ...NO_FACTS, when: 'Monday' }, ['when']).when).toBe('Monday');
  });

  test('a withdrawn address drops the old property\'s sizes and type too, except what the same read says again', () => {
    const prev = { ...NO_FACTS, service: 'pest_control', address_line1: '12 Example St', city: 'Bradenton', zip: '34202', home_sqft: 2400, lot_sqft: 9000, property_type: 'condo' };
    const address = ['address_line1', 'city', 'zip'];
    expect(_test.mergeFacts(prev, NO_FACTS, address)).toMatchObject({ service: 'pest_control', address_line1: null, home_sqft: null, lot_sqft: null, property_type: null });
    expect(_test.mergeFacts(prev, { ...NO_FACTS, home_sqft: 1800 }, address)).toMatchObject({ home_sqft: 1800, lot_sqft: null, property_type: null });
    // A withdrawn plan detail is not a move: the place keeps its sizes.
    expect(_test.mergeFacts(prev, NO_FACTS, ['when'])).toMatchObject({ home_sqft: 2400, lot_sqft: 9000, property_type: 'condo' });
  });

  test('address taken back, then a new one said: the new property is priced without the old sizes and type', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202', home_sqft: 2400, lot_sqft: 9000, property_type: 'condo' }));
    await run();
    await next({ intent: 'Not that house', service: 'pest_control', withdrawn: ['address'] });
    expect(assist().facts).toMatchObject({ address_line1: null, home_sqft: null, lot_sqft: null, property_type: null });
    mockPricing.mockClear();
    await next({ intent: 'Wants quarterly pest control', service: 'pest_control', address_line1: '9 Other Rd', city: 'Venice', zip: '34285' });
    expect(assist().facts).toMatchObject({ address_line1: '9 Other Rd', home_sqft: null, lot_sqft: null, property_type: null });
    expect(mockPricing).toHaveBeenCalledWith({ service: 'pest_control', home_sqft: undefined, lot_sqft: undefined });
  });

  test('withdrawn: only known names, "address" means street, city and zip', () => {
    const v = _test.validate({ intent: 'x', withdrawn: ['address', 'service', 'service', 'call_summary', 7, 'zip'] });
    expect([...v.withdrawn].sort()).toEqual(['address_line1', 'city', 'service', 'zip']);
    expect(_test.validate({ intent: 'x', withdrawn: 'service' }).withdrawn).toEqual([]);
    expect(_test.validate({ intent: 'x' }).withdrawn).toEqual([]);
  });

  test('recurring to one-time: the old recurring price and plan go, and the next lookup is not a recurring price', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, frequency: 'monthly', address_line1: '12 Example St', city: 'Bradenton', zip: '34202', when: 'next week' }));
    await run();
    expect(assist()).toMatchObject({ service: 'pest_control', price: expect.stringContaining('$99') });
    expect(assist().times).toContain('9:00 AM');
    mockPricing.mockClear();
    mockAvailability.mockClear();
    await next({ intent: 'Wants a one-time treatment', service: null, withdrawn: ['service'] });
    expect(assist()).toMatchObject({ intent: 'Wants a one-time treatment', service: null, price: null });
    expect(assist().facts).toMatchObject({ service: null, frequency: null, address_line1: '12 Example St', when: 'next week' });
    expect(assistForPanel({ live_transcription: liveState() })).toMatchObject({ intent: 'Wants a one-time treatment', price: null });
    // The engine prices recurring plans only: no service means no pricing call, never the old recurring one.
    expect(mockPricing).not.toHaveBeenCalled();
    // The model leaving the service null again (not withdrawn, not named) does not bring it back.
    await next({ intent: 'Wants a one-time treatment' });
    expect(assist().service).toBeNull();
    expect(assist().price).toBeNull();
    expect(mockPricing).not.toHaveBeenCalled();
  });

  test('without a withdrawal a null service keeps the plan', async () => {
    await run();
    await next({ intent: 'Asks about timing' });
    expect(assist()).toMatchObject({ service: 'pest_control', price: expect.stringContaining('$99') });
  });

  test('a withdrawn address clears the open times; a new street replaces them', async () => {
    mockCreate.mockResolvedValue(reply({ ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' }));
    await run();
    expect(assist().times).toContain('9:00 AM');
    mockAvailability.mockClear();
    await next({ ...PEST, intent: 'Address was wrong', withdrawn: ['address'] });
    expect(assist().times).toBeNull();
    expect(assist().facts).toMatchObject({ address_line1: null, city: null, zip: null });
    expect(assist().price).toContain('$99');
    expect(mockAvailability).not.toHaveBeenCalled();
    await next({ ...PEST, address_line1: '9 Other Rd', city: 'Venice', zip: '34285' });
    expect(mockAvailability).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '9 Other Rd' }));
    expect(assist().times).toContain('9:00 AM');
  });
});

describe('live call assist property switch', () => {
  const HOME = { ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202', lot_sqft: 9000, property_type: 'condo_ground' };
  const next = async (obj) => {
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply(obj));
    await run();
  };

  test('a new street clears the old sizes, type, city and zip unless the same read says them again', async () => {
    mockCreate.mockResolvedValue(reply(HOME));
    await run();
    await next({ ...PEST, home_sqft: null, address_line1: '9 Other Rd' });
    expect(assist().facts).toMatchObject({
      service: 'pest_control', address_line1: '9 Other Rd', city: null, zip: null, home_sqft: null, lot_sqft: null, property_type: null,
    });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'pest_control' });
    expect(mockAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ address_line1: '9 Other Rd', city: null, zip: null }));
    // Values the same read gives for the new place stay.
    await next({ ...PEST, home_sqft: 1800, address_line1: '5 Third Ave', city: 'Venice', zip: '34285', property_type: 'single_family' });
    expect(assist().facts).toMatchObject({ address_line1: '5 Third Ave', city: 'Venice', zip: '34285', home_sqft: 1800, lot_sqft: null, property_type: 'single_family' });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'pest_control', home_sqft: 1800, property_type: 'single_family' });
    // The plan is not tied to the place.
    expect(assist().service).toBe('pest_control');
  });

  test('a change of case, spacing or punctuation is not a switch', async () => {
    mockCreate.mockResolvedValue(reply(HOME));
    await run();
    await next({ ...PEST, home_sqft: null, address_line1: '12  EXAMPLE st.', city: 'bradenton', zip: null });
    expect(assist().facts).toMatchObject({ address_line1: '12 EXAMPLE st.', city: 'bradenton', zip: '34202', home_sqft: 2000, lot_sqft: 9000, property_type: 'condo_ground' });
    expect(mockPricing).toHaveBeenCalledTimes(1);
    expect(mockAvailability).toHaveBeenCalledTimes(1);
  });

  test('a street named for the first time, or a street taken back and given again, keeps what was said', () => {
    const prev = { ...NO_FACTS, home_sqft: 2000, city: 'Bradenton' };
    expect(_test.mergeFacts(prev, { ...NO_FACTS, address_line1: '12 Example St' })).toMatchObject({ home_sqft: 2000, city: 'Bradenton' });
    expect(_test.mergeFacts({ ...NO_FACTS, zip: '34202', home_sqft: 2000 }, { ...NO_FACTS, zip: '34285' })).toMatchObject({ zip: '34285', home_sqft: null });
  });

  test('account facts do not carry onto another street', async () => {
    db.__state.customers = { 'cust-1': { id: 'cust-1', address_line1: '1 Sample Way', lot_sqft: 8000, property_sqft: 3000 } };
    mockCreate.mockResolvedValue(reply({ ...PEST, service: 'lawn_care', home_sqft: null }));
    await run({ customerId: 'cust-1' });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'lawn_care', lot_sqft: 8000, lawn_sqft: 3000 });
    mockMatches.mockReturnValue(false);
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValue(reply({ ...PEST, service: 'lawn_care', home_sqft: null, address_line1: '9 Other Rd', city: 'Venice', zip: '34285' }));
    await run({ customerId: 'cust-1' });
    expect(mockPricing).toHaveBeenLastCalledWith({ service: 'lawn_care' });
    expect(mockAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ address_line1: '9 Other Rd', account: null }));
  });
});

describe('live call assist self-booking gate', () => {
  const schedulingOff = () => isEnabled.mockImplementation((name) => name !== 'selfBooking');
  const SPOKEN = { ...PEST, address_line1: '12 Example St', city: 'Bradenton', zip: '34202' };

  test('cached times are hidden while the gate is off, with no lookup, and come back when it is on', async () => {
    mockCreate.mockResolvedValue(reply(SPOKEN));
    await run();
    expect(assist().times).toContain('9:00 AM');
    const panel = () => assistForPanel({ live_transcription: liveState() });
    expect(panel().times).toContain('9:00 AM');

    schedulingOff();
    // The route's read: the saved times are not served.
    expect(panel()).toMatchObject({ intent: 'Wants quarterly pest control', times: null });
    // The next due run neither reuses them nor looks times up; the price stays.
    mockAvailability.mockClear();
    mockLocate.mockClear();
    speak(1);
    advance(50 * 1000);
    await run();
    expect(mockAvailability).not.toHaveBeenCalled();
    expect(mockLocate).not.toHaveBeenCalled();
    expect(assist().times).toBeNull();
    expect(assist().price).toContain('$99');
    // Same facts, gate still off: still no lookup.
    speak(1);
    advance(50 * 1000);
    await run();
    expect(mockAvailability).not.toHaveBeenCalled();

    isEnabled.mockReturnValue(true);
    speak(1);
    advance(50 * 1000);
    await run();
    expect(mockAvailability).toHaveBeenCalledTimes(1);
    expect(panel().times).toContain('9:00 AM');
  });

  test('a panel with only times shows nothing while the gate is off', () => {
    const meta = { live_transcription: { assist: { runs: 1, at: 'x', times: '2026-11-11 at 9:00 AM' } } };
    expect(assistForPanel(meta)).toMatchObject({ times: '2026-11-11 at 9:00 AM' });
    schedulingOff();
    expect(assistForPanel(meta)).toBeNull();
  });
});

describe('live call assist out-of-order runs', () => {
  const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i += 1) await Promise.resolve(); };
  const OLD = { ...PEST, intent: 'Older read', address_line1: '12 Example St', city: 'Bradenton', zip: '34202' };
  const NEW = { ...PEST, intent: 'Newer read', address_line1: '9 Other Rd', city: 'Venice', zip: '34285' };

  // Run 1 stalls in its price lookup past the 45 s claim gap; run 2 claims, finishes and saves first.
  async function newerFinishesFirst(settleOlder) {
    const slow = deferred();
    mockPricing.mockImplementationOnce(() => slow.promise);
    mockCreate.mockResolvedValueOnce(reply(OLD));
    const older = run();
    await until(() => mockPricing.mock.calls.length === 1);
    expect(assist().runs).toBe(1);
    speak(1);
    advance(50 * 1000);
    mockCreate.mockResolvedValueOnce(reply(NEW));
    mockPricing.mockResolvedValueOnce('Standard pest control pricing: $120 per application on the quarterly plan');
    await expect(run()).resolves.toEqual({ ran: true, saved: true });
    const after = JSON.parse(JSON.stringify(assist()));
    settleOlder(slow);
    const result = await older;
    return { after, result };
  }

  test('an older run that finishes last does not overwrite the newer facts, price and times', async () => {
    const { after, result } = await newerFinishesFirst((slow) => slow.resolve('Standard pest control pricing: $99 per application'));
    expect(after).toMatchObject({ runs: 2, intent: 'Newer read', price: expect.stringContaining('$120') });
    expect(result).toEqual({ ran: true, saved: false });
    expect(assist()).toEqual(after);
    expect(assist().facts.address_line1).toBe('9 Other Rd');
  });

  test("an older run's lookup error leaves the newer state alone too", async () => {
    const { after, result } = await newerFinishesFirst((slow) => slow.reject(new Error('db down')));
    expect(result).toEqual({ ran: true, saved: false });
    expect(assist()).toEqual(after);
    expect(assist().key).toEqual(expect.any(String));
    expect(assist().price).toContain('$120');
  });

  test('a run that finishes in order still saves', async () => {
    await expect(run()).resolves.toEqual({ ran: true, saved: true });
    expect(assist()).toMatchObject({ runs: 1, intent: 'Wants quarterly pest control' });
  });
});

describe('assistForPanel', () => {
  test('text fields only, null while nothing is known', () => {
    expect(assistForPanel({})).toBeNull();
    expect(assistForPanel({ live_transcription: { assist: { runs: 1, at: 'x', caller_count: 2 } } })).toBeNull();
    expect(assistForPanel({ live_transcription: { assist: { runs: 1, at: 'x', intent: 'Wants pest control', key: 'k', facts: { city: 'X' } } } }))
      .toEqual({ intent: 'Wants pest control', price: null, times: null, at: 'x' });
  });
});
