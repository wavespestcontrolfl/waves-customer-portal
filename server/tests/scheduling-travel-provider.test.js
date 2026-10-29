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


test.each(['requests', 'elements'])('new and concurrent providers share the paid %s allowance until its window resets', async limit => {
  let optimizer;
  jest.isolateModules(() => { optimizer = require('../services/route-optimizer'); });
  const oldKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  let millis = now.getTime();
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [] }));
  const leg = { date, from: optimizer.HQ, to: { lat: 27.5, lng: -82.4 }, departureMin: 480 };
  const legs = limit === 'elements'
    ? Array.from({ length: 25 }, (_, i) => ({ ...leg, to: { lat: 27.5 + i / 1000, lng: -82.4 } })) : [leg];
  const expectedRequests = limit === 'elements' ? 32 : 40;
  try {
    // Different provider instances model distinct simultaneous HTTP requests.
    await Promise.all(Array.from({ length: 50 }, async () => {
      const provider = optimizer.createSchedulingTravel({ fetchImpl, now: () => millis });
      await provider.preload(legs);
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(expectedRequests);
    const exhausted = optimizer.createSchedulingTravel({ fetchImpl, now: () => millis });
    await exhausted.preload(legs);
    expect(fetchImpl).toHaveBeenCalledTimes(expectedRequests);
    expect(exhausted.lookup(leg)).toMatchObject({ source: 'conservative_model', reason: 'shared_provider_budget' });
    millis += 15 * 60 * 1000;
    await optimizer.createSchedulingTravel({ fetchImpl, now: () => millis }).preload(legs);
    expect(fetchImpl).toHaveBeenCalledTimes(expectedRequests + 1);
  } finally {
    if (oldKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldKey;
  }
});

// GATE_PICKER_ROAD_CHECK's later road days (owner 2026-10-27, "make sure costs
// are appropriate"): a road time without traffic is Google's Essentials price
// (half the traffic-aware one) and does not depend on the hour, so one lookup
// per pair of places serves every departure on any day.
test('traffic: false asks TRAFFIC_UNAWARE with no departure, once per pair of places', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  const fetchImpl = jest.fn(async (_url, init) => ({ ok: true, json: async () => JSON.parse(init.body).destinations.map((_d, i) => (
    { originIndex: 0, destinationIndex: i, status: {}, condition: 'ROUTE_EXISTS', duration: '541s' }
  )) }));
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime(), traffic: false });
  const to = { lat: 27.5, lng: -82.4 };
  const other = { lat: 27.6, lng: -82.5 };
  const legs = [
    { date, from: RouteOptimizer.HQ, to, departureMin: 480 },
    { date: '2027-01-18', from: RouteOptimizer.HQ, to, departureMin: 900 },
    { date, from: RouteOptimizer.HQ, to: other, departureMin: 600 },
  ];
  await provider.preload(legs);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
  expect(body).not.toHaveProperty('departureTime');
  // One origin, its two destinations: two elements, not three.
  expect(body.destinations).toHaveLength(2);
  expect(provider.diagnostics()).toEqual({ requests: 1, elements: 2 });
  // Any day, any hour: the same answer.
  expect(provider.lookup({ date: '2027-02-01', from: RouteOptimizer.HQ, to, departureMin: 1000 })).toEqual({ minutes: 10, source: 'google_road', reason: null });
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test('the default stays traffic-aware at the leg\'s departure', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: '601s' }] }));
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime() });
  await provider.preload([{ date, from: RouteOptimizer.HQ, to: { lat: 27.5, lng: -82.4 }, departureMin: 480 }]);
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.routingPreference).toBe('TRAFFIC_AWARE');
  expect(body.departureTime).toBe('2027-01-15T13:00:00.000Z');
  delete process.env.GOOGLE_MAPS_API_KEY;
});

// GATE_PICKER_ROAD_CHECK: a picker that closes (or searches again) aborts its
// request; no request still queued is sent to Google after that.
test('an aborted signal sends no queued request', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
  const controller = new AbortController();
  const fetchImpl = jest.fn(async () => {
    controller.abort(); // the picker closes while the first request is out
    return { ok: true, json: async () => [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: '601s' }] };
  });
  const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime(), workers: 1, signal: controller.signal });
  const legs = [480, 540, 600].map((departureMin, i) => ({ date, from: RouteOptimizer.HQ, to: { lat: 27.5 + i / 100, lng: -82.4 }, departureMin }));
  await provider.preload(legs);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  // Already aborted: nothing at all.
  const none = jest.fn();
  await RouteOptimizer.createSchedulingTravel({ fetchImpl: none, now: () => now.getTime(), signal: controller.signal }).preload(legs);
  expect(none).not.toHaveBeenCalled();
  delete process.env.GOOGLE_MAPS_API_KEY;
});

// GATE_DRIVE_CLOCK (owner 2026-10-28): the model fallback uses the GPS-fitted
// pair, and a Google leg carries the park minutes at READ time, once. Off =
// today's numbers.
describe('GATE_DRIVE_CLOCK', () => {
  const CLOCK = 'GATE_DRIVE_CLOCK';
  const to = { lat: 27.5, lng: -82.4 }; // 4.64 straight-line miles from HQ
  const answerWith = (duration) => jest.fn(async () => ({ ok: true, json: async () => [
    { originIndex: 0, destinationIndex: 0, status: {}, condition: 'ROUTE_EXISTS', duration },
  ] }));
  // The drive clock needs the calibrated model on, as it is live.
  const savedCalibration = process.env.GATE_DRIVE_TIME_CALIBRATION;
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  });
  afterEach(() => {
    if (savedCalibration === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    else process.env.GATE_DRIVE_TIME_CALIBRATION = savedCalibration;
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env[CLOCK];
    delete process.env.DRIVE_CLOCK_PARK_MINUTES;
    delete process.env.DRIVE_CLOCK_FIXED_MINUTES;
    delete process.env.DRIVE_CLOCK_MINUTES_PER_MILE;
  });

  test('the model fallback: calibrated pair off, fitted pair on, same-place 0', () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const provider = RouteOptimizer.createSchedulingTravel({ now: () => now.getTime() });
    const leg = { date, from: RouteOptimizer.HQ, to, departureMin: 480 };
    expect(provider.lookup(leg)).toMatchObject({ minutes: 16, source: 'conservative_model' }); // ceil(4.25 + 2.35 x 4.64)
    process.env[CLOCK] = 'true';
    expect(provider.lookup(leg)).toMatchObject({ minutes: 19, source: 'conservative_model' }); // ceil(7.9 + 2.2 x 4.64)
    process.env.DRIVE_CLOCK_FIXED_MINUTES = '10';
    expect(provider.lookup(leg).minutes).toBe(21);
    expect(provider.lookup({ ...leg, to: RouteOptimizer.HQ }).minutes).toBe(0);
  });

  test('a Google answer: raw off, +4 on, and never stored with the 4', async () => {
    const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl: answerWith('601s'), now: () => now.getTime() });
    const leg = { date, from: RouteOptimizer.HQ, to, departureMin: 480 };
    await provider.preload([leg]);
    expect(provider.lookup(leg)).toEqual({ minutes: 11, source: 'google_traffic', reason: null });
    process.env[CLOCK] = 'true';
    expect(provider.lookup(leg)).toEqual({ minutes: 15, source: 'google_traffic', reason: null });
    expect(provider.lookup(leg).minutes).toBe(15); // a second read adds nothing more
    expect(provider.lookupRaw(leg).minutes).toBe(11);
    process.env.DRIVE_CLOCK_PARK_MINUTES = '6';
    expect(provider.lookup(leg).minutes).toBe(17);
    process.env.DRIVE_CLOCK_PARK_MINUTES = '25'; // out of bounds: the default
    expect(provider.lookup(leg).minutes).toBe(15);
    delete process.env[CLOCK];
    expect(provider.lookup(leg).minutes).toBe(11);
  });

  test('the road time without traffic gets it too', async () => {
    const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl: answerWith('541s'), now: () => now.getTime(), traffic: false });
    const leg = { date, from: RouteOptimizer.HQ, to, departureMin: 480 };
    await provider.preload([leg]);
    process.env[CLOCK] = 'true';
    expect(provider.lookup(leg)).toMatchObject({ minutes: 14, source: 'google_road' });
  });

  test('a same-place Google leg stays 0', async () => {
    const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl: answerWith('0s'), now: () => now.getTime() });
    const leg = { date, from: RouteOptimizer.HQ, to: RouteOptimizer.HQ, departureMin: 480 };
    await provider.preload([leg]);
    process.env[CLOCK] = 'true';
    expect(provider.lookup(leg)).toMatchObject({ minutes: 0, source: 'google_traffic' });
  });

  test('a leg Google did not answer never gets the park minutes', async () => {
    const fetchImpl = jest.fn(async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); });
    const provider = RouteOptimizer.createSchedulingTravel({ fetchImpl, now: () => now.getTime() });
    const leg = { date, from: RouteOptimizer.HQ, to, departureMin: 480 };
    process.env[CLOCK] = 'true'; // preload stores the model's answer for the leg
    await provider.preload([leg]);
    // The model's 19 (fitted pair), not 19 + 4.
    expect(provider.lookup(leg)).toMatchObject({ minutes: 19, source: 'conservative_model' });
    expect(provider.lookup({ ...leg, to: { lat: 0, lng: 0 } })).toMatchObject({ minutes: Infinity, source: 'unverified' });
  });
});
