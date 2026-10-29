/**
 * GATE_ASSISTANT_ROUTE_TIMES (owner 2026-10-29, Route Check Everywhere build 3c).
 * The portal assistant's check_availability and the text drafter's city-based
 * OPEN TIMES fallback read the customer pages' time list instead of the by-city
 * zone finder, in the finder's response shape.
 *
 *   off     the new list is never built (spies)
 *   shadow  the old list is served; the new one is compared after the answer
 *   true    the new list is served in the old shape; no pin / error / slow -> old
 *
 * The text drafter quotes and later re-checks a time: both must use the engine
 * that made the quote, whatever the gate says by then.
 *
 * No DB, no network: the finder, the pin reader and the customer pages' builder
 * are mocked.
 */
const GATE = 'GATE_ASSISTANT_ROUTE_TIMES';
const REAL_ANSWERS = 'GATE_SMS_REAL_ANSWERS';
const MULTI_TECH = 'GATE_MULTI_TECH_TEXT_TIMES';
const ALL = [GATE, REAL_ANSWERS, MULTI_TECH];
const prior = Object.fromEntries(ALL.map((g) => [g, process.env[g]]));

const OLD_DAYS = [
  { date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, month: 'Nov', fullDate: 'Monday, November 2', zone: 'Zone A',
    slots: [{ start: '9:00 AM', end: '10:00 AM', startTime24: '09:00', endTime24: '10:00' }, { start: '2:00 PM', end: '3:00 PM', startTime24: '14:00', endTime24: '15:00' }] },
  { date: '2026-11-03', dayOfWeek: 'Tue', dayNum: 3, month: 'Nov', fullDate: 'Tuesday, November 3', zone: 'Zone A',
    slots: [{ start: '10:00 AM', end: '11:00 AM', startTime24: '10:00', endTime24: '11:00' }] },
];

// The customer pages' day shape: per-technician slots with page-only fields.
const slot = (start24, end24, startLabel, endLabel, tech, extra = {}) => ({
  start_time: start24, end_time: end24, startTime24: start24, endTime24: end24, start: startLabel, end: endLabel,
  technician_id: tech, slot_sig: `sig-${tech}-${start24}`, rank: 1, ...extra,
});
const NEW_DAYS = [
  { date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, month: 'Nov', fullDate: 'Monday, November 2', nearby: true,
    slots: [slot('09:00', '10:00', '9:00 AM', '10:00 AM', 't1'), slot('09:00', '10:00', '9:00 AM', '10:00 AM', 't2'), slot('11:00', '12:00', '11:00 AM', '12:00 PM', 't1')] },
  { date: '2026-11-04', dayOfWeek: 'Wed', dayNum: 4, month: 'Nov', fullDate: 'Wednesday, November 4', nearby: false,
    slots: [slot('13:00', '14:00', '1:00 PM', '2:00 PM', 't2')] },
];

let logger;
let oldFinder;
let resolveTextOfferPin;
let availabilityForPin;
let funnelKeyForEstimateId;
let placeMovedVisit;
let routeTimes;

function infoLines() {
  return logger.info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[assistant-route-times]'));
}

beforeEach(() => {
  ALL.forEach((g) => delete process.env[g]);
  jest.resetModules();
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  oldFinder = jest.fn().mockResolvedValue({ zone: 'Zone A', days: OLD_DAYS });
  resolveTextOfferPin = jest.fn().mockResolvedValue({ lat: 27.1, lng: -82.4, source: 'customer' });
  availabilityForPin = jest.fn().mockResolvedValue({ days: NEW_DAYS, slots: [] });
  funnelKeyForEstimateId = jest.fn().mockResolvedValue('lawn_care');
  placeMovedVisit = jest.fn().mockResolvedValue([]);
  jest.doMock('../services/logger', () => logger);
  jest.doMock('../models/db', () => jest.fn());
  jest.doMock('../services/availability', () => ({ getAvailableSlots: oldFinder }));
  jest.doMock('../services/scheduling/text-offer-times', () => ({ resolveTextOfferPin, textOfferDays: jest.fn() }));
  jest.doMock('../routes/booking', () => ({ _internals: { availabilityForPin } }));
  jest.doMock('../services/estimate-converter', () => ({ funnelKeyForEstimateId }));
  jest.doMock('../services/scheduling/arrival-route', () => ({ placeMovedVisit }));
  routeTimes = require('../services/scheduling/assistant-route-times');
});
afterEach(() => {
  ['../services/logger', '../models/db', '../services/availability', '../services/scheduling/text-offer-times', '../routes/booking',
    '../services/estimate-converter', '../services/scheduling/arrival-route'].forEach((m) => jest.dontMock(m));
  jest.useRealTimers();
  jest.resetModules();
});
afterAll(() => ALL.forEach((g) => { if (prior[g] === undefined) delete process.env[g]; else process.env[g] = prior[g]; }));

describe('assistantRouteTimesMode', () => {
  test('unset or any other value is off; shadow and true are read at call time', () => {
    const gates = require('../config/feature-gates');
    expect(gates.assistantRouteTimesMode()).toBe('off');
    process.env[GATE] = 'false';
    expect(gates.assistantRouteTimesMode()).toBe('off');
    process.env[GATE] = 'on';
    expect(gates.assistantRouteTimesMode()).toBe('off');
    process.env[GATE] = ' Shadow ';
    expect(gates.assistantRouteTimesMode()).toBe('shadow');
    expect(routeTimes.assistantRouteTimesMode()).toBe('shadow');
    process.env[GATE] = 'true';
    expect(gates.assistantRouteTimesMode()).toBe('on');
    expect(routeTimes.assistantRouteTimesMode()).toBe('on');
  });

  test('a partial mock of the gates module reads as off', () => {
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false }));
    const adapter = require('../services/scheduling/assistant-route-times');
    process.env[GATE] = 'true';
    expect(adapter.assistantRouteTimesMode()).toBe('off');
    jest.dontMock('../config/feature-gates');
  });
});

describe('serveAssistantTimes — the assistant', () => {
  const run = (extra = {}) => routeTimes.serveAssistantTimes({
    surface: 'assistant', customerId: 'cust-1', estimateId: undefined,
    loadOld: () => oldFinder('Venice', undefined, { customerId: 'cust-1' }), ...extra,
  });

  test('off: the old finder answers and the new list is never built', async () => {
    const out = await run();
    expect(out).toEqual({ engine: 'old', result: { zone: 'Zone A', days: OLD_DAYS } });
    expect(oldFinder).toHaveBeenCalledTimes(1);
    expect(resolveTextOfferPin).not.toHaveBeenCalled();
    expect(availabilityForPin).not.toHaveBeenCalled();
    expect(funnelKeyForEstimateId).not.toHaveBeenCalled();
    expect(infoLines()).toEqual([]);
  });

  test('shadow: serves the old list, then logs one line with the difference', async () => {
    process.env[GATE] = 'shadow';
    const out = await run();
    expect(out.engine).toBe('old');
    expect(out.result).toEqual({ zone: 'Zone A', days: OLD_DAYS });
    await out.settled;
    expect(availabilityForPin).toHaveBeenCalledWith({ lat: 27.1, lng: -82.4, serviceKey: 'pest_control' });
    // old: 11/02 09:00, 11/02 14:00, 11/03 10:00. new: 11/02 09:00, 11/02 11:00, 11/04 13:00.
    const lines = infoLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[assistant-route-times\] surface=assistant mode=shadow old=3 new=3 both=1 only_old=2 only_new=2 ms=\d+$/);
  });

  test('shadow: the reply does not wait for the new list', async () => {
    process.env[GATE] = 'shadow';
    availabilityForPin.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    const out = await run();
    expect(out.result.days).toBe(OLD_DAYS);
    jest.advanceTimersByTime(routeTimes.SHADOW_BUDGET_MS + 10);
    await out.settled;
    expect(infoLines()[0]).toMatch(/new=- reason=timeout/);
  });

  test('shadow: a new list that cannot build is logged and the old list is still served', async () => {
    process.env[GATE] = 'shadow';
    resolveTextOfferPin.mockResolvedValue({ lat: 1, lng: 2, source: 'city_table' });
    const out = await run();
    await out.settled;
    expect(out.result.days).toBe(OLD_DAYS);
    expect(availabilityForPin).not.toHaveBeenCalled();
    expect(infoLines()[0]).toMatch(/old=3 new=- reason=no_pin/);
  });

  test('true: the customer pages\' list in the old shape, one slot per distinct start, no page-only fields', async () => {
    process.env[GATE] = 'true';
    const out = await run();
    expect(out.engine).toBe('route_times');
    expect(oldFinder).not.toHaveBeenCalled();
    expect(out.result).toEqual({
      zone: null,
      days: [
        { date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, month: 'Nov', fullDate: 'Monday, November 2', zone: null,
          slots: [{ start: '9:00 AM', end: '10:00 AM', startTime24: '09:00', endTime24: '10:00' }, { start: '11:00 AM', end: '12:00 PM', startTime24: '11:00', endTime24: '12:00' }] },
        { date: '2026-11-04', dayOfWeek: 'Wed', dayNum: 4, month: 'Nov', fullDate: 'Wednesday, November 4', zone: null,
          slots: [{ start: '1:00 PM', end: '2:00 PM', startTime24: '13:00', endTime24: '14:00' }] },
      ],
    });
    // Same keys the old finder's days carry.
    expect(Object.keys(out.result.days[0]).sort()).toEqual(Object.keys(OLD_DAYS[0]).sort());
    expect(Object.keys(out.result.days[0].slots[0]).sort()).toEqual(Object.keys(OLD_DAYS[0].slots[0]).sort());
  });

  test('true: the funnel service comes from the estimate when one is given; an unrepresentable estimate uses the old finder', async () => {
    process.env[GATE] = 'true';
    await run({ estimateId: 'est-1' });
    expect(funnelKeyForEstimateId).toHaveBeenCalledWith('est-1');
    expect(availabilityForPin).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'lawn_care' }));
    funnelKeyForEstimateId.mockResolvedValue('');
    availabilityForPin.mockClear();
    const out = await run({ estimateId: 'est-2' });
    expect(out.engine).toBe('old');
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('true: no customer, no pin of the customer\'s own, or a page that offers nothing -> the old finder', async () => {
    process.env[GATE] = 'true';
    expect((await run({ customerId: null })).engine).toBe('old');
    expect(resolveTextOfferPin).not.toHaveBeenCalled();
    resolveTextOfferPin.mockResolvedValueOnce(null);
    expect((await run()).engine).toBe('old');
    resolveTextOfferPin.mockResolvedValueOnce({ lat: 1, lng: 2, source: 'zone_centre' });
    expect((await run()).engine).toBe('old');
    availabilityForPin.mockResolvedValueOnce(null);
    expect((await run()).engine).toBe('old');
    expect(availabilityForPin).toHaveBeenCalledTimes(1);
    expect(oldFinder).toHaveBeenCalledTimes(4);
  });

  test('true: any error -> the old finder, and it never throws', async () => {
    process.env[GATE] = 'true';
    availabilityForPin.mockRejectedValueOnce(new Error('boom'));
    const out = await run();
    expect(out.engine).toBe('old');
    expect(out.result.days).toBe(OLD_DAYS);
    resolveTextOfferPin.mockRejectedValueOnce(new Error('pin boom'));
    expect((await run()).engine).toBe('old');
  });

  test('true: a list slower than the 1.5 s cap -> the old finder', async () => {
    process.env[GATE] = 'true';
    availabilityForPin.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    const pending = run();
    await jest.advanceTimersByTimeAsync(routeTimes.SERVED_BUDGET_MS + 10);
    const out = await pending;
    expect(out.engine).toBe('old');
    expect(routeTimes.SERVED_BUDGET_MS).toBe(1500);
  });
});

describe('check_availability tool', () => {
  const callTool = async (input = { city: 'Venice' }) => {
    const { executeToolCall } = require('../services/ai-assistant/tools-expanded');
    return executeToolCall('check_availability', input, 'cust-1');
  };
  const mapped = (days) => days.map((d) => ({ date: d.date, dayOfWeek: d.dayOfWeek, slots: d.slots.map((s) => ({ start: s.start, end: s.end, display: undefined })) }));

  test('off and shadow answer with the old finder\'s list; true answers with the new list in the same tool shape', async () => {
    expect(await callTool()).toEqual({ zone: null, days: mapped(OLD_DAYS), message: null });
    expect(availabilityForPin).not.toHaveBeenCalled();
    process.env[GATE] = 'shadow';
    expect(await callTool()).toEqual({ zone: null, days: mapped(OLD_DAYS), message: null });
    process.env[GATE] = 'true';
    oldFinder.mockClear();
    const out = await callTool();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(out).toEqual({
      zone: null, message: null,
      days: [
        { date: '2026-11-02', dayOfWeek: 'Mon', slots: [{ start: '9:00 AM', end: '10:00 AM', display: undefined }, { start: '11:00 AM', end: '12:00 PM', display: undefined }] },
        { date: '2026-11-04', dayOfWeek: 'Wed', slots: [{ start: '1:00 PM', end: '2:00 PM', display: undefined }] },
      ],
    });
  });

  test('the finder is called with the same arguments as before in every mode it runs', async () => {
    await callTool({ city: 'Venice', estimate_id: 'est-9' });
    expect(oldFinder).toHaveBeenLastCalledWith('Venice', 'est-9', { customerId: 'cust-1' });
    process.env[GATE] = 'shadow';
    await callTool({ city: 'Venice' });
    expect(oldFinder).toHaveBeenLastCalledWith('Venice', undefined, { customerId: 'cust-1' });
  });
});

describe('book_appointment placement (confirmBooking)', () => {
  test('off and shadow never place; true places the new visit inside the transaction with the staff placement helper', async () => {
    const trx = { isTransaction: true };
    await expect(routeTimes.placeAssistantBooking(trx, 'visit-1')).resolves.toBeNull();
    process.env[GATE] = 'shadow';
    await expect(routeTimes.placeAssistantBooking(trx, 'visit-1')).resolves.toBeNull();
    expect(placeMovedVisit).not.toHaveBeenCalled();
    process.env[GATE] = 'true';
    await routeTimes.placeAssistantBooking(trx, 'visit-1');
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'visit-1', source: 'assistant_booking' });
    placeMovedVisit.mockClear();
    await routeTimes.placeAssistantBooking(trx, null);
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });

  test('confirmBooking places right after the visit insert and before the inspection credit, on the same transaction', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/availability.js'), 'utf8');
    const insert = src.indexOf("await trx('scheduled_services').insert({");
    const place = src.indexOf('placeAssistantBooking(trx, scheduledRow.id)');
    const credit = src.indexOf('markBookingForInspectionCredit(trx');
    expect(insert).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(insert);
    expect(credit).toBeGreaterThan(place);
  });
});

describe('text drafter — quote and re-check use one engine', () => {
  const CUSTOMER_CONTEXT = { customer: { id: 'cust-1' } };
  const quoteArgs = { serviceType: 'Pest Control', estimateId: null, city: 'Venice', context: CUSTOMER_CONTEXT };
  let drafter;

  beforeEach(() => {
    process.env[REAL_ANSWERS] = 'true';
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    drafter = require('../services/sms-shadow-drafter');
  });
  afterEach(() => jest.dontMock('../services/call-booking-catalog'));

  const offeredFrom = async (offer) => {
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true, schedulerOffer: offer });
    return out;
  };
  const snapshotOf = (out, schedulerOffer) => drafter.computeOpenTimesSnapshot({
    openTimesBlock: out.block, offeredTimes: [{ date: out.days[0].date, window: out.days[0].windows[0] }],
    city: 'Venice', customerId: 'cust-1', estimateId: null, serviceType: 'Pest Control', schedulerOffer,
  });
  const recheck = (snapshot) => drafter.openTimesStillOffered({
    city: snapshot.lookup.city, customerId: snapshot.lookup.customerId, estimateId: snapshot.lookup.estimateId,
    serviceType: snapshot.lookup.serviceType,
    ...(snapshot.lookup.source ? { source: snapshot.lookup.source } : {}),
    ...(snapshot.lookup.serviceKey ? { serviceKey: snapshot.lookup.serviceKey } : {}),
    quotedWindows: snapshot.quotedWindows,
  });

  test('off: no route offer, the old finder quotes, the snapshot has no stamp, and nothing new is built', async () => {
    const offer = await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs });
    expect(offer).toBeNull();
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    const snapshot = snapshotOf(out, null);
    expect(snapshot.lookup).toEqual({ city: 'Venice', customerId: 'cust-1', estimateId: null, serviceType: 'Pest Control' });
    expect(resolveTextOfferPin).not.toHaveBeenCalled();
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('true: a customer with a pin is quoted from the route list; the snapshot stamps it and the recheck uses it even after the gate is unset', async () => {
    process.env[GATE] = 'true';
    const offer = await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs });
    expect(offer).toMatchObject({ source: 'route_times', serviceKey: 'pest_control', city: 'Venice' });
    const out = await offeredFrom(offer);
    expect(oldFinder).not.toHaveBeenCalled();
    expect(availabilityForPin).toHaveBeenCalledTimes(1); // the quote's own list is reused, not rebuilt
    expect(out.days[0].date).toBe('Monday, November 2');
    const snapshot = snapshotOf(out, offer);
    expect(snapshot.lookup).toEqual({
      city: 'Venice', customerId: 'cust-1', estimateId: null, serviceType: 'Pest Control', source: 'route_times', serviceKey: 'pest_control',
    });
    expect(JSON.stringify(snapshot)).not.toContain('preloadedDays');

    delete process.env[GATE];
    availabilityForPin.mockClear();
    await expect(recheck(snapshot)).resolves.toEqual({ ok: true });
    expect(availabilityForPin).toHaveBeenCalledTimes(1);
    expect(oldFinder).not.toHaveBeenCalled();

    // The list moved on: the quoted time is gone, and the route list says so.
    availabilityForPin.mockResolvedValue({ days: [NEW_DAYS[1]] });
    await expect(recheck(snapshot)).resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('shadow quote: the old finder quotes with no stamp and is re-checked on the old finder even after the gate flips to true', async () => {
    process.env[GATE] = 'shadow';
    expect(await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs })).toBeNull();
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    await new Promise((resolve) => setImmediate(resolve));
    const snapshot = snapshotOf(out, null);
    expect(snapshot.lookup.source).toBeUndefined();
    const shadowLines = logger.info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('surface=sms_drafter mode=shadow'));
    expect(shadowLines).toHaveLength(1);
    expect(shadowLines[0]).toMatch(/old=\d+ new=\d+ both=\d+ only_old=\d+ only_new=\d+ ms=\d+/);

    process.env[GATE] = 'true';
    availabilityForPin.mockClear();
    oldFinder.mockClear();
    await expect(recheck(snapshot)).resolves.toEqual({ ok: true });
    expect(oldFinder).toHaveBeenCalledTimes(1);
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('true: no customer, no pin or an error -> no route offer, so the old finder quotes with no stamp', async () => {
    process.env[GATE] = 'true';
    expect(await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs, context: {} })).toBeNull();
    expect(resolveTextOfferPin).not.toHaveBeenCalled();
    resolveTextOfferPin.mockResolvedValueOnce(null);
    expect(await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs })).toBeNull();
    availabilityForPin.mockRejectedValueOnce(new Error('boom'));
    expect(await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs })).toBeNull();
    expect(await drafter.cityFallbackOfferFor({ eligible: false, ...quoteArgs })).toBeNull();
    // A named service /book does not book has no key: the old finder keeps it.
    availabilityForPin.mockClear();
    expect(await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs, serviceType: 'Actual Bait Station Visit' })).toBeNull();
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('a route-list recheck that cannot build fails closed', async () => {
    process.env[GATE] = 'true';
    const offer = await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs });
    const snapshot = snapshotOf(await offeredFrom(offer), offer);
    resolveTextOfferPin.mockResolvedValue(null);
    await expect(recheck(snapshot)).resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
    resolveTextOfferPin.mockRejectedValue(new Error('pin down'));
    await expect(recheck(snapshot)).resolves.toMatchObject({ ok: false });
  });

  test('with GATE_MULTI_TECH_TEXT_TIMES on, that gate\'s website engine keeps the fallback', async () => {
    process.env[GATE] = 'true';
    process.env[MULTI_TECH] = 'true';
    const offer = await drafter.cityFallbackOfferFor({ eligible: true, ...quoteArgs });
    expect(offer).toMatchObject({ source: 'website_engine' });
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('a route_times snapshot is no actionable offer: the offer ledger and suggest mode treat it like the old finder\'s', () => {
    const { KIND_BY_SOURCE } = require('../services/sms-offers');
    expect(KIND_BY_SOURCE.route_times).toBeUndefined();
    const { isPickerOfferSnapshot } = require('../services/sms-suggest-mode');
    expect(isPickerOfferSnapshot({
      quotedWindows: [{ date: 'Monday, November 2', window: '9:00 AM - 11:00 AM' }],
      lookup: { source: 'route_times', serviceKey: 'pest_control' },
    })).toBe(false);
  });
});

describe('the other old-engine callers', () => {
  test('lead-response-tools and the estimate converter still follow GATE_MULTI_TECH_TEXT_TIMES only', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['../services/lead-response-tools.js', '../services/estimate-converter.js']) {
      expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).not.toMatch(/assistantRouteTimes|assistant-route-times/);
    }
  });
});
