// One property-forecast module (lawn rebuild P29): hourly rain in INCHES,
// temperature and humidity at the property's coordinates, fail-open, cached
// per property. Synthetic coordinates only; fetch is mocked (no network).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const NOW = new Date('2026-10-03T14:20:00Z'); // 10:20 ET (EDT)

// Hourly rows 2026-10-02 00:00 .. 2026-10-09 23:00 ET (past_days=1 + forecast_days=7),
// ET wall-clock strings the way Open-Meteo returns them with timezone=America/New_York.
function hourlyPayload({ rainAt = {}, base = 0 } = {}) {
  const time = [];
  const precipitation = [];
  const temperature_2m = [];
  const relative_humidity_2m = [];
  const precipitation_probability = [];
  for (let d = 2; d <= 9; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const t = `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
      time.push(t);
      precipitation.push(rainAt[t] ?? base);
      temperature_2m.push(70 + h / 2);
      relative_humidity_2m.push(60 + h);
      precipitation_probability.push(rainAt[t] ? 80 : 10);
    }
  }
  return {
    current: {
      time: '2026-10-03T10:15', temperature_2m: 81.4, relative_humidity_2m: 72, wind_speed_10m: 6.2, wind_gusts_10m: 11,
      precipitation_probability: 35, weather_code: 3,
    },
    hourly: { time, precipitation, temperature_2m, relative_humidity_2m, precipitation_probability },
  };
}

function okFetch(payload) {
  return jest.fn(async () => ({ ok: true, json: async () => payload }));
}

function load() {
  jest.resetModules();
  return require('../services/service-report/application-conditions');
}

describe('fetchPropertyForecast', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const RAIN = { '2026-10-03T12:00': 0.12, '2026-10-03T13:00': 0.05 };

  test('states no rain total when the payload skips an hour or stops short of the window', async () => {
    const drop = (payload, times) => {
      const keep = payload.hourly.time.map((t) => !times.includes(t));
      const hourly = Object.fromEntries(Object.entries(payload.hourly).map(([k, v]) => [k, v.filter((_, i) => keep[i])]));
      return { ...payload, hourly };
    };
    // A skipped hour inside the window: the hours that did arrive are still returned.
    global.fetch = okFetch(drop(hourlyPayload({ rainAt: RAIN }), ['2026-10-03T13:00']));
    let { fetchPropertyForecast } = load();
    const gap = await fetchPropertyForecast({
      latitude: 27.1234, longitude: -82.5678, from: '2026-10-03T12:00', to: '2026-10-03T15:00', now: NOW,
    });
    expect(gap.status).toBe('ok');
    expect(gap.hourly.map((r) => r.time)).toEqual(['2026-10-03T12:00', '2026-10-03T14:00']);
    expect(gap.precipitationInTotal).toBeNull();

    // A payload that ends before the window does.
    global.fetch = okFetch(drop(hourlyPayload({ rainAt: RAIN }), ['2026-10-03T14:00']));
    ({ fetchPropertyForecast } = load());
    const short = await fetchPropertyForecast({
      latitude: 27.1234, longitude: -82.5678, from: '2026-10-03T12:00', to: '2026-10-03T15:00', now: NOW,
    });
    expect(short.precipitationInTotal).toBeNull();
  });

  test('returns quantitative hourly inches, temperature, humidity, source and fetch time for the window', async () => {
    global.fetch = okFetch(hourlyPayload({ rainAt: RAIN }));
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({
      latitude: 27.1234, longitude: -82.5678, from: '2026-10-03T12:00', to: '2026-10-03T15:00', now: NOW,
    });
    expect(f.status).toBe('ok');
    expect(f.source).toBe('open_meteo');
    expect(f.fetchedAt).toBe(NOW.toISOString());
    expect(f.cached).toBe(false);
    expect(f.hourly).toHaveLength(3);
    expect(f.hourly[0]).toMatchObject({
      time: '2026-10-03T12:00', at: '2026-10-03T16:00:00.000Z', precipitation_in: 0.12, temperature_f: 76, humidity_pct: 72,
      precipitation_probability_pct: 80,
    });
    expect(f.precipitationInTotal).toBe(0.17);
    expect(f.current).toMatchObject({ temperature_f: 81.4, humidity_pct: 72, wind_mph: 6.2, wind_gust_mph: 11, precipitation_probability_pct: 35 });
  });

  test('asks the provider for hourly precipitation in inches at the rounded property point', async () => {
    global.fetch = okFetch(hourlyPayload());
    const { fetchPropertyForecast } = load();
    await fetchPropertyForecast({ latitude: 27.12341, longitude: -82.56784, now: NOW });
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(url.hostname).toBe('api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('27.123');
    expect(url.searchParams.get('longitude')).toBe('-82.568');
    expect(url.searchParams.get('precipitation_unit')).toBe('inch');
    expect(url.searchParams.get('hourly').split(',')).toEqual(expect.arrayContaining(['precipitation', 'temperature_2m', 'relative_humidity_2m']));
    expect(url.searchParams.get('timezone')).toBe('America/New_York');
  });

  test('default window is the current ET hour through the next 24 hours', async () => {
    global.fetch = okFetch(hourlyPayload());
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW });
    expect(f.hourly).toHaveLength(24);
    expect(f.hourly[0].time).toBe('2026-10-03T10:00');
    expect(f.hourly[23].time).toBe('2026-10-04T09:00');
  });

  test('a window with a missing hour reports a null total rather than a partial one', async () => {
    const payload = hourlyPayload({ rainAt: RAIN });
    payload.hourly.precipitation[24 + 12] = null; // 2026-10-03T12:00
    global.fetch = okFetch(payload);
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, from: '2026-10-03T12:00', to: '2026-10-03T14:00', now: NOW });
    expect(f.status).toBe('ok');
    expect(f.precipitationInTotal).toBeNull();
  });

  test('a window outside the standard span is fetched by date range', async () => {
    // A full day of hourly readings, so the total over the day can be stated.
    const time = Array.from({ length: 24 }, (_, h) => `2026-09-01T${String(h).padStart(2, '0')}:00`);
    global.fetch = okFetch({ hourly: { time, precipitation: time.map((_, h) => (h === 0 ? 0.3 : 0)) } });
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, from: '2026-09-01T00:00', to: '2026-09-02T00:00', now: NOW });
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(url.searchParams.get('start_date')).toBe('2026-09-01');
    expect(url.searchParams.get('end_date')).toBe('2026-09-01');
    expect(url.searchParams.get('past_days')).toBeNull();
    expect(f.precipitationInTotal).toBe(0.3);
  });

  describe('fail-open: always a typed unavailable result, never a throw or a hang', () => {
    test('timeout, even when the fetch ignores its abort signal', async () => {
      global.fetch = jest.fn(() => new Promise(() => {}));
      const { fetchPropertyForecast } = load();
      const started = Date.now();
      const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, timeoutMs: 40, now: NOW });
      expect(f).toMatchObject({ status: 'unavailable', reason: 'timeout', source: 'open_meteo' });
      expect(Date.now() - started).toBeLessThan(1500);
    });

    test('a body that never finishes is a timeout too', async () => {
      global.fetch = jest.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }));
      const { fetchPropertyForecast } = load();
      const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, timeoutMs: 40, now: NOW });
      expect(f).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    });

    test('HTTP error, network error, synchronous throw and an empty payload', async () => {
      const { fetchPropertyForecast } = load();
      global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
      expect(await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW })).toMatchObject({ status: 'unavailable', reason: 'http_error' });
      global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
      expect(await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW })).toMatchObject({ status: 'unavailable', reason: 'network_error' });
      global.fetch = jest.fn(() => { throw new Error('sync boom'); });
      expect(await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW })).toMatchObject({ status: 'unavailable', reason: 'network_error' });
      global.fetch = okFetch({});
      expect(await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW })).toMatchObject({ status: 'unavailable', reason: 'bad_payload' });
    });

    test('missing or impossible coordinates never reach the provider', async () => {
      global.fetch = jest.fn();
      const { fetchPropertyForecast } = load();
      for (const coords of [{}, { latitude: null, longitude: null }, { latitude: 0, longitude: 0 }, { latitude: 'x', longitude: -82 }, { latitude: 95, longitude: -82 }]) {
        expect(await fetchPropertyForecast({ ...coords, now: NOW })).toMatchObject({ status: 'unavailable', reason: 'no_coordinates' });
      }
      expect(await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, from: NOW, to: NOW, now: NOW })).toMatchObject({ reason: 'bad_window' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('cache', () => {
    test('a second call for the same property reuses the fetch, whatever the window', async () => {
      global.fetch = okFetch(hourlyPayload({ rainAt: RAIN }));
      const { fetchPropertyForecast } = load();
      const first = await fetchPropertyForecast({ latitude: 27.1234, longitude: -82.5678, from: '2026-10-03T12:00', to: '2026-10-03T14:00', now: NOW });
      const later = new Date(NOW.getTime() + 5 * 60 * 1000);
      const second = await fetchPropertyForecast({ latitude: 27.1234, longitude: -82.5678, from: '2026-10-04T06:00', to: '2026-10-04T09:00', now: later });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.fetchedAt).toBe(first.fetchedAt);
      expect(second.hourly.map((h) => h.time)).toEqual(['2026-10-04T06:00', '2026-10-04T07:00', '2026-10-04T08:00']);
    });

    test('maxAgeMs 0 and an expired entry both refetch', async () => {
      global.fetch = okFetch(hourlyPayload());
      const { fetchPropertyForecast } = load();
      await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW });
      await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW, maxAgeMs: 0 });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: new Date(NOW.getTime() + 11 * 60 * 1000) });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('an unavailable result is never cached', async () => {
      const { fetchPropertyForecast } = load();
      global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
      await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW });
      global.fetch = okFetch(hourlyPayload());
      const f = await fetchPropertyForecast({ latitude: 27.1, longitude: -82.5, now: NOW });
      expect(f.status).toBe('ok');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('properties a block apart do not share a cached result; points within ~110 m do', async () => {
      // The provider answers per point: rain depends on the latitude it is asked about.
      global.fetch = jest.fn(async (url) => {
        const lat = Number(new URL(String(url)).searchParams.get('latitude'));
        return { ok: true, json: async () => hourlyPayload({ rainAt: lat < 27.1235 ? { '2026-10-03T12:00': 0.5 } : {} }) };
      });
      const { fetchPropertyForecast } = load();
      const win = { from: '2026-10-03T12:00', to: '2026-10-03T13:00', now: NOW };
      const a = await fetchPropertyForecast({ latitude: 27.1230, longitude: -82.5678, ...win });
      const b = await fetchPropertyForecast({ latitude: 27.1240, longitude: -82.5678, ...win }); // ~110 m north: different key
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(a.precipitationInTotal).toBe(0.5);
      expect(b.precipitationInTotal).toBe(0);
      const c = await fetchPropertyForecast({ latitude: 27.12302, longitude: -82.56781, ...win }); // same rounded point as a
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(c.cached).toBe(true);
      expect(c.precipitationInTotal).toBe(0.5);
    });
  });
});

describe('etDayWindow', () => {
  test('ET midnight to ET midnight, 23 hours on the spring-forward day, null for junk', () => {
    const { etDayWindow } = load();
    const normal = etDayWindow('2026-10-03');
    expect(normal.from.toISOString()).toBe('2026-10-03T04:00:00.000Z');
    expect(normal.to.toISOString()).toBe('2026-10-04T04:00:00.000Z');
    const spring = etDayWindow('2026-03-08');
    expect((spring.to - spring.from) / 3600000).toBe(23);
    expect(etDayWindow('tomorrow')).toBeNull();
    expect(etDayWindow(undefined)).toBeNull();
  });
});

describe('fetchOpenMeteoConditions rides the shared forecast path', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('same client and cache: the conditions fetch warms the cache for forecast callers, and is itself always fresh', async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick'] });
    try {
      global.fetch = okFetch(hourlyPayload({ rainAt: { '2026-10-03T09:00': 0.2, '2026-10-03T22:00': 0.1 } }));
      const { fetchOpenMeteoConditions, fetchPropertyForecast } = load();
      const conditions = await fetchOpenMeteoConditions({ latitude: 27.1234, longitude: -82.5678 });
      expect(conditions).toMatchObject({ provider: 'open_meteo', temp_f: 81, humidity_pct: 72, wind_mph: 6, sky: 'Cloudy' });
      // legacy window: current.time 10:15 matches no slot -> ends at the last slot of that ET day, so tonight's model rain counts
      expect(conditions.rain_24h_in).toBeCloseTo(0.3, 2);
      const forecast = await fetchPropertyForecast({ latitude: 27.1234, longitude: -82.5678, now: NOW });
      expect(forecast.cached).toBe(true);
      await fetchOpenMeteoConditions({ latitude: 27.1234, longitude: -82.5678 });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('unavailable forecast -> null, no coordinates -> the named service-area point', async () => {
    const { fetchOpenMeteoConditions, SERVICE_AREA_DEFAULT_LOCATION } = load();
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect(await fetchOpenMeteoConditions({ latitude: 27.1, longitude: -82.5 })).toBeNull();
    global.fetch = okFetch(hourlyPayload());
    await fetchOpenMeteoConditions({ latitude: null, longitude: undefined });
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(Number(url.searchParams.get('latitude'))).toBe(SERVICE_AREA_DEFAULT_LOCATION.latitude);
    expect(Number(url.searchParams.get('longitude'))).toBe(SERVICE_AREA_DEFAULT_LOCATION.longitude);
  });
});
