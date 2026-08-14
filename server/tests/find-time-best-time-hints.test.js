/**
 * POST /admin/schedule/find-time — best-time hint gating + param passthrough.
 *
 * What this locks down:
 *  1. hint:true with GATE_BEST_TIME_HINTS off answers gated:true WITHOUT
 *     running the engine (kill-switch contract: pickers render exactly as
 *     today, mirroring dispatch slot-check).
 *  2. hint:true with the gate on runs a single-day search and passes
 *     excludeServiceIds + slotStepMinutes through to the engine.
 *  3. excludeServiceIds / slotStepMinutes validation 400s on garbage.
 *  4. A request WITHOUT the hint flag is NEVER gated — the existing
 *     Find-a-Time button stays ungated regardless of env.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
// The lat/lng request path never geocodes; stubbing keeps the module's DB
// and fetch dependencies out of the suite.
jest.mock('../services/geocoder', () => ({
  geocodeAddress: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
  buildAddress: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  ...jest.requireActual('../services/scheduling/find-time'),
  findAvailableSlots: jest.fn(),
}));

const express = require('express');
const { findAvailableSlots } = require('../services/scheduling/find-time');
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

const ORIGINAL_GATE = process.env.GATE_BEST_TIME_HINTS;
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_BEST_TIME_HINTS;
  else process.env.GATE_BEST_TIME_HINTS = ORIGINAL_GATE;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BEST_TIME_HINTS;
  findAvailableSlots.mockResolvedValue({
    slots: [{ rank: 1, date: '2026-09-01', start_time: '09:00', end_time: '10:00', detour_minutes: 4, stops_that_day: 3 }],
    evaluated: 1,
  });
});

function post(body) {
  return fetch(`${baseUrl}/admin/schedule/find-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Direct coords skip customer lookup and geocoding entirely.
const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: '2026-09-01', dateTo: '2026-09-01' };

test('hint with the gate off answers gated:true and never touches the engine', async () => {
  const res = await post({ ...BASE, hint: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, gated: true, slots: [] });
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

test('hint with the gate on runs a single-day search with the new params passed through', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const res = await post({
    ...BASE, hint: true, excludeServiceIds: ['svc-1'], slotStepMinutes: 60, topN: 3,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.gated).toBeUndefined();
  expect(body.slots).toHaveLength(1);
  expect(findAvailableSlots).toHaveBeenCalledTimes(1);
  const opts = findAvailableSlots.mock.calls[0][0];
  expect(opts.dateFrom).toBe('2026-09-01');
  expect(opts.dateTo).toBe('2026-09-01');
  expect(opts.excludeServiceIds).toEqual(['svc-1']);
  expect(opts.slotStepMinutes).toBe(60);
  expect(opts.topN).toBe(3);
});

test('garbage excludeServiceIds / slotStepMinutes 400 before the engine runs', async () => {
  process.env.GATE_BEST_TIME_HINTS = 'true';
  const bad = [
    { excludeServiceIds: 'svc-1' }, // not an array
    { excludeServiceIds: [''] },
    { excludeServiceIds: [{}] },
    { excludeServiceIds: Array.from({ length: 26 }, (_, i) => `s${i}`) }, // over the 25 cap
    { slotStepMinutes: 0 },
    { slotStepMinutes: 121 },
    { slotStepMinutes: 'hourly' },
  ];
  for (const extra of bad) {
    const res = await post({ ...BASE, hint: true, ...extra });
    expect(res.status).toBe(400);
  }
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

test('without the hint flag the search is never gated, regardless of env', async () => {
  for (const gate of [undefined, 'true']) {
    if (gate === undefined) delete process.env.GATE_BEST_TIME_HINTS;
    else process.env.GATE_BEST_TIME_HINTS = gate;
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect((await res.json()).gated).toBeUndefined();
  }
  expect(findAvailableSlots).toHaveBeenCalledTimes(2);
});
