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
    time.push(`${date}T${String(h).padStart(2, '0')}:00`);
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
