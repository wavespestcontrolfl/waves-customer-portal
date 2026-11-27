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

  test('getNwsHourlyRain cacheOnly: a fresh cached NWS answer or null, never a fetch', async () => {
    const { getNwsHourlyRain, getNwsHourlyRainPatient } = require('../services/weather-forecast');
    expect(await getNwsHourlyRain(27.4, -82.4, { cacheOnly: true })).toBeNull();
    const hours = [{ startTime: '2026-11-27T08:00:00-05:00', pop: 80, source: 'nws' }];
    _test._hourlyCache.set('27.40,-82.40', { at: Date.now(), value: hours });
    expect(await getNwsHourlyRain(27.4, -82.4, { cacheOnly: true })).toBe(hours);
    const read = jest.fn(async (lat, lng, opts) => (opts.fetchTimeoutMs === 10000 ? null : hours));
    // The patient read asks twice with the long wait, then gives up with null.
    expect(await getNwsHourlyRainPatient(27.4, -82.4, { read })).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(global.fetch).not.toHaveBeenCalled();
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
    // temperatureF / windMph / hasThunder / windGustMph ride along for the job-card spray check
    // and storm/thunder hazard triggers; the wind upper bound is the conservative number for a max-wind label limit.
    expect(hours[0]).toEqual({ startTime: '2026-06-11T13:00:00-04:00', rainChance: 72, shortForecast: 'Thunderstorms', hasThunder: true, temperatureF: 88, windMph: 10, windGustMph: null, windDirection: null, relativeHumidity: null });
    expect(hours[1].rainChance).toBeNull();
    expect(hours[1]).toMatchObject({ hasThunder: false, temperatureF: null, windMph: null, windGustMph: null, windDirection: null, relativeHumidity: null });

    // Cached on the second call; null coords rejected without fetching.
    await getHourlyRainOutlook(27.1, -82.45);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(await getHourlyRainOutlook(null, -82.45)).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('hourly outlook carries the wind direction and the relative humidity when NWS gives them', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/TBW/3,4/forecast/hourly' } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: {
            periods: [
              { startTime: '2026-06-11T13:00:00-04:00', temperature: 91, windSpeed: '10 mph', windDirection: 'ENE', relativeHumidity: { unitCode: 'wmoUnit:percent', value: 68 } },
              { startTime: '2026-06-11T14:00:00-04:00', temperature: 92, windSpeed: '12 mph', windDirection: '', relativeHumidity: { value: null } },
              { startTime: '2026-06-11T15:00:00-04:00', temperature: 92, windSpeed: '12 mph', windDirection: 7 },
            ],
          },
        }),
      });
    const hours = await getHourlyRainOutlook(27.2, -82.5);
    expect(hours[0]).toMatchObject({ windMph: 10, windDirection: 'ENE', relativeHumidity: 68 });
    expect(hours[1]).toMatchObject({ windMph: 12, windDirection: null, relativeHumidity: null });
    expect(hours[2]).toMatchObject({ windDirection: null, relativeHumidity: null });
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

describe('NWS active alerts & unified weather hazard classification (owner 2026-11-26)', () => {
  const wf = require('../services/weather-forecast');

  beforeEach(() => {
    jest.clearAllMocks();
    _test._alertsCache.clear();
    global.fetch = jest.fn();
  });

  test('parseHasThunder and parseWindGustMph parse NWS fields cleanly', () => {
    expect(wf.parseHasThunder('Chance Showers And Thunderstorms')).toBe(true);
    expect(wf.parseHasThunder('Isolated T-Storms')).toBe(true);
    expect(wf.parseHasThunder('Partly Sunny')).toBe(false);
    expect(wf.parseWindGustMph('28 mph')).toBe(28);
    expect(wf.parseWindGustMph({ value: 50, unitCode: 'wmoUnit:km_h-1' })).toBeCloseTo(31.1, 1);
    expect(wf.parseWindGustMph(null)).toBeNull();
  });

  test('classifyNwsAlertEvent separates move triggers (tropical/severe/thunder) from alert-only (heat/wind)', () => {
    expect(wf.classifyNwsAlertEvent('Tropical Storm Warning')).toEqual({ category: 'tropical_storm', moveTrigger: true });
    expect(wf.classifyNwsAlertEvent('Hurricane Watch')).toEqual({ category: 'tropical_storm', moveTrigger: true });
    expect(wf.classifyNwsAlertEvent('Severe Thunderstorm Warning')).toEqual({ category: 'severe_storm', moveTrigger: true });
    expect(wf.classifyNwsAlertEvent('Tornado Warning')).toEqual({ category: 'severe_storm', moveTrigger: true });
    expect(wf.classifyNwsAlertEvent('Flash Flood Warning')).toEqual({ category: 'severe_storm', moveTrigger: true });
    expect(wf.classifyNwsAlertEvent('Heat Advisory')).toEqual({ category: 'heat_advisory', moveTrigger: false });
    expect(wf.classifyNwsAlertEvent('Excessive Heat Warning')).toEqual({ category: 'heat_advisory', moveTrigger: false });
    expect(wf.classifyNwsAlertEvent('Wind Advisory')).toEqual({ category: 'wind_advisory', moveTrigger: false });
  });

  test('getNwsActiveAlerts reads free api.weather.gov/alerts/active, caches, and fails open without PII logs', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        features: [
          { properties: { id: 'a1', event: 'Tropical Storm Warning', severity: 'Severe', onset: '2026-09-10T10:00:00-04:00', expires: '2026-09-10T22:00:00-04:00' } },
          { properties: { id: 'a2', event: 'Heat Advisory', severity: 'Moderate', onset: '2026-09-10T12:00:00-04:00', expires: '2026-09-10T18:00:00-04:00' } },
        ],
      }),
    });
    const alerts = await wf.getNwsActiveAlerts(27.34, -82.53);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ event: 'Tropical Storm Warning', category: 'tropical_storm', moveTrigger: true });
    expect(alerts[1]).toMatchObject({ event: 'Heat Advisory', category: 'heat_advisory', moveTrigger: false });
    // Second call uses cache.
    await wf.getNwsActiveAlerts(27.34, -82.53);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Fail-open without logging coords/URL.
    global.fetch.mockRejectedValueOnce(new Error('timeout'));
    expect(await wf.getNwsActiveAlerts(27.9912, -82.9987)).toBeNull();
    for (const call of logger.info.mock.calls) {
      expect(String(call[0])).not.toContain('27.99');
      expect(String(call[0])).not.toContain('api.weather.gov');
    }
  });

  test('classifyWeatherHazard: thunder/tropical move; heat and wind are alert-only and never move', () => {
    const day = '2026-09-10';
    const hotWindyHours = [
      { startTime: `${day}T10:00:00-04:00`, rainChance: 10, shortForecast: 'Sunny', hasThunder: false, temperatureF: 96, relativeHumidity: 65, windMph: 26, windGustMph: 34 },
    ];
    const heatWindOnly = wf.classifyWeatherHazard(hotWindyHours, [
      { event: 'Heat Advisory', category: 'heat_advisory', moveTrigger: false, onset: `${day}T09:00:00-04:00`, expires: `${day}T18:00:00-04:00` },
      { event: 'Wind Advisory', category: 'wind_advisory', moveTrigger: false, onset: `${day}T09:00:00-04:00`, expires: `${day}T18:00:00-04:00` },
    ], { day, startMin: 10 * 60, endMin: 11 * 60 });
    expect(heatWindOnly.moveTrigger).toBe(false);
    expect(heatWindOnly.advisories.map((a) => a.category)).toEqual(['heat_advisory', 'wind_advisory']);

    const thunderHours = [
      { startTime: `${day}T14:00:00-04:00`, rainChance: 55, shortForecast: 'Chance Thunderstorms', hasThunder: true },
    ];
    const thunder = wf.classifyWeatherHazard(thunderHours, [], { day, startMin: 14 * 60, endMin: 15 * 60 });
    expect(thunder.moveTrigger).toBe(true);
    expect(thunder.reasons).toContain('lightning_thunder');

    const tropical = wf.classifyWeatherHazard(hotWindyHours, [
      { event: 'Tropical Storm Warning', category: 'tropical_storm', moveTrigger: true, onset: `${day}T08:00:00-04:00`, expires: `${day}T20:00:00-04:00` },
    ], { day, startMin: 10 * 60, endMin: 11 * 60 });
    expect(tropical.moveTrigger).toBe(true);
    expect(tropical.reasons).toContain('tropical_storm');
  });
});
