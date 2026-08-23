/**
 * Dispatch reschedule — shared admin window rules at the route entry.
 *
 * POST /:serviceId/reschedule persisted any HH:MM-HH:MM the Day grid sent
 * (06:30 drops, pre-8am starts). The route now runs the window through
 * scheduling/window-rules.js BEFORE the rebooker and answers 422
 * INVALID_APPOINTMENT_WINDOW; the rebooker is never reached.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
// The visit row the route resolves windows against (scheduled_services
// .first()); null = not found.
let mockVisitRow = null;
jest.mock('../models/db', () => {
  const chain = () => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'leftJoin', 'join', 'select', 'orderBy', 'limit', 'update', 'insert']) c[m] = () => c;
    c.first = async () => mockVisitRow;
    c.then = (resolve) => Promise.resolve([]).then(resolve);
    return c;
  };
  const proxy = () => chain();
  proxy.transaction = async (cb) => cb(proxy);
  proxy.raw = () => ({});
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  rescheduleSeries: jest.fn().mockResolvedValue({ success: true, rescheduledOccurrences: [] }),
  applyLiveMovePostCommitEffects: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const SmartRebooker = require('../services/rebooker');
const router = require('../routes/admin-dispatch');
const { etDateString, addETDays } = require('../utils/datetime-et');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function reschedule(body) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/00000000-0000-4000-8000-000000000001/reschedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notifyCustomer: false, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

const TARGET = etDateString(addETDays(new Date(), 7));

beforeEach(() => { jest.clearAllMocks(); mockVisitRow = null; });

test('a 06:30 drop is refused with 422 INVALID_APPOINTMENT_WINDOW before the rebooker runs', async () => {
  const { status, body } = await reschedule({ newDate: TARGET, newWindow: '06:30-07:30' });
  expect(status).toBe(422);
  expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
  expect(body.error).toMatch(/on the hour/);
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('a pre-8am on-the-hour window and a series-scope half-hour window are refused the same way', async () => {
  let r = await reschedule({ newDate: TARGET, newWindow: { start: '07:00', end: '08:00' } });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatch(/before 08:00/);
  r = await reschedule({ newDate: TARGET, newWindow: '09:30-10:30', scope: 'series' });
  expect(r.status).toBe(422);
  expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
});

test('an on-the-hour window inside the day reaches the rebooker', async () => {
  const { status } = await reschedule({ newDate: TARGET, newWindow: '09:00-10:00' });
  expect(status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
});

test('a SUPPLIED but malformed window (truncated range / end-only object / {}) is 422, never a silent date-only move', async () => {
  for (const bad of ['09:00-', '9am-10am', { end: '10:00' }, {}]) {
    const { status, body } = await reschedule({ newDate: TARGET, newWindow: bad });
    expect(status).toBe(422);
    expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
  }
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('an absent / null / empty window is a date-only move and reaches the rebooker', async () => {
  for (const none of [undefined, null, '']) {
    const { status } = await reschedule({ newDate: TARGET, newWindow: none });
    expect(status).toBe(200);
  }
  expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(3);
});

describe('window resolved against the CURRENT visit row', () => {
  test("{ start } on a 2-hour visit derives and validates the REAL end: 19:00 → 19:00-21:00 is refused (never 19:00-11:00)", async () => {
    mockVisitRow = { window_start: '09:00:00', window_end: '11:00:00', estimated_duration_minutes: null };
    const { status, body } = await reschedule({ newDate: TARGET, newWindow: { start: '19:00' } });
    expect(status).toBe(422);
    expect(body.error).toMatch(/end by 20:00/);
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('{ start } submits the derived end explicitly to the rebooker', async () => {
    mockVisitRow = { window_start: '09:00:00', window_end: '11:00:00', estimated_duration_minutes: null };
    const { status } = await reschedule({ newDate: TARGET, newWindow: { start: '10:00' } });
    expect(status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
      expect.any(String), TARGET, { start: '10:00', end: '12:00' }, 'admin', 'admin', expect.any(Object),
    );
  });

  test('{ start } falls back to estimated_duration_minutes; with no derivable duration an explicit end is required (422)', async () => {
    mockVisitRow = { window_start: '09:00:00', window_end: null, estimated_duration_minutes: 90 };
    let r = await reschedule({ newDate: TARGET, newWindow: { start: '10:00' } });
    expect(r.status).toBe(200);
    expect(SmartRebooker.reschedule.mock.calls[0][2]).toEqual({ start: '10:00', end: '11:30' });
    mockVisitRow = { window_start: null, window_end: null, estimated_duration_minutes: null };
    r = await reschedule({ newDate: TARGET, newWindow: { start: '10:00' } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/explicit end/);
  });

  test('date-only move: a legacy 07:00 stored window is refused (422); a windowless row still moves', async () => {
    mockVisitRow = { window_start: '07:00:00', window_end: '08:00:00' };
    let r = await reschedule({ newDate: TARGET });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/before 08:00/);
    r = await reschedule({ newDate: TARGET, scope: 'series' });
    expect(r.status).toBe(422);
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
    mockVisitRow = { window_start: null, window_end: null };
    r = await reschedule({ newDate: TARGET });
    expect(r.status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
  });
});

test('date-only move of a 19:00 end-less 120-min row is refused (19:00-21:00), a 60-min one reaches the rebooker', async () => {
  mockVisitRow = { window_start: '19:00:00', window_end: null, estimated_duration_minutes: 120 };
  let r = await reschedule({ newDate: TARGET });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatch(/end by 20:00/);
  mockVisitRow = { window_start: '19:00:00', window_end: null, estimated_duration_minutes: 60 };
  r = await reschedule({ newDate: TARGET });
  expect(r.status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
});

test('series scope hands the RAW window to the rebooker with adminWindowRules so each occurrence derives + validates its own window', async () => {
  mockVisitRow = { window_start: '09:00:00', window_end: '11:00:00', estimated_duration_minutes: null };
  const { status } = await reschedule({ newDate: TARGET, newWindow: { start: '10:00' }, scope: 'series' });
  expect(status).toBe(200);
  expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledWith(
    expect.any(String), TARGET, { start: '10:00' }, 'admin', 'admin', { allowLive: true, adminWindowRules: true },
  );
});

test('an explicit newWindow: null on a WINDOWLESS row is a 200 date-only move (the Day grid bulk move shape)', async () => {
  mockVisitRow = { window_start: null, window_end: null, estimated_duration_minutes: null };
  const { status } = await reschedule({ newDate: TARGET, newWindow: null });
  expect(status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledWith(expect.any(String), TARGET, null, 'admin', 'admin', expect.any(Object));
});
