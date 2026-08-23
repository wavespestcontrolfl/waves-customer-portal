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
jest.mock('../models/db', () => {
  const chain = () => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'leftJoin', 'join', 'select', 'orderBy', 'limit', 'update', 'insert']) c[m] = () => c;
    c.first = async () => null;
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

beforeEach(() => jest.clearAllMocks());

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
