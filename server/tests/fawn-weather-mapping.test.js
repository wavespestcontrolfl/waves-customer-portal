/**
 * FawnWeather.getCurrent() field-mapping tests against a fixture shaped
 * like the REAL live FAWN `lastDay/summary/json` response (captured
 * 2026-09-26 while diagnosing the public pest forecast never getting a
 * FAWN rainfall reading): rows carry only a numeric `StationID` — no
 * name, county, or lat/lng field — and `rain_sum` is a SUM in
 * CENTIMETERS, not inches. The old `lastObservation/summary/` URL 400s
 * and never returns any rows at all, which is the actual root cause of
 * the null `recent_rain_in` on the public forecast.
 */

describe('FawnWeather.getCurrent — real API shape', () => {
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

  test('fetches the real lastDay/summary/json endpoint, not the old 400ing lastObservation URL', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [realShapedRow()] }));
    await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = global.fetch.mock.calls[0];
    expect(String(url)).toBe('https://fawn.ifas.ufl.edu/controller.php/lastDay/summary/json');
  });

  test('converts rain_sum from centimeters to inches (2.54cm === 1.00in)', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => [realShapedRow({ StationID: '480', rain_sum: '2.54' })],
    }));
    const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
    expect(snap.rainfall_in).toBeCloseTo(1.0, 5);
  });

  test('a zero rain_sum reads as a real 0", not null', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => [realShapedRow({ StationID: '480', rain_sum: '0' })],
    }));
    const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
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
    const snap = await FawnWeather.getCurrent({ latitude: 27.4989, longitude: -82.5748 });
    expect(snap.station).toBe('North Port');
    expect(snap.station_key).toBe('north_port');
    expect(snap.rainfall_in).toBeCloseTo(1.27 / 2.54, 5);
  });

  test('no known SWFL StationID in the payload still resolves rainfall via the fallback candidate, with no phantom station label', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => [realShapedRow({ StationID: '110', rain_sum: '0.5' })],
    }));
    const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
    expect(snap.station_key).toBeNull();
    expect(snap.rainfall_in).toBeCloseTo(0.5 / 2.54, 5);
  });

  test('an HTTP failure degrades to an error snapshot with rainfall_in null — never throws', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 400 }));
    const snap = await FawnWeather.getCurrent({ latitude: 27.45, longitude: -82.57 });
    expect(snap.rainfall_in).toBeNull();
    expect(snap.error).toMatch(/400/);
  });
});
