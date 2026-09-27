/**
 * GET /api/public/pest-forecast HTTP cache lifetimes come from the forecast's
 * own freshUntil (3h; 15 min while a SWFL rain reading is missing; never past
 * ET midnight — computed in pest-forecast/weather.js and pinned by
 * pest-forecast-rain-enrichment.test.js), measured when the response is sent.
 * A browser (max-age ≤ 1h) or shared cache (s-maxage ≤ 3h) must never keep a
 * response longer than the server would, and a result computed before ET
 * midnight but sent after it must not inherit a fresh lifetime.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pest-forecast/forecast', () => ({ getForecastWithFreshness: jest.fn() }));

const { getForecastWithFreshness } = require('../services/pest-forecast/forecast');
const router = require('../routes/public-pest-forecast');

// Only Date is faked.
const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };
const SENT_AT = new Date('2026-07-15T16:00:00Z');
const MIN = 60 * 1000;

function forecastHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  return layer.route.stack[0].handle;
}

async function cacheControlFor(freshUntil) {
  getForecastWithFreshness.mockResolvedValueOnce({ forecast: { ok: true }, freshUntil });
  const res = { set: jest.fn(), json: jest.fn() };
  res.status = jest.fn(() => res);
  await forecastHandler()({ query: { location: 'bradenton-fl' } }, res);
  expect(res.json).toHaveBeenCalledWith({ ok: true });
  return res.set.mock.calls.find(([name]) => name === 'Cache-Control')?.[1];
}

describe('public pest-forecast Cache-Control', () => {
  beforeEach(() => jest.useFakeTimers({ ...ONLY_DATE, now: SENT_AT }));
  afterEach(() => jest.useRealTimers());

  test.each([
    ['fresh for 3h: the full 1h browser / 3h shared lifetimes', 180 * MIN, 'public, max-age=3600, s-maxage=10800'],
    ['fresh for 2h (ET midnight): the shared cache stops there', 120 * MIN, 'public, max-age=3600, s-maxage=7200'],
    ['fresh for 15 min (rain reading missing): both retry with the server', 15 * MIN, 'public, max-age=900, s-maxage=900'],
    ['already stale (computed before ET midnight, sent after): zero-age', -30 * 1000, 'public, max-age=0, s-maxage=0'],
  ])('%s', async (_label, freshForMs, expected) => {
    expect(await cacheControlFor(SENT_AT.getTime() + freshForMs)).toBe(expected);
  });
});
