/**
 * Open-Meteo endpoint (owner 2026-10-06): with OPEN_METEO_API_KEY the paid
 * customer host carries the key and the archive (not in Standard) is off;
 * without it, the free endpoint exactly as before.
 */
const { openMeteoForecastUrl, openMeteoArchiveAvailable, openMeteoCoversDate } = require('../services/open-meteo-endpoint');

describe('open-meteo endpoint', () => {
  const ENV = process.env.OPEN_METEO_API_KEY;
  afterEach(() => {
    if (ENV === undefined) delete process.env.OPEN_METEO_API_KEY;
    else process.env.OPEN_METEO_API_KEY = ENV;
  });

  test('no key: the free endpoint and the archive', () => {
    delete process.env.OPEN_METEO_API_KEY;
    const url = openMeteoForecastUrl();
    expect(url.origin).toBe('https://api.open-meteo.com');
    expect(url.searchParams.has('apikey')).toBe(false);
    expect(openMeteoArchiveAvailable()).toBe(true);
  });

  test('a key: the customer host with the key, no archive', () => {
    process.env.OPEN_METEO_API_KEY = ' fixture-key ';
    const url = openMeteoForecastUrl();
    expect(url.origin).toBe('https://customer-api.open-meteo.com');
    expect(url.pathname).toBe('/v1/forecast');
    expect(url.searchParams.get('apikey')).toBe('fixture-key');
    expect(openMeteoArchiveAvailable()).toBe(false);
  });

  test('92-day reach: only limits the paid key', () => {
    delete process.env.OPEN_METEO_API_KEY;
    expect(openMeteoCoversDate('2026-01-01', '2026-10-06')).toBe(true);
    process.env.OPEN_METEO_API_KEY = 'k';
    expect(openMeteoCoversDate('2026-07-06', '2026-10-06')).toBe(true);
    expect(openMeteoCoversDate('2026-07-05', '2026-10-06')).toBe(false);
  });
});
