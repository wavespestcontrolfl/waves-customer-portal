jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const RouteOptimizer = require('../services/route-optimizer');
const date = '2027-01-15';
const now = new Date('2027-01-01T12:00:00Z');

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
