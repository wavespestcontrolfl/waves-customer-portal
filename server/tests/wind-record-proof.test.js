// Wind record with proof: the visit's saved weather carries the wind direction,
// the gust, the reading time and the wind for each hour from arrival to the
// reading. The same Open-Meteo request feeds the property forecast (tech tool,
// NWS backup), so the request and the normalized rows are pinned here too.
// Synthetic coordinates only; fetch is mocked (no network).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { unix } = require('./helpers/open-meteo-unixtime');

const NOW = new Date('2026-10-03T14:20:00Z'); // 10:20 ET (EDT)
const COORDS = { latitude: 27.1234, longitude: -82.5678 };

const pad = (n) => String(n).padStart(2, '0');

// Hourly rows 2026-10-02 00:00 .. 2026-10-03 23:00 ET. Wind speed = 5 + hour,
// gust = 10 + hour, direction = 90 + 10 * hour degrees (hour 10 -> 190 = S).
function payload({ direction = true, dropHours = [], current = {} } = {}) {
  const time = [];
  const wind_speed_10m = [];
  const wind_gusts_10m = [];
  const wind_direction_10m = [];
  const temperature_2m = [];
  const relative_humidity_2m = [];
  const precipitation = [];
  const precipitation_probability = [];
  for (let d = 2; d <= 3; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const wall = `2026-10-${pad(d)}T${pad(h)}:00`;
      if (d === 3 && dropHours.includes(h)) continue;
      time.push(unix(wall));
      wind_speed_10m.push(5 + h + 0.04);
      wind_gusts_10m.push(10 + h + 0.04);
      wind_direction_10m.push(90 + 10 * h);
      temperature_2m.push(70 + h / 2);
      relative_humidity_2m.push(60 + h);
      precipitation.push(0);
      precipitation_probability.push(10);
    }
  }
  return {
    current: {
      time: unix('2026-10-03T10:15'),
      temperature_2m: 81.4,
      relative_humidity_2m: 72,
      wind_speed_10m: 14.6,
      wind_gusts_10m: 22.4,
      ...(direction ? { wind_direction_10m: 191 } : {}),
      precipitation_probability: 35,
      weather_code: 3,
      ...current,
    },
    hourly: {
      time,
      precipitation,
      precipitation_probability,
      temperature_2m,
      relative_humidity_2m,
      wind_speed_10m,
      wind_gusts_10m,
      ...(direction ? { wind_direction_10m } : {}),
    },
  };
}

const okFetch = (body) => jest.fn(async () => ({ ok: true, json: async () => body }));

function load() {
  jest.resetModules();
  return require('../services/service-report/application-conditions');
}

const realFetch = global.fetch;
const ORIGINAL_KEY = process.env.OPEN_METEO_API_KEY;
beforeEach(() => {
  delete process.env.OPEN_METEO_API_KEY;
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick'] });
});
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPEN_METEO_API_KEY;
  else process.env.OPEN_METEO_API_KEY = ORIGINAL_KEY;
});

describe('the shared Open-Meteo request and the normalized forecast', () => {
  test('asks for wind_direction_10m in both lists and changes nothing else', async () => {
    global.fetch = okFetch(payload());
    const { fetchPropertyForecast } = load();
    await fetchPropertyForecast({ ...COORDS, now: NOW });
    const url = new URL(String(global.fetch.mock.calls[0][0]));
    expect(url.searchParams.get('current')).toBe(
      'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability,weather_code',
    );
    expect(url.searchParams.get('hourly')).toBe(
      'precipitation,precipitation_probability,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    );
    expect(url.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
    expect(url.searchParams.get('timezone')).toBe('America/New_York');
    expect(url.searchParams.get('past_days')).toBe('1');
    expect(url.searchParams.get('forecast_days')).toBe('7');
  });

  test('direction lands in every hourly row and in current; existing fields keep their values', async () => {
    global.fetch = okFetch(payload());
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ ...COORDS, from: '2026-10-03T09:00', to: '2026-10-03T11:00', now: NOW });
    expect(f.hourly.map((r) => r.wind_dir_deg)).toEqual([180, 190]);
    // The ready compass label rides beside the degrees, for the tech tool and the NWS backup.
    expect(f.hourly.map((r) => r.wind_dir)).toEqual(['S', 'S']);
    expect(f.hourly[0]).toMatchObject({ time: '2026-10-03T09:00', wind_mph: 14, wind_gust_mph: 19 });
    expect(f.current).toMatchObject({ wind_mph: 14.6, wind_gust_mph: 22.4, wind_dir_deg: 191, wind_dir: 'S', temperature_f: 81.4 });
  });

  test('a payload without wind_direction_10m still works and reads null', async () => {
    global.fetch = okFetch(payload({ direction: false }));
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ ...COORDS, from: '2026-10-03T09:00', to: '2026-10-03T11:00', now: NOW });
    expect(f.status).toBe('ok');
    expect(f.hourly.every((r) => r.wind_dir_deg === null && r.wind_dir === null)).toBe(true);
    expect(f.current.wind_dir_deg).toBeNull();
    expect(f.current.wind_dir).toBeNull();
    expect(f.current.wind_mph).toBe(14.6);
  });

  test('a non-numeric direction reads null', async () => {
    global.fetch = okFetch(payload({ current: { wind_direction_10m: 'N/A' } }));
    const { fetchPropertyForecast } = load();
    const f = await fetchPropertyForecast({ ...COORDS, now: NOW });
    expect(f.current.wind_dir_deg).toBeNull();
  });
});

describe('conditions at the visit', () => {
  test('keeps the existing values (wind_mph is the reading at the tap) and adds gust, direction and reading time', async () => {
    global.fetch = okFetch(payload());
    const { fetchOpenMeteoConditions } = load();
    const c = await fetchOpenMeteoConditions(COORDS);
    expect(c).toMatchObject({
      temp_f: 81, humidity_pct: 72, wind_mph: 15, sky: 'Cloudy', source: 'Open-Meteo', provider: 'open_meteo',
      captured_at: NOW.toISOString(), latitude: 27.1234, longitude: -82.5678,
      wind_gust_mph: 22, wind_dir_deg: 191, wind_dir: 'S',
      reading_at: new Date(unix('2026-10-03T10:15') * 1000).toISOString(),
    });
  });

  test.each([
    [0, 'N'], [11, 'N'], [12, 'NNE'], [45, 'NE'], [90, 'E'], [135, 'SE'], [191, 'S'], [225, 'SW'],
    [270, 'W'], [315, 'NW'], [348, 'NNW'], [349, 'N'], [360, 'N'],
  ])('direction %i degrees reads %s', async (deg, label) => {
    global.fetch = okFetch(payload({ current: { wind_direction_10m: deg } }));
    const { fetchOpenMeteoConditions } = load();
    expect((await fetchOpenMeteoConditions(COORDS)).wind_dir).toBe(label);
  });

  test('a payload without direction: gust and reading time stay, direction is null', async () => {
    global.fetch = okFetch(payload({ direction: false }));
    const { fetchOpenMeteoConditions } = load();
    const c = await fetchOpenMeteoConditions(COORDS);
    expect(c).toMatchObject({ wind_mph: 15, wind_gust_mph: 22, wind_dir_deg: null, wind_dir: null });
    expect(c.visit_hours.every((h) => h.wind_dir === null)).toBe(true);
  });

  describe('visit_hours', () => {
    const hoursFor = async (arrivedAt, body = payload()) => {
      global.fetch = okFetch(body);
      const { fetchOpenMeteoConditions } = load();
      return (await fetchOpenMeteoConditions({ ...COORDS, arrivedAt })).visit_hours;
    };

    test('arrival 2 hours before the reading -> the arrival hour through the reading hour (3 rows)', async () => {
      const hours = await hoursFor(new Date('2026-10-03T12:20:00Z')); // 08:20 ET
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T08:00', '2026-10-03T09:00', '2026-10-03T10:00']);
      expect(hours[2]).toEqual({
        at: new Date(unix('2026-10-03T10:00') * 1000).toISOString(),
        time: '2026-10-03T10:00',
        wind_mph: 15,
        wind_gust_mph: 20,
        wind_dir: 'S',
      });
      expect(hours[0]).toMatchObject({ wind_mph: 13, wind_gust_mph: 18, wind_dir: 'S' });
    });

    test('arrival unknown, invalid or missing -> only the reading hour', async () => {
      for (const arrived of [undefined, null, 'not a date', new Date('nope'), NaN]) {
        const hours = await hoursFor(arrived);
        expect(hours.map((h) => h.time)).toEqual(['2026-10-03T10:00']);
      }
    });

    test('arrival 6 hours before the reading -> the 4 most recent hours, reading hour included', async () => {
      const hours = await hoursFor('2026-10-03T08:20:00Z'); // 04:20 ET, an ISO string
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T07:00', '2026-10-03T08:00', '2026-10-03T09:00', '2026-10-03T10:00']);
      expect(hours[0]).toMatchObject({ wind_mph: 12, wind_gust_mph: 17, wind_dir: 'SSE' }); // 160 degrees
    });

    test('arrival after the reading -> only the reading hour', async () => {
      const hours = await hoursFor(new Date('2026-10-03T15:30:00Z').getTime()); // 11:30 ET, as epoch ms
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T10:00']);
    });

    test('arrival in the reading hour but before the reading -> only the reading hour', async () => {
      const hours = await hoursFor(new Date('2026-10-03T14:05:00Z'));
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T10:00']);
    });

    test('an hour missing from the payload is skipped, never invented', async () => {
      const hours = await hoursFor(new Date('2026-10-03T12:20:00Z'), payload({ dropHours: [9] }));
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T08:00', '2026-10-03T10:00']);
    });

    test('the reading hour missing -> the earlier hours only; nothing usable -> empty', async () => {
      const hours = await hoursFor(new Date('2026-10-03T12:20:00Z'), payload({ dropHours: [10] }));
      expect(hours.map((h) => h.time)).toEqual(['2026-10-03T08:00', '2026-10-03T09:00']);
      const none = await hoursFor(undefined, payload({ dropHours: [10] }));
      expect(none).toEqual([]);
    });

    test('fetchApplicationConditions passes the arrival through', async () => {
      global.fetch = okFetch(payload());
      const { fetchApplicationConditions } = load();
      const c = await fetchApplicationConditions({ ...COORDS, arrivedAt: new Date('2026-10-03T12:20:00Z') });
      expect(c.visit_hours).toHaveLength(3);
    });
  });
});
