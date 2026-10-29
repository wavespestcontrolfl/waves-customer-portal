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
let bookableOfferCustomer;
let geocoders;
let visits;
let findConflictingVisits;
let zoneOccupied;
let resolveZone;
let isBlackoutDate;
let violatesSelfServeNotice;
const NO_PIN_CUSTOMER = { id: 'cust-1', latitude: null, longitude: null, address_line1: '1 Main St', city: 'Venice', state: 'FL', zip: '34285' };
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
  bookableOfferCustomer = jest.fn().mockResolvedValue({ id: 'cust-1', latitude: '27.1', longitude: '-82.4' });
  // Every way a pin could be geocoded: none may run (the plan's $0 promise).
  geocoders = {
    customerBookingLocation: jest.fn().mockResolvedValue({ lat: 27.5, lng: -82.5 }),
    resolveServiceLocation: jest.fn().mockResolvedValue({ lat: 27.5, lng: -82.5 }),
    reviewedServiceLocation: jest.fn().mockResolvedValue(null),
    resolveTextOfferPin: jest.fn().mockResolvedValue({ lat: 27.5, lng: -82.5, source: 'customer' }),
  };
  availabilityForPin = jest.fn().mockResolvedValue({ days: NEW_DAYS, slots: [] });
  funnelKeyForEstimateId = jest.fn().mockResolvedValue('lawn_care');
  placeMovedVisit = jest.fn().mockResolvedValue([]);
  jest.doMock('../services/logger', () => logger);
  // The zone check's occupied set, loaded by confirmBooking's own loader (shared as loadZoneOccupied).
  zoneOccupied = jest.fn(async () => []);
  resolveZone = jest.fn(async () => null);
  jest.doMock('../services/availability', () => ({ getAvailableSlots: oldFinder, resolveZone, loadZoneOccupied: zoneOccupied }));
  jest.doMock('../services/scheduling/text-offer-times', () => ({ resolveTextOfferPin: geocoders.resolveTextOfferPin, textOfferDays: jest.fn() }));
  jest.doMock('../services/scheduling/day-stops', () => ({ resolveServiceLocation: geocoders.resolveServiceLocation }));
  jest.doMock('../services/customer-geocode-review', () => ({ reviewedServiceLocation: geocoders.reviewedServiceLocation }));
  jest.doMock('../routes/booking', () => ({
    _internals: {
      availabilityForPin,
      bookableOfferCustomer,
      customerBookingLocation: geocoders.customerBookingLocation,
      storedBookingPin: (c) => {
        const pair = [c?.latitude, c?.longitude];
        if (pair.some((v) => v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) === 0)) return null;
        return { lat: Number(pair[0]), lng: Number(pair[1]) };
      },
    },
  }));
  jest.doMock('../services/estimate-converter', () => ({ funnelKeyForEstimateId }));
  jest.doMock('../services/scheduling/arrival-route', () => ({ placeMovedVisit }));
  // confirmBooking's own commit probe, modelled on its real semantics: TECHNICIAN-BLIND (any
  // technician's visit overlapping the window refuses it), half-open overlap.
  visits = [];
  findConflictingVisits = jest.fn(async ({ date, windowStart, windowEnd }) => visits.filter((v) => v.date === date
    && v.start < windowEnd && v.end > windowStart));
  isBlackoutDate = jest.fn(async () => false);
  violatesSelfServeNotice = jest.fn(() => false);
  jest.doMock('../services/scheduling/occupancy', () => ({ findConflictingVisits }));
  jest.doMock('../services/scheduling/blackout-dates', () => ({ isBlackoutDate }));
  jest.doMock('../services/scheduling/self-serve-notice', () => ({ violatesSelfServeNotice }));
  jest.doMock('../services/scheduling/travel-gap', () => ({ travelGapEnabled: () => false }));
  jest.doMock('../services/scheduling/expected-service-minutes', () => ({ expectedServiceMinutes: jest.fn() }));
  jest.doMock('../models/db', () => jest.fn((table) => ({
    first: async () => (table === 'booking_config' ? { slot_duration_minutes: 60 } : null),
    where: () => ({ first: async () => ({ service_interest: 'Lawn Care' }) }),
  })));
  routeTimes = require('../services/scheduling/assistant-route-times');
});
afterEach(() => {
  ['../services/logger', '../models/db', '../services/availability', '../services/scheduling/text-offer-times', '../routes/booking',
    '../services/estimate-converter', '../services/scheduling/arrival-route', '../services/scheduling/day-stops', '../services/customer-geocode-review', '../services/scheduling/occupancy',
    '../services/scheduling/blackout-dates', '../services/scheduling/self-serve-notice', '../services/scheduling/travel-gap',
    '../services/scheduling/expected-service-minutes'].forEach((m) => jest.dontMock(m));
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
    expect(bookableOfferCustomer).not.toHaveBeenCalled();
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
    expect(availabilityForPin).toHaveBeenCalledWith({ lat: 27.1, lng: -82.4, serviceKey: 'pest_control', providerTravel: false, appendOnly: true });
    // old: 11/02 09:00, 11/02 14:00, 11/03 10:00. new: 11/02 09:00, 11/02 11:00, 11/04 13:00.
    const lines = infoLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[assistant-route-times\] surface=assistant mode=shadow old=3 new=3 both=1 only_old=2 only_new=2 commit_dropped=0 ms=\d+$/);
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
    bookableOfferCustomer.mockResolvedValue(NO_PIN_CUSTOMER);
    const out = await run();
    await out.settled;
    expect(out.result.days).toBe(OLD_DAYS);
    expect(availabilityForPin).not.toHaveBeenCalled();
    expect(infoLines()[0]).toMatch(/old=3 new=- reason=no_stored_pin/);
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
    expect(bookableOfferCustomer).not.toHaveBeenCalled();
    bookableOfferCustomer.mockResolvedValueOnce(null);
    expect((await run()).engine).toBe('old');
    bookableOfferCustomer.mockResolvedValueOnce(NO_PIN_CUSTOMER);
    expect((await run()).engine).toBe('old');
    bookableOfferCustomer.mockResolvedValueOnce({ id: 'cust-1', latitude: 0, longitude: 0 });
    expect((await run()).engine).toBe('old');
    availabilityForPin.mockResolvedValueOnce(null);
    expect((await run()).engine).toBe('old');
    expect(availabilityForPin).toHaveBeenCalledTimes(1);
    expect(oldFinder).toHaveBeenCalledTimes(5);
  });

  test('true: any error -> the old finder, and it never throws', async () => {
    process.env[GATE] = 'true';
    availabilityForPin.mockRejectedValueOnce(new Error('boom'));
    const out = await run();
    expect(out.engine).toBe('old');
    expect(out.result.days).toBe(OLD_DAYS);
    bookableOfferCustomer.mockRejectedValueOnce(new Error('pin boom'));
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
    expect(bookableOfferCustomer).not.toHaveBeenCalled();
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
    expect(bookableOfferCustomer).not.toHaveBeenCalled();
    bookableOfferCustomer.mockResolvedValueOnce(NO_PIN_CUSTOMER);
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
    bookableOfferCustomer.mockResolvedValue(NO_PIN_CUSTOMER);
    await expect(recheck(snapshot)).resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
    bookableOfferCustomer.mockRejectedValue(new Error('pin down'));
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

describe('no geocode, ever: a customer without a stored pin is served the old list in every mode', () => {
  const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const expectNoGeocode = () => {
    Object.values(geocoders).forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(availabilityForPin).not.toHaveBeenCalled();
  };
  const noPinLines = () => infoLines().filter((l) => l.includes('new=- reason=no_stored_pin'));

  test.each(['shadow', 'true'])('check_availability, %s: the old list is served and no geocoder runs', async (mode) => {
    process.env[GATE] = mode;
    bookableOfferCustomer.mockResolvedValue(NO_PIN_CUSTOMER);
    const { executeToolCall } = require('../services/ai-assistant/tools-expanded');
    const out = await executeToolCall('check_availability', { city: 'Venice' }, 'cust-1');
    await flush();
    expect(out.days.map((d) => d.date)).toEqual(OLD_DAYS.map((d) => d.date));
    expect(oldFinder).toHaveBeenCalledTimes(1);
    expectNoGeocode();
    if (mode === 'shadow') expect(noPinLines()).toHaveLength(1);
  });

  test.each(['shadow', 'true'])('text drafter, %s: the old finder quotes and rechecks, and no geocoder runs', async (mode) => {
    process.env[GATE] = mode;
    process.env[REAL_ANSWERS] = 'true';
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    const drafter = require('../services/sms-shadow-drafter');
    bookableOfferCustomer.mockResolvedValue(NO_PIN_CUSTOMER);
    const offer = await drafter.cityFallbackOfferFor({
      eligible: true, serviceType: 'Pest Control', estimateId: null, city: 'Venice', context: { customer: { id: 'cust-1' } },
    });
    expect(offer).toBeNull();
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    await flush();
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(out.days[0].date).toBe('Monday, November 2');
    expectNoGeocode();
    if (mode === 'shadow') expect(noPinLines()).toHaveLength(1);
    jest.dontMock('../services/call-booking-catalog');
  });

  test('a customer WITH a stored pin is offered from it without any geocoder either', async () => {
    process.env[GATE] = 'true';
    const out = await routeTimes.serveAssistantTimes({ customerId: 'cust-1', loadOld: () => oldFinder() });
    expect(out.engine).toBe('route_times');
    expect(availabilityForPin).toHaveBeenCalledWith({ lat: 27.1, lng: -82.4, serviceKey: 'pest_control', providerTravel: false, appendOnly: true });
    Object.values(geocoders).forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
});

describe('offer == commit: the assistant\'s list is filtered against confirmBooking\'s own constraints', () => {
  // Technician A has a visit 09:00-10:00; B is free then. The customer pages offer per technician,
  // so 09:00 is listed (B), 11:00 is free for both.
  const TWO_TECH_DAYS = [
    { date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, month: 'Nov', fullDate: 'Monday, November 2', slots: [
      slot('09:00', '10:00', '9:00 AM', '10:00 AM', 'tB'),
      slot('11:00', '12:00', '11:00 AM', '12:00 PM', 'tA'), slot('11:00', '12:00', '11:00 AM', '12:00 PM', 'tB'),
    ] },
    { date: '2026-11-03', dayOfWeek: 'Tue', dayNum: 3, month: 'Nov', fullDate: 'Tuesday, November 3', slots: [
      slot('13:00', '14:00', '1:00 PM', '2:00 PM', 'tB'),
    ] },
  ];
  const startsOf = (result) => result.days.map((d) => [d.date, d.slots.map((x) => x.startTime24)]);
  const run = () => routeTimes.serveAssistantTimes({ customerId: 'cust-1', loadOld: () => oldFinder() });

  beforeEach(() => {
    availabilityForPin.mockResolvedValue({ days: TWO_TECH_DAYS });
    visits.push({ technician_id: 'A', date: '2026-11-02', start: '09:00', end: '10:00' });
  });

  test('true: A busy at 09:00 and B free -> 09:00 is NOT offered (the commit would refuse it); a start free for both stays', async () => {
    process.env[GATE] = 'true';
    const out = await run();
    expect(out.engine).toBe('route_times');
    expect(startsOf(out.result)).toEqual([['2026-11-02', ['11:00']], ['2026-11-03', ['13:00']]]);
    // The commit's own probe, the way confirmBooking calls it: technician-blind, interviews counted, one slot long.
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-11-02', windowStart: '09:00', windowEnd: '10:00', includeInterviews: true, excludeServiceIds: [],
    }));
    findConflictingVisits.mock.calls.forEach(([args]) => expect(args.technicianId).toBeUndefined());
  });

  test('true: a day whose every start would be refused disappears; if nothing is left the OLD list is served (never an empty picker), logged fallback=old_empty', async () => {
    process.env[GATE] = 'true';
    // Day 1 loses 09:00 and 11:00: one day short of empty is still the new list.
    visits.splice(0, visits.length, { technician_id: 'A', date: '2026-11-02', start: '09:00', end: '12:00' });
    const partial = await run();
    expect(partial.engine).toBe('route_times');
    expect(startsOf(partial.result)).toEqual([['2026-11-03', ['13:00']]]);
    visits.push({ technician_id: 'A', date: '2026-11-03', start: '12:30', end: '13:30' });
    const out = await run();
    expect(out.engine).toBe('old');
    expect(out.result.days).toBe(OLD_DAYS);
    expect(logger.info.mock.calls.map((c) => String(c[0]))).toContain('[assistant-route-times] surface=assistant mode=on served=old fallback=old_empty');
  });

  test('shadow: a list the commit filter would empty is logged as fallback=old_empty', async () => {
    process.env[GATE] = 'shadow';
    visits.splice(0, visits.length, { technician_id: 'A', date: '2026-11-02', start: '08:00', end: '23:00' },
      { technician_id: 'A', date: '2026-11-03', start: '08:00', end: '23:00' });
    const out = await run();
    await out.settled;
    expect(out.engine).toBe('old');
    expect(infoLines()[0]).toMatch(/new=3 .*commit_dropped=3 fallback=old_empty ms=\d+$/);
  });

  test('true: the commit\'s other refusals drop a start too: a closed day, the notice window', async () => {
    process.env[GATE] = 'true';
    visits.length = 0;
    isBlackoutDate.mockImplementation(async (date) => date === '2026-11-03');
    violatesSelfServeNotice.mockImplementation(({ date, startTime }) => date === '2026-11-02' && startTime === '11:00');
    const out = await run();
    expect(startsOf(out.result)).toEqual([['2026-11-02', ['09:00']]]);
    expect(violatesSelfServeNotice).toHaveBeenCalledWith({ date: '2026-11-02', startTime: '11:00' });
  });

  test('true: the travel pin and expected-minutes credit ride along exactly like confirmBooking\'s probe', async () => {
    process.env[GATE] = 'true';
    jest.resetModules();
    jest.doMock('../services/scheduling/travel-gap', () => ({ travelGapEnabled: () => true }));
    const expectedServiceMinutes = jest.fn().mockResolvedValue(45);
    jest.doMock('../services/scheduling/expected-service-minutes', () => ({ expectedServiceMinutes }));
    const adapter = require('../services/scheduling/assistant-route-times');
    await adapter.serveAssistantTimes({ customerId: 'cust-1', estimateId: 'est-1', loadOld: () => oldFinder() });
    expect(expectedServiceMinutes).toHaveBeenCalledWith(expect.anything(), { serviceType: 'Lawn Care', windowMinutes: 60 });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ travel: { lat: '27.1', lng: '-82.4', expectedMinutes: 45 } }));
  });

  test('true: a commit check that fails or is slow serves the old list, never an unchecked new one', async () => {
    process.env[GATE] = 'true';
    findConflictingVisits.mockRejectedValueOnce(new Error('db down'));
    expect((await run()).engine).toBe('old');
    findConflictingVisits.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    const pending = run();
    await jest.advanceTimersByTimeAsync(3000);
    expect((await pending).engine).toBe('old');
  });

  describe('the unlinked self-booking (confirmBooking\'s zone check)', () => {
    const ZONE = { id: 'zone-1', zone_name: 'Zone A', cities: ['Venice'] };
    const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

    beforeEach(() => {
      visits.length = 0;
      bookableOfferCustomer.mockResolvedValue({ id: 'cust-1', latitude: '27.1', longitude: '-82.4', city: 'Venice' });
      resolveZone.mockResolvedValue(ZONE);
      // A legacy self_booked_appointments row with no dispatch visit, 10:00-11:00 on 11/02, in the zone.
      // Only the zone loader sees it; the technician-blind visit probe does not.
      zoneOccupied.mockImplementation(async (conn, zone, date) => (zone === ZONE && date === '2026-11-02'
        ? [{ start: minutes('10:00'), end: minutes('11:00') }] : []));
      availabilityForPin.mockResolvedValue({ days: [{
        date: '2026-11-02', dayOfWeek: 'Mon', dayNum: 2, month: 'Nov', fullDate: 'Monday, November 2',
        slots: [slot('09:00', '10:00', '9:00 AM', '10:00 AM', 'tA'), slot('10:00', '11:00', '10:00 AM', '11:00 AM', 'tB'), slot('13:00', '14:00', '1:00 PM', '2:00 PM', 'tB')],
      }] });
    });

    test('true: 10:00 is not offered (the commit would answer SLOT_TAKEN); other starts stay; the loader is confirmBooking\'s own', async () => {
      process.env[GATE] = 'true';
      const out = await run();
      expect(out.engine).toBe('route_times');
      expect(startsOf(out.result)).toEqual([['2026-11-02', ['09:00', '13:00']]]);
      expect(resolveZone).toHaveBeenCalledWith('Venice');
      expect(zoneOccupied).toHaveBeenCalledTimes(1); // once per date
      expect(zoneOccupied).toHaveBeenCalledWith(expect.anything(), ZONE, '2026-11-02');
    });

    test('shadow: counted in commit_dropped, old list served', async () => {
      process.env[GATE] = 'shadow';
      const out = await run();
      await out.settled;
      expect(out.engine).toBe('old');
      expect(infoLines()[0]).toMatch(/new=3 .*commit_dropped=1 ms=\d+$/);
    });

    test('a customer outside every zone skips the zone check, as confirmBooking does', async () => {
      process.env[GATE] = 'true';
      resolveZone.mockResolvedValue(null);
      const out = await run();
      expect(startsOf(out.result)).toEqual([['2026-11-02', ['09:00', '10:00', '13:00']]]);
      expect(zoneOccupied).not.toHaveBeenCalled();
    });

    test('a zone loader failure serves the old list', async () => {
      process.env[GATE] = 'true';
      zoneOccupied.mockRejectedValue(new Error('db down'));
      expect((await run()).engine).toBe('old');
    });
  });

  test('shadow: serves the old list and logs how many starts the commit filter would drop', async () => {
    process.env[GATE] = 'shadow';
    const out = await run();
    await out.settled;
    expect(out.engine).toBe('old');
    expect(infoLines()[0]).toMatch(/surface=assistant mode=shadow old=3 new=3 both=\d+ only_old=\d+ only_new=\d+ commit_dropped=1 ms=\d+$/);
  });

  test('off: the commit probe never runs', async () => {
    await run();
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('check_availability under true offers the two-technician day without 09:00', async () => {
    process.env[GATE] = 'true';
    const { executeToolCall } = require('../services/ai-assistant/tools-expanded');
    const out = await executeToolCall('check_availability', { city: 'Venice' }, 'cust-1');
    expect(out.days[0].slots.map((x) => x.start)).toEqual(['11:00 AM']);
  });

  test('the text drafter\'s route quotes are not commit-filtered: a person books them (the offer kind is unknown to the ledger), never confirmBooking', async () => {
    process.env[GATE] = 'true';
    process.env[REAL_ANSWERS] = 'true';
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    const drafter = require('../services/sms-shadow-drafter');
    const offer = await drafter.cityFallbackOfferFor({
      eligible: true, serviceType: 'Pest Control', estimateId: null, city: 'Venice', context: { customer: { id: 'cust-1' } },
    });
    expect(offer.preloadedDays).toBe(TWO_TECH_DAYS);
    expect(findConflictingVisits).not.toHaveBeenCalled();
    jest.dontMock('../services/call-booking-catalog');
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/sms-shadow-drafter.js'), 'utf8');
    expect(src).not.toMatch(/confirmBooking/);
  });
});
