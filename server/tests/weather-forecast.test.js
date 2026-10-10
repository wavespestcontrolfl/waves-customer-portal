jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { getDailyRainOutlook, getHourlyRainOutlook, forecastLinkForZip, _test } = require('../services/weather-forecast');

describe('weather-forecast (NWS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _test._cache.clear();
    _test._hourlyCache.clear();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    delete global.fetch;
  });

  test('forecastLinkForZip builds the NWS zipcity link and rejects junk', () => {
    expect(forecastLinkForZip('34202')).toBe('https://forecast.weather.gov/zipcity.php?inputstring=34202');
    expect(forecastLinkForZip('34202-1234')).toBe('https://forecast.weather.gov/zipcity.php?inputstring=34202');
    expect(forecastLinkForZip(null)).toBeNull();
    expect(forecastLinkForZip('not a zip')).toBeNull();
  });

  test('outlook maps daytime periods by date and caches', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ properties: { forecast: 'https://api.weather.gov/gridpoints/TBW/1,2/forecast' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            periods: [
              { startTime: '2026-06-11T08:00:00-04:00', isDaytime: true, probabilityOfPrecipitation: { value: 60 }, shortForecast: 'Thunderstorms' },
              { startTime: '2026-06-11T20:00:00-04:00', isDaytime: false, probabilityOfPrecipitation: { value: 30 }, shortForecast: 'Showers' },
              { startTime: '2026-06-12T08:00:00-04:00', isDaytime: true, probabilityOfPrecipitation: { value: 20 }, shortForecast: 'Sunny' },
            ],
          },
        }),
      });

    const outlook = await getDailyRainOutlook(27.4, -82.4);
    expect(outlook['2026-06-11']).toEqual({ rainChance: 60, shortForecast: 'Thunderstorms' });
    expect(outlook['2026-06-12']).toEqual({ rainChance: 20, shortForecast: 'Sunny' });

    // Second call for the same grid key serves from cache — no new fetch.
    await getDailyRainOutlook(27.4, -82.4);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('fail-open on network error — and the log line never contains coordinates (PII)', async () => {
    global.fetch.mockRejectedValue(new Error('socket hang up'));

    const outlook = await getDailyRainOutlook(27.4123, -82.4567);
    expect(outlook).toBeNull();

    expect(logger.info).toHaveBeenCalled();
    for (const call of logger.info.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain('27.41');
      expect(line).not.toContain('82.45');
      expect(line).not.toContain('api.weather.gov');
    }
  });

  test('hourly outlook maps periods and rejects empty coords before coercion', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/TBW/1,2/forecast/hourly' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            periods: [
              { startTime: '2026-06-11T13:00:00-04:00', probabilityOfPrecipitation: { value: 72 }, shortForecast: 'Thunderstorms', temperatureF: undefined, temperature: 88, windSpeed: '5 to 10 mph' },
              { startTime: '2026-06-11T14:00:00-04:00', probabilityOfPrecipitation: { value: null }, shortForecast: 'Showers' },
            ],
          },
        }),
      });

    const hours = await getHourlyRainOutlook(27.1, -82.45);
    expect(hours).toHaveLength(2);
    // temperatureF / windMph ride along for the job-card spray check; the
    // wind upper bound is the conservative number for a max-wind label limit.
    expect(hours[0]).toEqual({ startTime: '2026-06-11T13:00:00-04:00', rainChance: 72, shortForecast: 'Thunderstorms', temperatureF: 88, windMph: 10 });
    expect(hours[1].rainChance).toBeNull();
    expect(hours[1]).toMatchObject({ temperatureF: null, windMph: null });

    // Cached on the second call; null coords rejected without fetching.
    await getHourlyRainOutlook(27.1, -82.45);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(await getHourlyRainOutlook(null, -82.45)).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('non-finite coordinates are rejected without fetching', async () => {
    expect(await getDailyRainOutlook(null, -82.4)).toBeNull();
    expect(await getDailyRainOutlook('abc', -82.4)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('coordinate caches are size-bounded (Codex #6126 r4)', () => {
  const { cachePut, CACHE_MAX_ENTRIES } = _test;

  test('past the bound, expired entries go first, then the oldest', () => {
    const cache = new Map();
    const now = Date.now();
    cache.set('stale', { at: now - 60 * 60 * 1000, value: 1 });
    for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) cachePut(cache, `k${i}`, { at: now, value: i }, 10 * 60 * 1000);
    // One over the bound: the expired entry is dropped, every fresh one stays.
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has('stale')).toBe(false);
    expect(cache.has('k0')).toBe(true);
    // All fresh and one more: the oldest is evicted.
    cachePut(cache, 'extra', { at: now, value: 'x' }, 10 * 60 * 1000);
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has('extra')).toBe(true);
  });

  test('1,000 distinct points keep the hourly cache at the bound', async () => {
    _test._hourlyCache.clear();
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/points/')
        ? { properties: { forecastHourly: 'https://api.weather.gov/x' } }
        : { properties: { periods: [{ startTime: '2026-10-09T08:00:00-04:00', probabilityOfPrecipitation: { value: 10 } }] } }),
    }));
    for (let i = 0; i < 1000; i += 1) await getHourlyRainOutlook(27 + i / 100, -82.4);
    expect(_test._hourlyCache.size).toBe(CACHE_MAX_ENTRIES);
  });
});
