jest.mock('../services/pest-forecast/weather', () => {
  const actual = jest.requireActual('../services/pest-forecast/weather');
  return {
    ...actual,
    getWeatherSignals: jest.fn(),
  };
});

jest.mock('../services/pest-forecast/history', () => ({
  historyEnabled: jest.fn(() => false),
  compareForecasts: jest.fn((f) => f),
  readPreviousForecast: jest.fn(async () => null),
}));

const weather = require('../services/pest-forecast/weather');
const { getForecastFast, getForecastWithFreshness, _clearCache } = require('../services/pest-forecast/forecast');

describe('getForecastFast (non-blocking report forecast)', () => {
  beforeEach(() => {
    _clearCache();
    weather.getWeatherSignals.mockReset();
  });

  test('returns fresh cached forecast without calling getWeatherSignals again', async () => {
    weather.getWeatherSignals.mockResolvedValue({
      ...weather.flags({ hasWeather: true, tempHighF: 89, precipChance: 40, source: 'nws' }),
      freshUntil: Date.now() + 60_000,
    });

    const first = await getForecastFast({ zip: '34205' }, { timeoutMs: 200 });
    expect(first.weather.available).toBe(true);
    expect(first.weather.temp_high_f).toBe(89);

    weather.getWeatherSignals.mockClear();
    const second = await getForecastFast({ zip: '34205' }, { timeoutMs: 200 });
    expect(second.weather.temp_high_f).toBe(89);
    expect(weather.getWeatherSignals).not.toHaveBeenCalled();
  });

  test('returns deterministic baseline quickly on a slow cold fetch and warms cache once finished', async () => {
    let resolveSignals;
    weather.getWeatherSignals.mockImplementation(
      () => new Promise((resolve) => { resolveSignals = resolve; }),
    );

    const started = Date.now();
    const fallback = await getForecastFast({ zip: '34205' }, { timeoutMs: 25 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(fallback.weather.available).toBe(false);
    expect(fallback.weather.summary).toMatch(/seasonal outlook/i);
    expect(fallback.pests.length).toBeGreaterThanOrEqual(8);

    // Resolve the background lookup and confirm subsequent read gets the warmed weather.
    resolveSignals({
      ...weather.flags({ hasWeather: true, tempHighF: 93, precipChance: 65, source: 'nws' }),
      freshUntil: Date.now() + 60_000,
    });
    await new Promise((r) => setTimeout(r, 15));

    weather.getWeatherSignals.mockClear();
    const warmed = await getForecastFast({ zip: '34205' }, { timeoutMs: 25 });
    expect(warmed.weather.available).toBe(true);
    expect(warmed.weather.temp_high_f).toBe(93);
    expect(weather.getWeatherSignals).not.toHaveBeenCalled();
  });

  test('serves same-day stale cached forecast immediately while refreshing in the background', async () => {
    const fixedNow = new Date('2026-08-15T16:00:00Z');
    weather.getWeatherSignals.mockResolvedValueOnce({
      ...weather.flags({ hasWeather: true, tempHighF: 84, precipChance: 20, source: 'nws' }),
      freshUntil: Date.now() - 1000, // already expired, same ET day
    });

    await getForecastWithFreshness({ zip: '34205' }, { now: fixedNow });

    let resolveRefresh;
    weather.getWeatherSignals.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const staleHit = await getForecastFast({ zip: '34205' }, { timeoutMs: 25, now: fixedNow });
    expect(staleHit.weather.temp_high_f).toBe(84);
    expect(weather.getWeatherSignals).toHaveBeenCalledTimes(2);

    resolveRefresh({
      ...weather.flags({ hasWeather: true, tempHighF: 94, precipChance: 70, source: 'nws' }),
      freshUntil: Date.now() + 60_000,
    });
    await new Promise((r) => setTimeout(r, 15));

    const refreshed = await getForecastFast({ zip: '34205' }, { timeoutMs: 25, now: fixedNow });
    expect(refreshed.weather.temp_high_f).toBe(94);
  });

  test('deduplicates concurrent in-flight lookups for the same slug', async () => {
    let resolveSignals;
    weather.getWeatherSignals.mockImplementation(
      () => new Promise((resolve) => { resolveSignals = resolve; }),
    );

    const p1 = getForecastWithFreshness({ zip: '34205' });
    const p2 = getForecastWithFreshness({ zip: '34205' });
    expect(weather.getWeatherSignals).toHaveBeenCalledTimes(1);

    resolveSignals({
      ...weather.flags({ hasWeather: true, tempHighF: 88, precipChance: 30, source: 'nws' }),
      freshUntil: Date.now() + 60_000,
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.forecast.weather.temp_high_f).toBe(88);
    expect(r2.forecast.weather.temp_high_f).toBe(88);
  });
});
