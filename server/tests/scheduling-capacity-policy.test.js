jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { serviceFamilyPreference, defaultTimeWindow } = require('../services/auto-dispatch/service-category');
const { withSchedulingDuration } = require('../services/service-library');
const { capacityForServices, capacityFromReservation, windowForCapacityService } = require('../services/combined-visit-capacity');
const RouteOptimizer = require('../services/route-optimizer');

const date = '2027-01-15';
const now = new Date('2027-01-01T12:00:00Z');
const stop = (id, start, duration, extra = {}) => ({ id, estimated_duration_minutes: duration, service_type: 'Pest Control', ...extra });
beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test('versioned combined allowances preserve old holds and whole-hour new member anchors', () => {
  const services = [{ service: 'pest_control' }, { service: 'lawn_care' }];
  const old = { window_start: '09:00', reservation_service_mix: capacityForServices(services) };
  const current = { window_start: '09:00', reservation_service_mix: capacityForServices(services, [30, 40]) };
  expect(windowForCapacityService(old, 1)).toEqual({ window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60 });
  expect(windowForCapacityService(current, 1)).toEqual({ window_start: '09:00', window_end: '09:40', estimated_duration_minutes: 40 });
  expect(capacityFromReservation(current).durationMinutes).toBe(70);
  expect(() => capacityFromReservation({ reservation_service_mix: { version: 2, services: ['pest_control'], durationMinutes: 60 } })).toThrow();
});

test('catalog policy is gated and explicit custom allowances remain intact', () => {
  const row = { default_duration_minutes: 60, scheduling_duration_policy: { version: 1,
    default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40 } };
  expect(withSchedulingDuration(row).default_duration_minutes).toBe(30);
  expect(withSchedulingDuration({ default_duration_minutes: 120 }).default_duration_minutes).toBe(120);
  delete process.env.GATE_SCHEDULING_CAPACITY;
  expect(withSchedulingDuration(row).default_duration_minutes).toBe(60);
});

test('service-family preference is finite, weighted by work, and unknown work stays neutral', () => {
  const lawn = [stop('a', 600, 40, { service_type: 'Lawn Care' }), stop('b', 660, 20)];
  expect(serviceFamilyPreference(lawn, 'Lawn Care')).toBeGreaterThan(0);
  expect(serviceFamilyPreference(lawn, 'Pest Control')).toBeLessThan(0);
  expect(serviceFamilyPreference(lawn, 'Consultation')).toBe(0);
  expect(serviceFamilyPreference([], 'Lawn Care')).toBe(0);
  expect(defaultTimeWindow('Lawn Care')).toBeNull();
});

test.each([['2027-01-15', '2027-01-15T13:00:00.000Z'], ['2027-07-15', '2027-07-15T12:00:00.000Z']])('Google uses the appointment departure in Eastern time: %s', async (day, departure) => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [
    { originIndex: 0, destinationIndex: 0, status: {}, condition: 'ROUTE_EXISTS', duration: '601s' },
  ] }));
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime() });
  const leg = { date: day, from: RouteOptimizer.HQ, to: { lat: 27.5, lng: -82.4 }, departureMin: 480 };
  await provider.preload([leg]);
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).departureTime).toBe(departure);
  expect(fetchImpl.mock.calls[0][1].headers['X-Goog-FieldMask']).toContain('status');
  expect(provider.lookup(leg)).toMatchObject({ minutes: 11, source: 'google_traffic' });
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test('database preparation does not exhaust the travel budget before its first request', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  let millis = now.getTime();
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [
    { condition: 'ROUTE_EXISTS', duration: '601s' },
  ] }));
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => millis, budgetMs: 1000 });
  millis += 3000;
  const leg = { date, from: RouteOptimizer.HQ, to: { lat: 27.5, lng: -82.4 }, departureMin: 480 };
  await provider.preload([leg]);
  expect(provider.lookup(leg).source).toBe('google_traffic');
  millis += 1001;
  await provider.preload([{ ...leg, departureMin: 481 }]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(provider.lookup({ ...leg, departureMin: 481 }).source).toBe('conservative_model');
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test.each(['timeout', 'missing', 'error', 'zero'])('Google %s never becomes a zero-minute drive', async kind => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  const fetchImpl = jest.fn(async () => {
    if (kind === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return { ok: true, json: async () => kind === 'missing' ? [] : [{ originIndex: 0, destinationIndex: 0,
      status: kind === 'error' ? { code: 5 } : {}, condition: 'ROUTE_EXISTS', duration: '0s' }] };
  });
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime(), maxRequests: 1 });
  const leg = { date, from: RouteOptimizer.HQ, to: { lat: 27.5, lng: -82.4 }, departureMin: 480 };
  await provider.preload([leg]);
  expect(provider.lookup(leg).source).toBe('conservative_model');
  expect(provider.lookup(leg).minutes).toBeGreaterThan(0);
  await provider.preload([{ ...leg, departureMin: 481 }]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  delete process.env.GOOGLE_MAPS_API_KEY;
});
