/**
 * POST /admin/schedule/find-time: the staff line for a stopped Google
 * spending limit (GATE_PICKER_ROAD_LIMIT_NOTICE, owner 2026-10-29, route-
 * dispatcher audit fix F). The real spend counter (picker-road-spend.js) runs
 * inside the mocked search, so the refusal reaches the answer through the
 * route's request scope, not through a hand-set field.
 *
 * What this locks down: gate off = the answer is exactly what it was (no
 * `road_limit`); gate on = each refusal adds `road_limit: { reason, note }`
 * and nothing else changes; a normal search, and the request after a stopped
 * one, carry none.
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
jest.mock('../services/scheduling/hint-road-times', () => ({
  priceChipsOnRoads: jest.fn(async (chips) => chips),
  createPickerBudget: jest.fn(() => ({ traffic: 0, plain: 0, signal: null, refused: null })),
}));
jest.mock('../services/technician-capabilities', () => ({ inactiveCapabilitiesForServices: jest.fn(async () => []) }));

const express = require('express');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadOccupancy } = require('../services/rain-out');
const { reserveRoadSpend } = require('../services/scheduling/picker-road-spend');
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

const GATES = ['GATE_BEST_TIME_HINTS', 'GATE_OPEN_TIMES_BOX', 'GATE_PICKER_ROAD_LIMIT_NOTICE', 'PICKER_ROAD_DAILY_CAP_CENTS'];
const ORIGINAL = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of GATES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

const emptyOccupancy = () => ({ rows: [], canName: () => false, nameById: new Map() });
const ADAM = { id: 't1', name: 'Fixture Tech' };
const slot = (date, start, detour) => ({
  date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  detour_minutes: detour, drive_in_minutes: 5, drive_out_minutes: 5, stops_that_day: 3, technician: ADAM,
});

// What the engine's Google purchase finds: a transaction double that either
// counts the lookups or trips the daily cap, or no counter at all.
const counter = (rows) => ({ transaction: async (work) => work(Object.assign(() => { const q = { where: () => q, sum: () => q, first: async () => ({ pro: 0, plain: 0 }) }; return q; }, { raw: async () => ({ rows }) })) });
const buying = {
  nothing: null,
  fine: () => reserveRoadSpend({ spender: 't1', pro: 5, conn: counter([{ bucket: 'all', pro_elements: 5, plain_elements: 0 }, { bucket: 'staff:t1', pro_elements: 5, plain_elements: 0 }]) }),
  dayCap: () => reserveRoadSpend({ spender: 't1', pro: 5, conn: counter([{ bucket: 'all', pro_elements: 1001, plain_elements: 0 }, { bucket: 'staff:t1', pro_elements: 5, plain_elements: 0 }]) }),
  monthCap: () => reserveRoadSpend({ spender: 't1', pro: 5, conn: counter([{ bucket: 'all', pro_elements: 5, plain_elements: 0 }, { bucket: 'staff:t1', pro_elements: 5, plain_elements: 0 }]), now: new Date('2026-08-31T16:00:00Z') }),
  noCounter: () => reserveRoadSpend({ spender: 't1', pro: 5, conn: { transaction: async () => { throw new Error('connection refused'); } } }),
};
let purchase = null;

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of GATES) delete process.env[name];
  process.env.GATE_BEST_TIME_HINTS = 'true';
  purchase = buying.nothing;
  // The real engine buys road times inside this call; the test buys one batch.
  findAvailableSlots.mockImplementation(async () => {
    if (purchase) await purchase();
    return { slots: [slot('2026-09-01', '09:00', 4), slot('2026-09-03', '11:00', 2)], evaluated: 40 };
  });
  loadOccupancy.mockResolvedValue(emptyOccupancy());
});

function post(body) {
  return fetch(`${baseUrl}/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const LIST = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, hint: true, slotStepMinutes: 60, summary: true,
  dateFrom: '2026-08-31', dateTo: '2026-09-27', openTimes: true,
};
const answer = async (body = LIST) => {
  const res = await post(body);
  expect(res.status).toBe(200);
  const json = await res.json();
  if (json.summary) delete json.summary.elapsed_ms;
  return json;
};

describe('GATE_PICKER_ROAD_LIMIT_NOTICE on the find-time answer', () => {
  test('gate off: a stopped limit changes nothing in the answer', async () => {
    const quiet = await answer();
    purchase = buying.dayCap;
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '100';
    const stopped = await answer();
    expect(stopped).toEqual(quiet);
    expect(stopped).not.toHaveProperty('road_limit');
  });

  test.each([
    ['the account\'s day', 'dayCap', 'daily_cap', 'Google road times paused: daily limit reached. Times marked ~ use the estimate.'],
    ['no counter', 'noCounter', 'counter_unavailable', 'Google road times paused: the spending counter is unavailable. Times marked ~ use the estimate.'],
  ])('gate on, %s: the answer carries the staff line, and nothing else changes', async (_name, key, reason, note) => {
    const quiet = await answer();
    process.env.GATE_PICKER_ROAD_LIMIT_NOTICE = 'true';
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '100';
    purchase = buying[key];
    const stopped = await answer();
    expect(stopped.road_limit).toEqual({ reason, note });
    const { road_limit: _line, ...rest } = stopped;
    expect(rest).toEqual(quiet);
  });

  test('gate on, the month limit: the line says month', async () => {
    process.env.GATE_PICKER_ROAD_LIMIT_NOTICE = 'true';
    process.env.PICKER_ROAD_MONTHLY_CAP_CENTS = '0';
    purchase = buying.monthCap;
    try {
      expect((await answer()).road_limit).toEqual({
        reason: 'monthly_cap', note: 'Google road times paused: month limit reached. Times marked ~ use the estimate.',
      });
    } finally {
      delete process.env.PICKER_ROAD_MONTHLY_CAP_CENTS;
    }
  });

  test('gate on, a normal search: no new field', async () => {
    process.env.GATE_PICKER_ROAD_LIMIT_NOTICE = 'true';
    purchase = buying.fine;
    expect(await answer()).not.toHaveProperty('road_limit');
    purchase = buying.nothing;
    expect(await answer()).not.toHaveProperty('road_limit');
  });

  test('gate on: one request\'s stopped limit never shows on the next', async () => {
    process.env.GATE_PICKER_ROAD_LIMIT_NOTICE = 'true';
    process.env.PICKER_ROAD_DAILY_CAP_CENTS = '100';
    purchase = buying.dayCap;
    expect(await answer()).toHaveProperty('road_limit');
    purchase = buying.nothing;
    expect(await answer()).not.toHaveProperty('road_limit');
  });
});
