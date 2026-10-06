jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { getDailyRainOutlook, getHourlyRainOutlook, _test } = require('../services/weather-forecast');

// 2026-10-07 12:00 UTC = 08:00 EDT. Hours are unix seconds, as requested.
const BASE = Date.parse('2026-10-07T12:00:00Z') / 1000;
const openMeteoBody = (chances) => ({
  hourly: {
    time: chances.map((_, i) => BASE + i * 3600),
    precipitation_probability: chances,
    temperature_2m: chances.map(() => 84.4),
    // Just past a 10 mph label max: must not round onto the limit.
    wind_speed_10m: chances.map(() => 10.04),
  },
});

describe('weather-forecast Open-Meteo backup', () => {
  const realNow = Date.now;
  beforeEach(() => {
    jest.clearAllMocks();
    _test._cache.clear();
    _test._hourlyCache.clear();
    global.fetch = jest.fn();
    Date.now = () => BASE * 1000;
    delete process.env.OPEN_METEO_API_KEY;
  });
  afterAll(() => {
    delete global.fetch;
    Date.now = realNow;
    delete process.env.OPEN_METEO_API_KEY;
  });

  test('etIso keeps the Eastern offset on both sides of daylight saving', () => {
    expect(_test.etIso(Date.parse('2026-10-06T20:00:00Z'))).toBe('2026-10-06T16:00:00-04:00');
    expect(_test.etIso(Date.parse('2026-12-06T20:00:00Z'))).toBe('2026-12-06T15:00:00-05:00');
  });

  test('NWS ok: Open-Meteo is never called', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ properties: { forecastHourly: 'https://api.weather.gov/x' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ properties: { periods: [{ startTime: '2026-10-07T08:00:00-04:00', probabilityOfPrecipitation: { value: 80 } }] } }) });
    const hours = await getHourlyRainOutlook(27.4, -82.4);
    expect(hours[0].rainChance).toBe(80);
    expect(hours[0].source).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('NWS down: hourly comes from Open-Meteo in the NWS shape, with the key when set', async () => {
    process.env.OPEN_METEO_API_KEY = 'test-key';
    global.fetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => openMeteoBody([10, 70]) });
    // Each test uses its own point: the shared client keeps its own cache.
    const hours = await getHourlyRainOutlook(27.41, -82.41);
    expect(hours).toEqual([
      { startTime: '2026-10-07T08:00:00-04:00', rainChance: 10, shortForecast: null, temperatureF: 84.4, windMph: 10.04, source: 'open-meteo' },
      { startTime: '2026-10-07T09:00:00-04:00', rainChance: 70, shortForecast: null, temperatureF: 84.4, windMph: 10.04, source: 'open-meteo' },
    ]);
    const url = new URL(global.fetch.mock.calls[1][0]);
    expect(url.host).toBe('customer-api.open-meteo.com');
    expect(url.searchParams.get('apikey')).toBe('test-key');
    // The key rides in the URL: no log line may carry it.
    for (const call of logger.info.mock.calls) expect(String(call[0])).not.toContain('test-key');
    // Cached like an NWS answer.
    await getHourlyRainOutlook(27.41, -82.41);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('NWS down: daily = max daytime (6 AM-6 PM ET) chance per date', async () => {
    // 08:00 .. 19:00 EDT on 10-07; the 70 at 18:00 and 19:00 is outside daytime.
    const chances = [10, 20, 55, 30, 0, 0, 0, 0, 0, 0, 70, 70];
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ properties: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => openMeteoBody(chances) });
    const outlook = await getDailyRainOutlook(27.42, -82.42);
    expect(outlook).toEqual({ '2026-10-07': { rainChance: 55, shortForecast: null, source: 'open-meteo' } });
  });

  test('both down: null (fail-open)', async () => {
    global.fetch.mockRejectedValue(new Error('down'));
    expect(await getHourlyRainOutlook(27.43, -82.43)).toBeNull();
    expect(await getDailyRainOutlook(27.43, -82.43)).toBeNull();
  });
});
