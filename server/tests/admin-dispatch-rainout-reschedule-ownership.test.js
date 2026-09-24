/**
 * ADMIN-BUG-R35 (audit repro r1-authz-2) — technician token used to be able
 * to rain-out / reschedule ANOTHER technician's visit via the dispatch
 * router (no ownership predicate), and could rain-out scope='route' or
 * reschedule scope='series' (whole-route / whole-plan blast radius) even on
 * its OWN visit.
 *
 * Fixed: an ownership check (completionOwnershipError) runs before either
 * route reaches RainOut.commit / SmartRebooker.rescheduleSeries, and
 * scope='route' / scope='series' are additionally admin-only. Contrast:
 * tech-track.js:626 already answers 403 'Not assigned to this service' for
 * the same actor/visit pair on POST /api/tech/services/:id/rain-out.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-A', role: 'technician' };
      req.technicianId = 'tech-A';
      req.techRole = 'technician';
      return next();
    },
  };
});
let mockVisitRow = null;
let mockOpenMembers = [];
jest.mock('../models/db', () => {
  const norm = (col) => String(col).replace(/^scheduled_services\./, '');
  const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
  const chain = () => {
    const c = { _eq: {}, _notIn: {}, _cmp: [] };
    c.where = (w, opOrVal, val) => {
      if (typeof w === 'function') { w.call(c); return c; }
      if (w && typeof w === 'object') Object.assign(c._eq, w);
      else if (val !== undefined) c._cmp.push([norm(w), opOrVal, val]);
      else c._eq[norm(w)] = opOrVal;
      return c;
    };
    c.whereNotIn = (col, vals) => { c._notIn[norm(col)] = vals; return c; };
    c.whereNot = (col, val) => { c._notIn[norm(col)] = [val]; return c; };
    for (const m of ['whereIn', 'whereNull', 'whereNotNull', 'forUpdate', 'leftJoin', 'join', 'orderBy', 'limit', 'update', 'insert']) c[m] = () => c;
    c.select = async () => mockOpenMembers;
    // Real (if minimal) predicate matching — this is what lets
    // lockOwnedLiveVisit's technicianLiveVisitFilter actually refuse a row
    // that fails the check, instead of returning mockVisitRow unconditionally
    // regardless of what the caller's WHERE asked for.
    c.first = async () => {
      if (!mockVisitRow) return mockVisitRow;
      const eqOk = Object.entries(c._eq).every(([k, v]) => mockVisitRow[k] === v);
      const notInOk = Object.entries(c._notIn).every(([k, vals]) => !vals.includes(mockVisitRow[k]));
      const cmpOk = c._cmp.every(([k, op, v]) => cmp(mockVisitRow[k], op, v));
      return (eqOk && notInOk && cmpOk) ? mockVisitRow : undefined;
    };
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
jest.mock('../services/rain-out', () => ({
  commit: jest.fn().mockResolvedValue({ ok: true, results: [], qualityDates: [] }),
  getOptions: jest.fn(),
}));
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn().mockResolvedValue({ success: true }),
  rescheduleSeries: jest.fn().mockResolvedValue({ success: true, rescheduledOccurrences: [] }),
  applyLiveMovePostCommitEffects: jest.fn(),
  collectiveMoveGateOn: () => false,
  previewSeriesMove: jest.fn().mockResolvedValue({ collective: false }),
}));
jest.mock('../routes/admin-schedule', () => ({
  sendRescheduleNoticeForVisit: jest.fn(async () => ({ sent: true, error: null })),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const RainOut = require('../services/rain-out');
const SmartRebooker = require('../services/rebooker');
const router = require('../routes/admin-dispatch');
const { etDateString, addETDays } = require('../utils/datetime-et');

const OTHER_TECH_VISIT = '00000000-0000-4000-8000-0000000000b2';
let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function post(path, body) {
  const res = await fetch(`${baseUrl}/api/admin/dispatch/${OTHER_TECH_VISIT}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => { jest.clearAllMocks(); mockOpenMembers = []; });

test("technician tech-A is refused rain-ing-out tech-B's visit — ownership check refuses before RainOut.commit is reached", async () => {
  mockVisitRow = { id: OTHER_TECH_VISIT, technician_id: 'tech-B', scheduled_date: etDateString(new Date()), status: 'pending' };
  const target = { date: etDateString(addETDays(new Date(), 1)), window: { start: '09:00', end: '10:00' } };
  const { status, body } = await post('rain-out', { reasonCode: 'rain', scope: 'route', target });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  expect(RainOut.commit).not.toHaveBeenCalled();
});

test("technician tech-A is refused a scope='route' rain-out even on tech-A's OWN visit — admin-only blast radius", async () => {
  mockVisitRow = { id: OTHER_TECH_VISIT, technician_id: 'tech-A', scheduled_date: etDateString(new Date()), status: 'pending' };
  const target = { date: etDateString(addETDays(new Date(), 1)), window: { start: '09:00', end: '10:00' } };
  const { status, body } = await post('rain-out', { reasonCode: 'rain', scope: 'route', target });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Admin access required for this action', code: 'admin_required' });
  expect(RainOut.commit).not.toHaveBeenCalled();
});

test("technician tech-A is refused rescheduling tech-B's visit as a SERIES — ownership check refuses before the rebooker is reached", async () => {
  mockVisitRow = { id: OTHER_TECH_VISIT, technician_id: 'tech-B', scheduled_date: etDateString(addETDays(new Date(), 2)), window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, is_recurring: true, status: 'pending' };
  const newDate = etDateString(addETDays(new Date(), 7));
  const { status, body } = await post('reschedule', { newDate, newWindow: { start: '09:00', end: '10:00' }, scope: 'series' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
});

test("technician tech-A is refused a scope='series' reschedule even on tech-A's OWN visit — admin-only blast radius", async () => {
  mockVisitRow = { id: OTHER_TECH_VISIT, technician_id: 'tech-A', scheduled_date: etDateString(addETDays(new Date(), 2)), window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, is_recurring: true, status: 'pending' };
  const newDate = etDateString(addETDays(new Date(), 7));
  const { status, body } = await post('reschedule', { newDate, newWindow: { start: '09:00', end: '10:00' }, scope: 'series' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Admin access required for this action', code: 'admin_required' });
  expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
});
