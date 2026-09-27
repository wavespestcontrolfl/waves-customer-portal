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
 * getCurrent() (lastHour, near-real-time "current conditions") and
 * getRecentRainfall() (lastDay, a meaningful "has it been wet lately"
 * total) hit different FAWN endpoints and are covered separately — see the
 * fetch-URL assertions in each block below. They were split out (Codex
 * review, 2026-09-26) so the public forecast's day-total rainfall reading
 * never masquerades as "current conditions". Neither FAWN period is a
 * trailing 24h or 7-day total, so getCurrent() publishes only the hourly
 * reading, as `rainfall_1h_in`.
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

  describe('getRecentRainfall (lastDay — meaningful rainfall total)', () => {
    test('fetches the real lastDay/summary/json endpoint', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [realShapedRow()] }));
      await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url] = global.fetch.mock.calls[0];
      expect(String(url)).toBe('https://fawn.ifas.ufl.edu/controller.php/lastDay/summary/json');
    });

    test('converts rain_sum from centimeters to inches (2.54cm === 1.00in)', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '2.54' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeCloseTo(1.0, 5);
    });

    test('a zero rain_sum reads as a real 0", not null', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '0' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBe(0);
    });

    test('picks the SWFL station nearest the requested coordinate by StationID, ignoring far-away rows', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [
          realShapedRow({ StationID: '110', rain_sum: '5' }), // Jay, FL panhandle — not SWFL
          realShapedRow({ StationID: '490', rain_sum: '2.54' }), // Arcadia (DeSoto Co.)
          realShapedRow({ StationID: '480', rain_sum: '1.27' }), // North Port (Sarasota Co.) — nearest to Bradenton
        ],
      }));
      // Bradenton-ish coordinate.
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.4989, longitude: -82.5748 });
      expect(snap.station).toBe('North Port');
      expect(snap.station_key).toBe('north_port');
      expect(snap.rainfall_in).toBeCloseTo(1.27 / 2.54, 5);
    });

    test('no known SWFL StationID in the payload is an enrichment failure — never an arbitrary statewide station', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '110', rain_sum: '0.5' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/No FAWN station/);
    });

    test('Lee County (Fort Myers) is too far from North Port/Arcadia — no rainfall rather than a distant gauge', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '1.27' }), realShapedRow({ StationID: '490', rain_sum: '1.27' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 26.6406, longitude: -81.8723 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.out_of_coverage).toBe(true);
      // Not an outage — no `error`, so the forecast doesn't log it as one.
      expect(snap.error).toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('no coordinates is an error, never a default station', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [realShapedRow({ StationID: '480', rain_sum: '1.27' })] }));
      const snap = await FawnWeather.getRecentRainfall({});
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/Coordinates required/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a selected station with a missing/non-numeric rain_sum is an enrichment failure, not a cached null reading', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/rain_sum/);
    });

    test('an HTTP failure degrades to an error snapshot with rainfall_in null — never throws', async () => {
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 400 }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/400/);
    });

    test.each([undefined, null, '', 'unknown', '48', '95', '97', '96.5'])('rejects incomplete or invalid daily observation coverage: %s', async (num_obs) => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => [realShapedRow({ num_obs, rain_sum: '0' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(snap.rainfall_in).toBeNull();
      expect(snap.error).toMatch(/coverage/);
    });

    test.each([
      ['2026-03-06T23:45:00-05:00', '96', true],
      ['2026-03-07T23:45:00-05:00', '92', true],
      ['2026-03-07T23:45:00-05:00', '91', false],
      ['2026-03-08T23:45:00-04:00', '96', true],
      ['2026-10-30T23:45:00-04:00', '96', true],
      ['2026-10-31T23:45:00-04:00', '100', true],
      ['2026-10-31T23:45:00-04:00', '96', false],
      ['2026-11-01T23:45:00-05:00', '96', true],
      [undefined, '96', false],
      ['invalid', '96', false],
      ['2026-09-24T23:45:00', '96', false],
    ])('daily coverage follows the station calendar across DST: %s / %s', async (startTime, num_obs, complete) => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => [realShapedRow({ startTime, num_obs, rain_sum: '2.54' })],
      }));
      const snap = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      if (complete) expect(snap.rainfall_in).toBeCloseTo(1, 5);
      else {
        expect(snap.rainfall_in).toBeNull();
        expect(snap.error).toMatch(/coverage/);
      }
    });

    test('incomplete rain does not replace or extend the bounded last-good reading', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => [realShapedRow({ rain_sum: '1.27' })] }));
      const options = { latitude: 27.45, longitude: -82.57 };
      expect((await FawnWeather.getRecentRainfall(options)).rainfall_in).toBeCloseTo(0.5, 5);

      nowSpy.mockReturnValue(1_700_000_000_000 + 20 * 60 * 1000);
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => [realShapedRow({ num_obs: '48', rain_sum: '0' })] }));
      expect((await FawnWeather.getRecentRainfall(options)).rainfall_in).toBeCloseTo(0.5, 5);

      nowSpy.mockReturnValue(1_700_000_000_000 + 7 * 60 * 60 * 1000);
      const expired = await FawnWeather.getRecentRainfall(options);
      expect(expired.rainfall_in).toBeNull();
      expect(expired.error).toMatch(/coverage/);
      nowSpy.mockRestore();
    });

    // These three exercise the bounded fallback with Date.now() mocked so a
    // SECOND call's failure is a genuinely fresh fetch attempt (the raw
    // station-rows cache also has a 15min TTL, keyed only by period, not by
    // coordinate — advancing past it is what makes the second call actually
    // hit the failing fetch mock instead of silently reusing the first
    // call's cached rows).
    const T0 = 1_700_000_000_000;

    test('a later failure at the SAME coordinate reuses the last-good reading (bounded fallback)', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '1.27' })],
      }));
      const good = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(good.rainfall_in).toBeCloseTo(0.5, 5);

      nowSpy.mockReturnValue(T0 + 20 * 60 * 1000); // +20min: past the 15min row-cache TTL, well within the 6h fallback bound
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
      const fallback = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(fallback.rainfall_in).toBeCloseTo(0.5, 5);
      expect(fallback.station).toBe('North Port');

      nowSpy.mockRestore();
    });

    test('a failure for a DIFFERENT coordinate never serves another location\'s cached station reading', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '1.27' })],
      }));
      await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 }); // caches North Port

      nowSpy.mockReturnValue(T0 + 20 * 60 * 1000); // past the row-cache TTL
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
      // A coordinate never successfully fetched before — must NOT inherit
      // the other location's cached rainfall/station.
      const fallback = await FawnWeather.getRecentRainfall({ latitude: 27.22, longitude: -81.84 });
      expect(fallback.rainfall_in).toBeNull();
      expect(fallback.station).toBe('unavailable');

      nowSpy.mockRestore();
    });

    test('a failure past the fallback\'s max age returns the null/error snapshot, not a stale reading', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        json: async () => [realShapedRow({ StationID: '480', rain_sum: '1.27' })],
      }));
      await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });

      // 7 hours later — past the 6h bound — a failure must not reuse it.
      nowSpy.mockReturnValue(T0 + 7 * 60 * 60 * 1000);
      global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
      const fallback = await FawnWeather.getRecentRainfall({ latitude: 27.45, longitude: -82.57 });
      expect(fallback.rainfall_in).toBeNull();
      expect(fallback.station).toBe('unavailable');

      nowSpy.mockRestore();
    });
  });

  describe('service-report application conditions', () => {
    test('stay on Open-Meteo — FAWN is never requested for the report / FDACS conditions', async () => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          current: { time: '2026-09-26T14:00', temperature_2m: 88, relative_humidity_2m: 70, wind_speed_10m: 6, weather_code: 1 },
          hourly: { time: ['2026-09-26T13:00', '2026-09-26T14:00'], precipitation: [0.1, 0.05] },
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
