/**
 * POST /admin/schedule/find-time — the open-times box's list
 * (GATE_OPEN_TIMES_BOX, owner 2026-10-25 layout A) — and GET /find-time/ui.
 *
 * What this locks down:
 *  1. Gate off: a summary request that asks for openTimes answers the
 *     strip's summary exactly as a request without it does.
 *  2. Gate on: the summary covers up to 28 days (not the strip's 14), lists
 *     every technician's hours (a shared hour once per technician), scores no
 *     picked hour and builds no best-times rows.
 *  3. An outdoor booking's hours carry the rain tier the box sorts Best by;
 *     with no forecast they carry none.
 *  4. GET /ui says openTimes only when both GATE_OPEN_TIMES_BOX and
 *     GATE_BEST_TIME_HINTS are on.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
// Pin ET "now" (12:00 ET, Aug 31 2026).
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.requireActual('../services/geocoder').buildAddress,
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/weather-forecast', () => ({ getHourlyRainOutlook: jest.fn(async () => null) }));
jest.mock('../services/technician-eligibility', () => ({ absentTechDays: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/find-time', () => ({
  ...jest.requireActual('../services/scheduling/find-time'),
  findAvailableSlots: jest.fn(),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  checkArrivalPlacement: jest.fn(),
}));
jest.mock('../services/rain-out', () => ({
  ...jest.requireActual('../services/rain-out'),
  loadOccupancy: jest.fn(),
}));
jest.mock('../services/scheduling/hint-road-times', () => ({ priceChipsOnRoads: jest.fn(async (chips) => chips) }));

const express = require('express');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadOccupancy } = require('../services/rain-out');
const { checkArrivalPlacement } = require('../services/scheduling/arrival-route');
const { getHourlyRainOutlook } = require('../services/weather-forecast');
const { priceChipsOnRoads } = require('../services/scheduling/hint-road-times');
const { buildOpenTimes, OPEN_TIMES_MAX_DAYS } = require('../services/scheduling/find-time-hints');
const findTimeRouter = require('../routes/admin-schedule-find-time');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule/find-time', findTimeRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const GATES = ['GATE_BEST_TIME_HINTS', 'GATE_OPEN_TIMES_BOX', 'GATE_BOOKING_RAIN_RANK', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_SCHEDULING_CAPACITY'];
const ORIGINAL = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of GATES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

const emptyOccupancy = () => ({ rows: [], canName: () => false, nameById: new Map() });
const ADAM = { id: 't1', name: 'Fixture Tech' };
const NEW_TECH = { id: 't2', name: 'Second Fixture' };
const slot = (date, start, detour, over = {}) => ({
  date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: detour, drive_in_minutes: 5, drive_out_minutes: 5, stops_that_day: 3, technician: ADAM, ...over,
});
// Rank-sorted, as the engine returns it: the second technician's 09:00 on
// Sep 1 ranks below the first's, so the strip's dedupe keeps only the first.
const ENGINE = () => ({
  slots: [
    slot('2026-09-03', '11:00', 2),
    slot('2026-09-01', '09:00', 4),
    slot('2026-09-01', '09:00', 40, { technician: NEW_TECH }),
    slot('2026-09-20', '14:00', 6),
  ],
  evaluated: 40,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of GATES) delete process.env[name];
  process.env.GATE_BEST_TIME_HINTS = 'true';
  findAvailableSlots.mockResolvedValue(ENGINE());
  loadOccupancy.mockResolvedValue(emptyOccupancy());
});

function post(body) {
  return fetch(`${baseUrl}/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Direct coords skip the customer lookup and geocoding.
const LIST = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, hint: true, slotStepMinutes: 60, summary: true,
  dateFrom: '2026-08-31', dateTo: '2026-09-27', openTimes: true,
};

test('gate off: an openTimes request answers the strip summary, as without it', async () => {
  const asked = await (await post({ ...LIST, pickedDate: '2026-09-01', pickedStart: '09:00', bestRows: true })).json();
  const { openTimes, ...without } = LIST;
  const plain = await (await post({ ...without, pickedDate: '2026-09-01', pickedStart: '09:00', bestRows: true })).json();
  delete asked.summary.elapsed_ms;
  delete plain.summary.elapsed_ms;
  expect(asked).toEqual(plain);
  expect(asked.summary.open_times).toBeUndefined();
  // The strip's 14-day cap.
  expect(findAvailableSlots.mock.calls[0][0]).toEqual(expect.objectContaining({ dateFrom: '2026-08-31', dateTo: '2026-09-13' }));
  expect(asked.picked).toEqual(expect.objectContaining({ start: '09:00', fits: true }));
});

test('gate on: four weeks, every technician, no picked verdict, no best-times rows', async () => {
  process.env.GATE_OPEN_TIMES_BOX = 'true';
  const res = await post({ ...LIST, dateTo: '2026-10-30', pickedDate: '2026-09-01', pickedStart: '09:00', bestRows: true });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(OPEN_TIMES_MAX_DAYS).toBe(28);
  expect(findAvailableSlots.mock.calls[0][0]).toEqual(expect.objectContaining({ dateFrom: '2026-08-31', dateTo: '2026-09-27' }));
  expect(body.summary.open_times).toEqual({ from: '2026-08-31', to: '2026-09-27' });
  expect(body.summary.days).toHaveLength(28);
  const sep1 = body.summary.days.find((day) => day.date === '2026-09-01');
  expect(sep1.hours.map((hour) => [hour.start_time, hour.technician.id, hour.detour_minutes])).toEqual([
    ['09:00', 't1', 4], ['09:00', 't2', 40],
  ]);
  expect(body.summary.days.find((day) => day.date === '2026-09-20').hours.map((hour) => hour.start_time)).toEqual(['14:00']);
  expect(body.summary.best).toBeUndefined();
  expect(body.picked).toBeUndefined();
  expect(checkArrivalPlacement).not.toHaveBeenCalled();
  expect(priceChipsOnRoads).not.toHaveBeenCalled();
  // A neutral booking needs no forecast.
  expect(getHourlyRainOutlook).not.toHaveBeenCalled();
  expect(sep1.hours[0].rain_tier).toBeNull();
});

test('gate on: openTimes without summary mode is an ordinary hint', async () => {
  process.env.GATE_OPEN_TIMES_BOX = 'true';
  const { summary, ...hintOnly } = LIST;
  const body = await (await post({ ...hintOnly, topN: 2 })).json();
  expect(body.summary).toBeUndefined();
  expect(body.slots).toHaveLength(2);
});

test('an outdoor booking carries the rain tier for hours the forecast reads', async () => {
  process.env.GATE_BOOKING_RAIN_RANK = 'true';
  const wet = (h) => ({ startTime: `2026-09-01T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: h < 12 ? 80 : 10 });
  const hourly = Array.from({ length: 24 }, (_, h) => wet(h));
  const days = [
    { date: '2026-09-01', status: 'open', hours: [
      { start_time: '09:00', end_time: '10:00', detour_minutes: 4, technician: ADAM },
      { start_time: '14:00', end_time: '15:00', detour_minutes: 9, technician: ADAM },
    ] },
    { date: '2026-09-20', status: 'open', hours: [{ start_time: '14:00', end_time: '15:00', detour_minutes: 6, technician: ADAM }] },
  ];
  const lawn = [{ name: 'Lawn Fertilization' }];
  const listed = await buildOpenTimes(days, {
    today: '2026-08-31', lat: 27.4, lng: -82.5, serviceTypes: lawn, deps: { hourlyRain: jest.fn(async () => hourly) },
  });
  // Sep 1 9 AM reads wet (tier 2), 2 PM dry (tier 0); Sep 20 is past the
  // three-day horizon and competes on drive alone (tier 0).
  expect(listed.map((day) => day.hours.map((hour) => hour.rain_tier))).toEqual([[2, 0], [0]]);
  // No forecast: no tiers.
  const blind = await buildOpenTimes(days, {
    today: '2026-08-31', lat: 27.4, lng: -82.5, serviceTypes: lawn, deps: { hourlyRain: jest.fn(async () => null) },
  });
  expect(blind.flatMap((day) => day.hours.map((hour) => hour.rain_tier))).toEqual([null, null, null]);
});

test('GET /ui answers openTimes only with both gates on', async () => {
  const ui = async () => (await fetch(`${baseUrl}/admin/schedule/find-time/ui`)).json();
  expect(await ui()).toEqual({ ok: true, openTimes: false });
  process.env.GATE_OPEN_TIMES_BOX = 'true';
  expect(await ui()).toEqual({ ok: true, openTimes: true });
  delete process.env.GATE_BEST_TIME_HINTS;
  expect(await ui()).toEqual({ ok: true, openTimes: false });
});
