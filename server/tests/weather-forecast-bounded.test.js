// getDailyRainOutlookBounded: the deadline race must not defeat the failure
// cooldown, and concurrent bounded callers must share ONE live lookup — a
// lookup slower than the deadline settles after every caller returned, and
// its failure still has to cool the key down so a 15s polling caller can't
// re-fire live NWS fetches through an outage (Codex 2026-07-20).
const {
  getDailyRainOutlookBounded,
  _test,
} = require('../services/weather-forecast');

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('getDailyRainOutlookBounded', () => {
  let fetchCalls;
  let resolveFetch;

  beforeEach(() => {
    _test._cache.clear();
    _test._dailyFailCooldown.clear();
    fetchCalls = 0;
    global.fetch = jest.fn(() => {
      fetchCalls += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    });
  });

  afterEach(() => {
    delete global.fetch;
    _test._dailyFailCooldown.clear();
  });

  test('deadline returns null now; the late failure still sets the cooldown', async () => {
    const first = await getDailyRainOutlookBounded(27.42, -82.41, { deadlineMs: 10 });
    expect(first).toBeNull();          // deadlined — lookup still in flight
    expect(fetchCalls).toBe(1);

    // Concurrent/subsequent call while the same key is in flight must NOT
    // launch a second live lookup.
    const second = await getDailyRainOutlookBounded(27.42, -82.41, { deadlineMs: 10 });
    expect(second).toBeNull();
    expect(fetchCalls).toBe(1);

    // The lookup finally settles as a failure (non-OK response) — the
    // background handler must stamp the cooldown even though every bounded
    // caller already returned.
    resolveFetch({ ok: false });
    await flush();
    await flush();
    expect(_test._dailyFailCooldown.size).toBe(1);

    // Cooled down: the next poll returns null immediately, no new fetch.
    const third = await getDailyRainOutlookBounded(27.42, -82.41, { deadlineMs: 10 });
    expect(third).toBeNull();
    expect(fetchCalls).toBe(1);
  });

  test('a successful lookup clears the cooldown and serves from cache', async () => {
    global.fetch = jest.fn((url) => {
      fetchCalls += 1;
      const isPoints = String(url).includes('/points/');
      return Promise.resolve({
        ok: true,
        json: async () => (isPoints
          ? { properties: { forecast: 'https://api.weather.gov/gridpoints/x/1,2/forecast' } }
          : {
            properties: {
              periods: [{
                startTime: '2026-07-22T08:00:00-04:00',
                isDaytime: true,
                probabilityOfPrecipitation: { value: 55 },
                shortForecast: 'Showers',
              }],
            },
          }),
      });
    });

    const outlook = await getDailyRainOutlookBounded(27.42, -82.41, { deadlineMs: 500 });
    expect(outlook?.['2026-07-22']?.rainChance).toBe(55);
    expect(_test._dailyFailCooldown.size).toBe(0);

    // Second call hits the daily cache — no new fetches.
    const calls = fetchCalls;
    const again = await getDailyRainOutlookBounded(27.42, -82.41, { deadlineMs: 500 });
    expect(again?.['2026-07-22']?.rainChance).toBe(55);
    expect(fetchCalls).toBe(calls);
  });
});
