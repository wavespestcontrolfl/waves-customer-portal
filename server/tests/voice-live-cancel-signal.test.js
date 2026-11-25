/**
 * The practice line's call-scoped AbortSignal reaches every paid stage a
 * find_slots / get_availability call can start, and the practice line's
 * degradation and pricing strings promise no callback. No paid call is made:
 * the geocode (fetch), the date-parser chain and the road-time batches are stubs.
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
const mockDispatch = jest.fn(async () => ({ ok: true, json: { date_from: '2026-12-01', date_to: '2026-12-07', time_of_day: 'any', understood: true } }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));

const { parseWhen } = require('../services/scheduling/parse-when');
const { _internals: findTime } = require('../services/scheduling/find-time');
const { createSchedulingTravel } = require('../services/route-optimizer');

describe('the date parser', () => {
  beforeEach(() => mockDispatch.mockClear());

  test('hands the call-scoped signal to the provider chain, which stops before each leg once it aborts', async () => {
    const controller = new AbortController();
    await parseWhen('next week', { signal: controller.signal, now: new Date('2026-11-24T12:00:00Z') });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  test('an ordinary caller passes no signal', async () => {
    await parseWhen('next week', { now: new Date('2026-11-24T12:00:00Z') });
    expect(mockDispatch.mock.calls[0][1]).not.toHaveProperty('signal');
  });

  test('the fallback chain itself starts no leg once the payload signal has aborted (the existing guard this relies on)', async () => {
    jest.unmock('../services/llm/call');
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    const { dispatchWithFallback } = jest.requireActual('../services/llm/call');
    const controller = new AbortController();
    controller.abort();
    const policy = { primary: { provider: 'openai', model: 'm1' }, fallback: { provider: 'gemini', model: 'm2' } };
    const result = await dispatchWithFallback(policy, { laneId: 'parse_when', text: 'x', signal: controller.signal });
    expect(result.ok).toBe(false);
  });
});

describe('road times', () => {
  test('find-time hands the signal to the travel allowance, and an aborted signal sends no road-time request', async () => {
    const controller = new AbortController();
    expect(findTime.travelAllowance({})).toBeUndefined();
    expect(findTime.travelAllowance({ providerTravel: false })).toEqual({ maxRequests: 0 });
    const allowance = findTime.travelAllowance({ signal: controller.signal });
    expect(allowance).toEqual({ signal: controller.signal });
    expect(findTime.travelAllowance({ signal: controller.signal, providerTravel: false })).toEqual({ maxRequests: 0, signal: controller.signal });

    process.env.GOOGLE_API_KEY = 'test-key';
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => [] }));
    controller.abort();
    const travel = createSchedulingTravel({ ...allowance, fetchImpl, sharedBudget: { maxRequests: 40, maxElements: 800, resetAt: Date.now() + 1e6, requests: 0, elements: 0 } });
    const leg = { from: { lat: 27.5, lng: -82.5 }, to: { lat: 27.6, lng: -82.6 }, date: '2099-01-05', departureMin: 600 };
    await travel.preload([leg]);
    expect(fetchImpl).not.toHaveBeenCalled(); // a hung-up call buys no road time
    delete process.env.GOOGLE_API_KEY;
  });
});

describe('the geocode', () => {
  test('resolveBookingCoords starts no geocode once the signal has aborted, and does start one otherwise', async () => {
    const { _internals: booking } = require('../routes/booking');
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 27.5, lng: -82.5 } } }] }) }));
    try {
      const controller = new AbortController();
      const live = await booking.resolveBookingCoords({ address: '1 Palm Ave, Bradenton, FL', signal: controller.signal });
      expect(live.lat).toBe(27.5);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      controller.abort();
      global.fetch.mockClear();
      const gone = await booking.resolveBookingCoords({ address: '1 Palm Ave, Bradenton, FL', signal: controller.signal });
      expect(gone.lat).toBe(null);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = realFetch;
      delete process.env.GOOGLE_MAPS_API_KEY;
    }
  });
});
