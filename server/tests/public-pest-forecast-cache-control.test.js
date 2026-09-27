/**
 * GET /api/public/pest-forecast cache headers never outlive the ET day.
 *
 * The forecast's rain signal is "yesterday's" measured total, which moves at
 * ET midnight, and the server caches already refuse to serve a reading past
 * it (pest-forecast-rain-enrichment.test.js). The HTTP layer must match, or a
 * browser (max-age, 1h) or shared cache (s-maxage, 3h) would keep serving a
 * pre-midnight response after the day turned.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pest-forecast/forecast', () => ({ getForecast: jest.fn(async () => ({ ok: true })) }));

const router = require('../routes/public-pest-forecast');

// Only Date is faked.
const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };

function forecastHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  return layer.route.stack[0].handle;
}

async function cacheControlAt(iso) {
  jest.setSystemTime(new Date(iso));
  const res = { set: jest.fn(), json: jest.fn() };
  res.status = jest.fn(() => res);
  await forecastHandler()({ query: { location: 'bradenton-fl' } }, res);
  expect(res.json).toHaveBeenCalledWith({ ok: true });
  return res.set.mock.calls.find(([name]) => name === 'Cache-Control')?.[1];
}

describe('public pest-forecast Cache-Control', () => {
  beforeEach(() => jest.useFakeTimers(ONLY_DATE));
  afterEach(() => jest.useRealTimers());

  test('midday ET keeps the full 1h browser / 3h shared lifetimes', async () => {
    expect(await cacheControlAt('2026-07-15T16:00:00Z')).toBe('public, max-age=3600, s-maxage=10800');
  });

  test('10 PM ET caps the shared cache at midnight; the browser hour still fits', async () => {
    expect(await cacheControlAt('2026-07-16T02:00:00Z')).toBe('public, max-age=3600, s-maxage=7200');
  });

  test('11:30 PM ET caps both at the 30 minutes left before midnight', async () => {
    expect(await cacheControlAt('2026-07-16T03:30:00Z')).toBe('public, max-age=1800, s-maxage=1800');
  });
});
