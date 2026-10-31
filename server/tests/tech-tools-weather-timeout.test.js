// get_weather_conditions must DEGRADE, never dangle. The tool calls an
// external API (open-meteo) from both the tech portal and the CI contract
// smoke; without a fetch timeout, a hanging upstream left a field tech on a
// spinner and blew the contract harness's 10s budget, redding the whole
// server check (2026-08-01). The 6s AbortSignal budget is the contract.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// The stop lookup is one chained query. The mock resolves to `mockStopRows`, or
// rejects with `mockStopError`, or never settles when `mockStopHang` is set.
let mockStopRows = [];
let mockStopError = null;
let mockStopHang = false;
jest.mock('../models/db', () => {
  const chain = {};
  ['join', 'where', 'whereNotIn', 'orderByRaw', 'limit', 'select', 'timeout'].forEach((m) => { chain[m] = jest.fn(() => chain); });
  chain.then = (resolve, reject) => {
    if (mockStopHang) return undefined;
    return (mockStopError ? Promise.reject(mockStopError) : Promise.resolve(mockStopRows)).then(resolve, reject);
  };
  const db = jest.fn(() => chain);
  db.raw = jest.fn((sql) => sql);
  return db;
});

// Fresh module per test: the shared property-forecast client caches by point,
// and these cases must not read each other's forecast.
let executeTechTool;
beforeEach(() => {
  jest.resetModules();
  mockStopRows = [];
  mockStopError = null;
  mockStopHang = false;
  ({ executeTechTool } = require('../services/intelligence-bar/tech-tools'));
});

describe('get_weather_conditions timeout budget', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('passes an abort signal so a hanging API cannot dangle the tool', async () => {
    let seenSignal = null;
    global.fetch = jest.fn((url, opts) => {
      seenSignal = opts && opts.signal;
      // Simulate the upstream hanging: resolve only when the signal aborts.
      return new Promise((resolve, reject) => {
        if (!seenSignal) return; // no signal → this promise never settles
        seenSignal.addEventListener('abort', () => reject(seenSignal.reason));
      });
    });
    const started = Date.now();
    const out = await executeTechTool('get_weather_conditions', {}, {});
    const elapsed = Date.now() - started;
    expect(seenSignal).toBeTruthy();
    expect(out).toEqual({ error: 'Could not fetch weather' });
    // Must resolve on the tool's own ~6s budget, well inside the contract
    // smoke's 10s ceiling (real timers; the signal fires at 6000ms).
    expect(elapsed).toBeLessThan(9000);
  }, 15000);

  test('normal responses are unaffected', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ current: { temperature_2m: 88.2, wind_speed_10m: 6, wind_gusts_10m: 9, precipitation_probability: 10 } }),
    }));
    const out = await executeTechTool('get_weather_conditions', {}, {});
    expect(out.spray_conditions).toBe('good');
    expect(out.temperature).toBe(88);
  });

  test('reports on the named service-area point through the shared property-forecast client', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ current: { temperature_2m: 91, wind_speed_10m: 18.4, wind_gusts_10m: 25, precipitation_probability: 10 } }),
    }));
    const out = await executeTechTool('get_weather_conditions', {}, {});
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(url.searchParams.get('latitude')).toBe('27.4');
    expect(url.searchParams.get('longitude')).toBe('-82.4');
    expect(out).toMatchObject({ spray_conditions: 'too_windy', wind_speed: 18, wind_gusts: 25, rain_probability: 10 });
  });

  test('provider failure keeps the tool\'s own error shapes', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect(await executeTechTool('get_weather_conditions', {}, {})).toEqual({ error: 'Weather API unavailable' });
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await executeTechTool('get_weather_conditions', {}, {})).toEqual({ error: 'Could not fetch weather' });
  });
});

describe('get_weather_conditions location and wording', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const TECH = { techId: 'tech-1' };
  const okWeather = (current = {}) => jest.fn(async () => ({
    ok: true,
    json: async () => ({ current: { temperature_2m: 85, wind_speed_10m: 5, wind_gusts_10m: 8, precipitation_probability: 10, ...current } }),
  }));
  const asked = () => {
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    return [url.searchParams.get('latitude'), url.searchParams.get('longitude')];
  };

  test('current (checked-in) stop is used and labeled current_stop', async () => {
    mockStopRows = [{ status: 'on_site', latitude: '27.5', longitude: '-82.55' }, { status: 'pending', latitude: '27.6', longitude: '-82.6' }];
    global.fetch = okWeather();
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.5', '-82.55']);
    expect(out.location_source).toBe('current_stop');
  });

  test('next stop is used and labeled next_stop when none is checked in', async () => {
    mockStopRows = [{ status: 'confirmed', latitude: 27.61, longitude: -82.61 }];
    global.fetch = okWeather();
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.61', '-82.61']);
    expect(out.location_source).toBe('next_stop');
  });

  test('no stops falls back to the named service-area point', async () => {
    mockStopRows = [];
    global.fetch = okWeather();
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.4', '-82.4']);
    expect(out.location_source).toBe('service_area_default');
  });

  test('no tech context never queries and uses the fallback', async () => {
    global.fetch = okWeather();
    const db = require('../models/db');
    const out = await executeTechTool('get_weather_conditions', {}, {});
    expect(db).not.toHaveBeenCalled();
    expect(out.location_source).toBe('service_area_default');
  });

  test('a DB failure falls back and still answers', async () => {
    mockStopError = new Error('connection terminated');
    global.fetch = okWeather();
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.4', '-82.4']);
    expect(out).toMatchObject({ location_source: 'service_area_default', spray_conditions: 'good' });
  });

  test('a stop lookup that never settles falls back inside the budget', async () => {
    mockStopHang = true;
    global.fetch = okWeather();
    const started = Date.now();
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.location_source).toBe('service_area_default');
  }, 10000);

  test('a 0,0 or missing pin is skipped for the next usable stop, else the fallback', async () => {
    mockStopRows = [
      { status: 'on_site', latitude: 0, longitude: 0 },
      { status: 'pending', latitude: null, longitude: null },
      { status: 'pending', latitude: '27.7', longitude: '-82.7' },
    ];
    global.fetch = okWeather();
    let out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.7', '-82.7']);
    expect(out.location_source).toBe('next_stop');

    mockStopRows = [{ status: 'on_site', latitude: '0', longitude: '0' }];
    global.fetch = okWeather();
    out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(asked()).toEqual(['27.4', '-82.4']);
    expect(out.location_source).toBe('service_area_default');
  });

  test('wind direction is the forecast module\'s label when it has one, else null', async () => {
    global.fetch = okWeather();
    expect((await executeTechTool('get_weather_conditions', {}, TECH)).wind_direction).toBeNull();
    // The shared forecast module adds the ready label wind_dir in another change; until
    // then the field is absent and the direction must be null, not an error.
    jest.resetModules();
    jest.doMock('../services/service-report/application-conditions', () => ({
      ...jest.requireActual('../services/service-report/application-conditions'),
      fetchPropertyForecast: jest.fn(async () => ({
        status: 'ok', current: { temperature_f: 80, wind_mph: 6, wind_gust_mph: 9, precipitation_probability_pct: 0, wind_dir_deg: 225, wind_dir: 'SW' },
      })),
    }));
    const { executeTechTool: run } = require('../services/intelligence-bar/tech-tools');
    expect((await run('get_weather_conditions', {}, TECH)).wind_direction).toBe('SW');
    jest.dontMock('../services/service-report/application-conditions');
  });

  test('wind at 15 mph or more uses the job card wind action; 14 mph stays good', async () => {
    global.fetch = okWeather({ wind_speed_10m: 15 });
    let out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(out.spray_conditions).toBe('too_windy');
    expect(out.recommendation).toBe('Check the wind at the nozzle. Do not spray if it drifts onto beds.');
    expect(out.recommendation).not.toMatch(/consider delaying/i);

    global.fetch = okWeather({ wind_speed_10m: 14 });
    jest.resetModules();
    ({ executeTechTool } = require('../services/intelligence-bar/tech-tools'));
    out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(out).toMatchObject({ spray_conditions: 'good', recommendation: 'Good spray conditions. Proceed normally.' });
  });

  test('rain wording is unchanged and output carries no customer name or address', async () => {
    mockStopRows = [{ status: 'on_site', latitude: '27.5', longitude: '-82.55', first_name: 'Pat', address_line1: '1 Test Way' }];
    global.fetch = okWeather({ precipitation_probability: 60 });
    const out = await executeTechTool('get_weather_conditions', {}, TECH);
    expect(out.spray_conditions).toBe('rain_likely');
    expect(out.recommendation).toMatch(/^60% rain chance/);
    expect(JSON.stringify(out)).not.toMatch(/Pat|Test Way/);
  });
});
