jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { getDailyRainOutlook, getHourlyRainOutlook, _test } = require('../services/weather-forecast');
const { etOffsetIso } = require('../utils/datetime-et');

// 2026-10-07 10:00 UTC = 06:00 EDT. Hours are unix seconds, as requested.
const BASE = Date.parse('2026-10-07T10:00:00Z') / 1000;
const openMeteoBody = (chances) => ({
  hourly: {
    time: chances.map((_, i) => BASE + i * 3600),
    precipitation_probability: chances,
    temperature_2m: chances.map(() => 84.4),
    // Just past a 10 mph label max: must not round onto the limit.
    wind_speed_10m: chances.map(() => 10.04),
  },
});
const omOk = (chances) => ({ ok: true, json: async () => openMeteoBody(chances) });
const isOpenMeteo = (url) => String(url).includes('open-meteo.com');

describe('weather-forecast Open-Meteo backup', () => {
  const realNow = Date.now;
  let now;
  beforeEach(() => {
    jest.clearAllMocks();
    _test._cache.clear();
    _test._hourlyCache.clear();
    global.fetch = jest.fn();
    now = BASE * 1000;
    Date.now = () => now;
    delete process.env.OPEN_METEO_API_KEY;
  });
  afterAll(() => {
    delete global.fetch;
    Date.now = realNow;
    delete process.env.OPEN_METEO_API_KEY;
  });

  test('etOffsetIso keeps the Eastern offset on both sides of daylight saving', () => {
    expect(etOffsetIso(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-06T16:00:00-04:00');
    expect(etOffsetIso('2026-12-06T20:00:00Z')).toBe('2026-12-06T15:00:00-05:00');
    expect(etOffsetIso('2026-12-07T05:00:00Z')).toBe('2026-12-07T00:00:00-05:00');
    expect(etOffsetIso('not a date')).toBeNull();
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

  test('NWS down: hourly comes from Open-Meteo in the NWS shape, exact readings, key never logged', async () => {
    process.env.OPEN_METEO_API_KEY = 'test-key';
    global.fetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(omOk([10, 70]));
    // Each test uses its own point: the shared client keeps its own cache.
    const hours = await getHourlyRainOutlook(27.41, -82.41);
    expect(hours).toEqual([
      { startTime: '2026-10-07T06:00:00-04:00', rainChance: 10, shortForecast: null, temperatureF: 84.4, windMph: 10.04, source: 'open-meteo' },
      { startTime: '2026-10-07T07:00:00-04:00', rainChance: 70, shortForecast: null, temperatureF: 84.4, windMph: 10.04, source: 'open-meteo' },
    ]);
    const url = new URL(global.fetch.mock.calls[1][0]);
    expect(url.host).toBe('customer-api.open-meteo.com');
    expect(url.searchParams.get('apikey')).toBe('test-key');
    for (const call of [...logger.info.mock.calls, ...logger.warn.mock.calls]) expect(String(call[0])).not.toContain('test-key');
    // Cached like an NWS answer.
    await getHourlyRainOutlook(27.41, -82.41);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('NWS down: daily = max daytime chance, only for dates with all 12 daytime hours', async () => {
    // 06:00 .. 17:00 EDT on 10-07 (complete), then 18:00 + 19:00 (night), then
    // 06:00 .. 08:00 on 10-08 (partial: omitted, though it holds a 90).
    const day1 = [10, 20, 55, 30, 0, 0, 0, 0, 0, 0, 0, 0, 70, 70];
    const gap = Array(10).fill(0);
    const day2 = [90, 90, 90];
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ properties: {} }) })
      .mockResolvedValueOnce(omOk([...day1, ...gap, ...day2]));
    const outlook = await getDailyRainOutlook(27.42, -82.42);
    expect(outlook).toEqual({ '2026-10-07': { rainChance: 55, shortForecast: null, source: 'open-meteo' } });
  });

  test('daily + hourly together during an NWS outage share ONE Open-Meteo read', async () => {
    global.fetch.mockImplementation(async (url) => (isOpenMeteo(url) ? omOk(Array(24).fill(40)) : { ok: false }));
    const [daily, hourly] = await Promise.all([getDailyRainOutlook(27.44, -82.44), getHourlyRainOutlook(27.44, -82.44)]);
    expect(daily['2026-10-07'].rainChance).toBe(40);
    expect(hourly).toHaveLength(24);
    expect(global.fetch.mock.calls.filter(([url]) => isOpenMeteo(url))).toHaveLength(1);
    expect(_test._backupInFlight.size).toBe(0);
  });

  test('a slow NWS failure leaves no budget: the backup is skipped, not added on top', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (isOpenMeteo(url)) return omOk([50]);
      now += 2400; // each NWS request eats most of its 2.5 s timeout
      return String(url).includes('/points/')
        ? { ok: true, json: async () => ({ properties: { forecastHourly: 'https://api.weather.gov/x' } }) }
        : { ok: false };
    });
    expect(await getHourlyRainOutlook(27.45, -82.45)).toBeNull();
    expect(global.fetch.mock.calls.filter(([url]) => isOpenMeteo(url))).toHaveLength(0);
  });

  test('both down: null (fail-open)', async () => {
    global.fetch.mockRejectedValue(new Error('down'));
    expect(await getHourlyRainOutlook(27.43, -82.43)).toBeNull();
    expect(await getDailyRainOutlook(27.43, -82.43)).toBeNull();
  });
});
