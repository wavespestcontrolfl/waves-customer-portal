// The dashboard weather tile is company-wide: it keeps its named Fort Myers
// point and its 5 s deadline, but reads Open-Meteo through the shared
// property-forecast module. Fail-open: provider down -> seasonal average.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('no table'); });
  fn.schema = { hasTable: jest.fn(async () => false) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({ sendManualCustomerSms: jest.fn() }));

const express = require('express');
const { unix, hourlyEpochs, etDayHours } = require('./helpers/open-meteo-unixtime');
const router = require('../routes/admin-dashboard-ops');

let server; let base;
beforeAll(async () => {
  const app = express(); app.use('/api/admin/dashboard', router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function weather(date) {
  return realFetch(`${base}/api/admin/dashboard/weather?date=${date}`);
}

function dayPayload(date) {
  const time = [];
  const precipitation = [];
  const temperature_2m = [];
  const relative_humidity_2m = [];
  const wind_speed_10m = [];
  for (let h = 0; h < 24; h += 1) {
    time.push(unix(`${date}T${String(h).padStart(2, '0')}:00`));
    precipitation.push(h === 15 ? 0.4 : h === 16 ? 0.2 : 0);
    temperature_2m.push(h === 14 ? 96.5 : 80);
    relative_humidity_2m.push(h === 5 ? 94 : 60);
    wind_speed_10m.push(h === 15 ? 17.5 : 5);
  }
  return { hourly: { time, precipitation, temperature_2m, relative_humidity_2m, wind_speed_10m } };
}

test('daily summary from hourly rows at the named Fort Myers point, with the rain/wind/heat alerts', async () => {
  const date = '2026-10-03';
  const seen = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    seen.push(new URL(String(url)));
    return { ok: true, json: async () => dayPayload(date) };
  });
  const res = await weather(date);
  const body = await res.json();
  expect(body).toMatchObject({ source: 'open-meteo', date, temp: 96.5, humidity: 94, windSpeed: 17.5, rainfall: 0.6 });
  expect(body.alerts.map((a) => a.level)).toEqual(['red', 'amber', 'amber']);
  expect(seen).toHaveLength(1);
  expect(seen[0].searchParams.get('latitude')).toBe('26.64');
  expect(seen[0].searchParams.get('longitude')).toBe('-81.87');
});

test('provider failure falls through to the seasonal average, never an error', async () => {
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return { ok: false, status: 503 };
  });
  const res = await weather('2026-09-15');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ source: 'seasonal-average', date: '2026-09-15', alerts: [] });
});

test('an unparseable date skips the provider and falls through to the seasonal average', async () => {
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    throw new Error('provider must not be called');
  });
  const res = await weather('not-a-date');
  expect(res.status).toBe(200);
  expect((await res.json()).source).toBe('seasonal-average');
});

test('day rain is the daily-API convention (hour stamps 00:00-23:00 of that date), as the tile showed before', async () => {
  const date = '2026-08-20';
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    const payload = dayPayload(date);
    payload.hourly.precipitation = payload.hourly.precipitation.map(() => 0);
    payload.hourly.precipitation[0] = 0.25; // stamped 00:00 on the date
    payload.hourly.time.push(unix('2026-08-21T00:00')); // next day's first stamp is not part of this date
    payload.hourly.precipitation.push(0.9);
    ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m'].forEach((k) => payload.hourly[k].push(60));
    return { ok: true, json: async () => payload };
  });
  const body = await (await weather(date)).json();
  expect(body.rainfall).toBe(0.25);
});

// `count` hourly rows from ET midnight of `date` (23 on the spring-forward day, 25 on the
// fall-back day), as the provider's unixtime epochs.
function dayRows(date, count, over = {}) {
  const time = hourlyEpochs(`${date}T00:00`, count);
  const col = (fill) => time.map(() => fill);
  return {
    hourly: {
      time,
      precipitation: col(0.01),
      temperature_2m: col(80),
      relative_humidity_2m: col(60),
      wind_speed_10m: col(5),
      ...over,
    },
  };
}

function serve(payload) {
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return { ok: true, json: async () => payload };
  });
}

describe('a partial day never reports a figure built from a handful of hours', () => {
  test('an hour missing from the middle of the day -> that figure is null (as the daily API answered), others stay', async () => {
    const date = '2026-07-14';
    const payload = dayRows(date, 24);
    payload.hourly.precipitation[9] = null; // one rain hour has no reading
    serve(payload);
    const body = await (await weather(date)).json();
    expect(body).toMatchObject({ source: 'open-meteo', date, temp: 80, humidity: 60, windSpeed: 5, rainfall: null });
    expect(body.alerts).toEqual([]);
  });

  test('a payload that stops at noon -> every day figure is null, nothing partial is shown', async () => {
    const date = '2026-07-15';
    serve(dayRows(date, 12, { precipitation: Array(12).fill(0.9), temperature_2m: Array(12).fill(99) }));
    const body = await (await weather(date)).json();
    expect(body).toMatchObject({ source: 'open-meteo', date, temp: null, humidity: null, windSpeed: null, rainfall: null });
    expect(body.alerts).toEqual([]);
  });

  test('a full day sums all 24 hours', async () => {
    const date = '2026-07-16';
    serve(dayRows(date, 24));
    expect((await (await weather(date)).json()).rainfall).toBe(0.24);
  });

  test('spring-forward day expects 23 hours (02:00 does not exist)', async () => {
    const date = '2026-03-08';
    expect(etDayHours(date)).toBe(23);
    serve(dayRows(date, 23));
    expect((await (await weather(date)).json()).rainfall).toBe(0.23);
  });

  test('fall-back day expects 25 hours (01:00 occurs twice); 24 is partial', async () => {
    const full = '2026-11-01';
    expect(etDayHours(full)).toBe(25);
    serve(dayRows(full, 25));
    expect((await (await weather(full)).json()).rainfall).toBe(0.25);
    const partialFall = '2025-11-02'; // fall-back day of 2025, provider omitted the repeated hour
    expect(etDayHours(partialFall)).toBe(25);
    serve(dayRows(partialFall, 24));
    expect((await (await weather(partialFall)).json()).rainfall).toBeNull();
  });
});
