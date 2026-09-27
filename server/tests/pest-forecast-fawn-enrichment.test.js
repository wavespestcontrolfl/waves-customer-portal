/**
 * getWeatherSignals()'s FAWN enrichment for the public pest forecast.
 *
 * Regression coverage for the bug where the public forecast's
 * `weather.recent_rain_in` was always null and `source` always stayed
 * `"nws"` for the 'sw' region: fawn-weather.js was hitting a FAWN URL
 * that returns HTTP 400 for every request, and the failure was swallowed
 * by a bare `catch (_e) {}` with no logging at all. This suite mocks
 * FawnWeather directly (its own real-API-shape mapping is covered by
 * fawn-weather-mapping.test.js) and asserts the enrichment contract:
 * 'sw' + healthy FAWN -> 'nws+fawn' with a real reading; anything else
 * degrades to NWS-only, logged, never thrown.
 *
 * Enrichment calls getRecentRainfall() (lastDay total), not getCurrent()
 * (lastHour) — kept separate so this day-total rainfall reading never
 * masquerades as "current conditions" for other FAWN consumers (Codex
 * review, 2026-09-26).
 */

jest.mock('../services/fawn-weather');

const FawnWeather = require('../services/fawn-weather');
const logger = require('../services/logger');
const { getWeatherSignals, _clearCache } = require('../services/pest-forecast/weather');

const nwsPointsBody = { properties: { forecast: 'https://api.weather.gov/gridpoints/TBW/1,1/forecast' } };
const nwsForecastBody = {
  properties: {
    periods: [
      { isDaytime: true, temperature: 90, probabilityOfPrecipitation: { value: 60 } },
      { isDaytime: false, temperature: 78, probabilityOfPrecipitation: { value: 50 } },
      { isDaytime: true, temperature: 88, probabilityOfPrecipitation: { value: 40 } },
    ],
  },
};

function mockHealthyNws() {
  global.fetch = jest.fn((url) => {
    const body = String(url).includes('/points/') ? nwsPointsBody : nwsForecastBody;
    return Promise.resolve({ ok: true, json: async () => body });
  });
}

describe('getWeatherSignals FAWN enrichment (public pest forecast)', () => {
  beforeEach(() => {
    _clearCache();
    jest.clearAllMocks();
    mockHealthyNws();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('sw region + healthy FAWN -> nws+fawn with the real rainfall reading', async () => {
    FawnWeather.getRecentRainfall.mockResolvedValue({ rainfall_in: 0.42, station: 'North Port' });
    const out = await getWeatherSignals({ lat: 27.4989, lng: -82.5748, region: 'sw' });
    expect(FawnWeather.getRecentRainfall).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('nws+fawn');
    expect(out.recentRainIn).toBeCloseTo(0.42, 5);
    expect(out.hasWeather).toBe(true);
  });

  test('non-sw region never calls FAWN and stays nws-only', async () => {
    FawnWeather.getRecentRainfall.mockResolvedValue({ rainfall_in: 0.42 });
    const out = await getWeatherSignals({ lat: 25.77, lng: -80.19, region: 'se' });
    expect(FawnWeather.getRecentRainfall).not.toHaveBeenCalled();
    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
  });

  test('a FAWN rejection degrades to NWS-only, is logged, and never throws', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    FawnWeather.getRecentRainfall.mockRejectedValue(new Error('FAWN HTTP 400'));

    const out = await getWeatherSignals({ lat: 27.4989, lng: -82.5748, region: 'sw' });

    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
    expect(out.hasWeather).toBe(true); // the NWS signal alone still stands
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('FAWN lookup failed'));
    warnSpy.mockRestore();
  });

  test('FawnWeather resolving its own error placeholder is also logged, not silently dropped', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    FawnWeather.getRecentRainfall.mockResolvedValue({
      rainfall_in: null, station: 'unavailable', error: 'FAWN HTTP 400',
    });

    const out = await getWeatherSignals({ lat: 27.4989, lng: -82.5748, region: 'sw' });

    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('FAWN enrichment unavailable'));
    warnSpy.mockRestore();
  });

  test('a null rainfall reading never injects a phantom 0" and stays nws-only', async () => {
    FawnWeather.getRecentRainfall.mockResolvedValue({ rainfall_in: null, station: 'North Port' });
    const out = await getWeatherSignals({ lat: 27.4989, lng: -82.5748, region: 'sw' });
    expect(out.source).toBe('nws');
    expect(out.recentRainIn).toBeNull();
  });
});
