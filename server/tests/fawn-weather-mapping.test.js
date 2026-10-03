/**
 * FawnWeather field-mapping tests against a fixture shaped like the REAL
 * live FAWN `{period}/summary/json` response (captured 2026-09-26 while
 * diagnosing the public pest forecast never getting a FAWN rainfall
 * reading): rows carry only a numeric `StationID` — no name, county, or
 * lat/lng field — and `rain_sum` is a SUM in CENTIMETERS, not inches. The
 * old `lastObservation/summary/` URL 400s and never returns any rows at
 * all, which is the actual root cause of the null `recent_rain_in` on the
 * public forecast.
 *
 * getCurrent() reads lastHour (near-real-time "current conditions"). No
 * FAWN period is a trailing 24h or 7-day total, so it publishes only the
 * hourly reading, as `rainfall_1h_in`. The public pest forecast's recent
 * rainfall comes from MRMS radar, not FAWN — see
 * pest-forecast-rain-enrichment.test.js.
 */

describe('FawnWeather — real API shape', () => {
  let FawnWeather;

  const realShapedRow = (overrides = {}) => ({
    StationID: '480',
    startTime: '2026-09-24T23:45:00-04:00',
    num_obs: '96',
    t2m_avg: '25.24',
    rh_avg: '83.4',
    rain_sum: '0',
    rain_15minMax: '0',
    ...overrides,
  });

  beforeEach(() => {
    jest.resetModules();
    FawnWeather = require('../services/fawn-weather');
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe('getCurrent (lastHour — current conditions)', () => {
    test('fetches only the real lastHour/summary/json endpoint, not the old 400ing lastObservation URL', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [realShapedRow()] }));
      await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://fawn.ifas.ufl.edu/controller.php/lastHour/summary/json',
      ]);
    });

    test('publishes the hour\'s rain only as rainfall_1h_in — rainfall_in stays null (no FAWN period is a 24h/7d total)', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '0.254' })],
      }));
      const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_1h_in).toBeCloseTo(0.1, 5);
      expect(snap.rainfall_in).toBeNull();
      expect(snap).not.toHaveProperty('rain_24h_in');
    });

    test('no coordinates → unavailable without a fetch, never a default station', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [realShapedRow({ StationID: '480' })] }));
      for (const opts of [undefined, {}, { latitude: null, longitude: null }, { latitude: '', longitude: '' }]) {
        const snap = await FawnWeather.getCurrent(opts);
        expect(snap.station).toBe('unavailable');
        expect(snap.temp_f).toBeNull();
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('an HTTP failure degrades to an error snapshot with rainfall_in null — never throws', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 400 }));
      const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/400/);
    });

    test('converts t2m_avg (C), tsoil_avg (C) and ws_avg (km/hr) to F/F/mph instead of leaving them null', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({
          StationID: '480', t2m_avg: '25.24', tsoil_avg: '27.46', ws_avg: '9.5',
        })],
      }));
      const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(snap.temp_f).toBeCloseTo(77.432, 2);
      expect(snap.soil_temp_f).toBeCloseTo(81.428, 2);
      expect(snap.wind_mph).toBeCloseTo(5.902, 2);
    });
    test('an out-of-range location gets an unavailable snapshot, not another location\'s cached conditions', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', t2m_avg: '25' })],
      }));
      const ok = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(ok.temp_f).toBeCloseTo(77, 5);
      const callsBefore = global.fetch.mock.calls.length;
      const far = await FawnWeather.getCurrent({ latitude: 26.6406, longitude: -81.8723 });
      expect(far.station).toBe('unavailable');
      expect(far.temp_f).toBeNull();
      expect(global.fetch.mock.calls.length).toBe(callsBefore);
    });

    test('a later fetch failure at the SAME coordinate reuses that coordinate\'s last-good snapshot', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', t2m_avg: '25' })],
      }));
      await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      nowSpy.mockReturnValue(1_700_000_000_000 + 20 * 60 * 1000);
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
      const again = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
      expect(again.temp_f).toBeCloseTo(77, 5);
      const other = await FawnWeather.getCurrent({ latitude: 27.0, longitude: -82.2 });
      expect(other.station).toBe('unavailable');
      nowSpy.mockRestore();
    });
  });

  describe('service-report application conditions', () => {
    test('stay on Open-Meteo — FAWN is never requested for the report / FDACS conditions', async () => {
      // Hourly rows sit on today's ET date: the shared forecast module slices to
      // the window it asked the provider for, as the real API's rows always are.
      const { etDateString } = require('../utils/datetime-et');
      const today = etDateString(new Date());
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          current: { time: `${today}T14:00`, temperature_2m: 88, relative_humidity_2m: 70, wind_speed_10m: 6, weather_code: 1 },
          hourly: { time: [`${today}T13:00`, `${today}T14:00`], precipitation: [0.1, 0.05] },
        }),
      }));
      const { fetchApplicationConditions } = require('../services/service-report/application-conditions');
      const conditions = await fetchApplicationConditions({ latitude: 27.45, longitude: -82.57 });
      expect(conditions.provider).toBe('open_meteo');
      expect(conditions.rain_24h_in).toBeCloseTo(0.15, 2);
      const urls = global.fetch.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('fawn.ifas.ufl.edu'))).toBe(false);
    });
  });
});
