/**
 * GATE_CUSTOMER_ROUTE_CHECK wiring: buildBookingAvailability (every /book,
 * reschedule, re-service, inspection, commercial and voice caller) and the
 * estimate page lists hand their offered slots to the route check ONLY when
 * the gate is not off. Off never loads or calls the helper. Voice is never
 * filtered and never waited on.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
}));
jest.mock('../services/scheduling/customer-route-check', () => ({
  customerRouteCheckMode: jest.fn(() => 'off'),
  filterOfferedSlots: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const routeCheck = require('../services/scheduling/customer-route-check');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const D = etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), 10));
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00', max_self_books_per_day: 3 };

function slot(startTime, rank) {
  return {
    date: D, start_time: startTime, end_time: null, technician: { id: 'tech-1' },
    detour_minutes: 3, stops_that_day: 2, rank, score: 100 - rank, insertion: { after_stop_id: 'stop-1' },
  };
}

function wireDb() {
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
}

const build = (extra = {}) => buildBookingAvailability({
  lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: new Date(), ...extra,
});
// slot_sig carries a mint-time expiry, so two builds never match on it.
const unsigned = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'slot_sig' ? undefined : v)));
const startsOf = (result) => result.days.flatMap((d) => d.slots.map((s) => s.start_time)).sort();

describe('buildBookingAvailability — route check wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireDb();
    listOccupiedWindows.mockResolvedValue([]);
    routeCheck.customerRouteCheckMode.mockReturnValue('off');
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({ slots, report: {} }));
    findAvailableSlots.mockResolvedValue({ slots: [slot('09:00', 1), slot('14:00', 2)], total_feasible: 2 });
  });

  test('gate off: the helper is never called, with or without a surface', async () => {
    const baseline = await build();
    const withSurface = await build({ surface: 'book' });
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
    expect(unsigned(withSurface)).toEqual(unsigned(baseline));
    expect(startsOf(baseline)).toEqual(['09:00', '14:00']);
  });

  test('no surface: the helper is not called even with the gate on', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    await build();
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
  });

  test('on: the offered list is the helper result, and the call carries the surface, pin, duration and excluded visits', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({ slots: slots.filter((s) => s.start_time !== '14:00'), report: {} }));
    const result = await build({ surface: 'reschedule', excludeServiceIds: ['svc-1'] });
    expect(startsOf(result)).toEqual(['09:00']);
    expect(result.slots.map((s) => s.start_time)).toEqual(['09:00']);
    const arg = routeCheck.filterOfferedSlots.mock.calls[0][0];
    expect(arg).toMatchObject({
      surface: 'reschedule', mode: 'on', durationMinutes: 60,
      target: { prospective: { lat: 27.4, lng: -82.4, estimated_duration_minutes: 60 }, excludeServiceIds: ['svc-1'] },
    });
    expect(arg.slots.map((s) => s.start_time).sort()).toEqual(['09:00', '14:00']);
    expect(arg.slots[0]).toMatchObject({ date: D, technician_id: 'tech-1' });
  });

  test('shadow: the helper runs and the served payload equals the gate-off payload', async () => {
    const baseline = await build({ surface: 'book' });
    routeCheck.customerRouteCheckMode.mockReturnValue('shadow');
    const shadow = await build({ surface: 'book' });
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(1);
    expect(routeCheck.filterOfferedSlots.mock.calls[0][0].mode).toBe('shadow');
    expect(unsigned(shadow)).toEqual(unsigned(baseline));
  });

  test('a helper that rejects or returns nothing serves the unfiltered list', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    routeCheck.filterOfferedSlots.mockRejectedValueOnce(new Error('boom'));
    expect(startsOf(await build({ surface: 'book' }))).toEqual(['09:00', '14:00']);
    routeCheck.filterOfferedSlots.mockResolvedValueOnce({});
    expect(startsOf(await build({ surface: 'book' }))).toEqual(['09:00', '14:00']);
  });

  test('voice: never filtered, never awaited, and the check runs in shadow after the answer', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('on');
    let release;
    routeCheck.filterOfferedSlots.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ slots: [], report: {} }); }));
    const result = await build({ surface: 'voice' });
    expect(startsOf(result)).toEqual(['09:00', '14:00']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(1);
    expect(routeCheck.filterOfferedSlots.mock.calls[0][0]).toMatchObject({ surface: 'voice', mode: 'shadow' });
    release();
  });

  test('voice: a rejecting detached check is caught', async () => {
    routeCheck.customerRouteCheckMode.mockReturnValue('shadow');
    routeCheck.filterOfferedSlots.mockRejectedValue(new Error('boom'));
    const result = await build({ surface: 'voice' });
    expect(startsOf(result)).toEqual(['09:00', '14:00']);
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('voice: gate off never calls the helper', async () => {
    await build({ surface: 'voice' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
  });
});

describe('callers pass their surface', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  // The page builders name the surface only for an offer list (`offer: true`);
  // customer-route-check-offer-only.test.js classifies every call site.
  test.each([
    ['../routes/reschedule-public.js', "...(offer ? { surface: 'reschedule' } : {})"],
    ['../routes/reservice-public.js', "...(offer ? { surface: 'reservice' } : {})"],
    ['../routes/inspection-public.js', "...(offer ? { surface: 'inspection' } : {})"],
    ['../services/commercial-first-visit.js', "...(offer ? { surface: 'commercial_first_visit' } : {})"],
  ])('%s', (file, needle) => {
    expect(read(file)).toContain(needle);
  });

  test('the phone agent names voice on its two availability searches, not on the booking-time recheck; /book names no default surface', () => {
    expect(read('../services/voice-agent/relay-tools.js').match(/surface: 'voice'/g)).toHaveLength(2);
    expect(read('../services/voice-agent/relay-booking.js')).not.toContain("surface: 'voice'");
    expect(read('../routes/booking.js')).toContain('return buildBookingAvailability({ ...args, selfServeNotice: true');
  });
});
