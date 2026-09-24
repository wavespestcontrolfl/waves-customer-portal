/**
 * ADMIN-BUG-R35 follow-up (codex-review P0 on the fix's first push) —
 * scope='series' was locked to admin-only, but under
 * GATE_ADMIN_COLLECTIVE_MOVE a technician could still reach the SAME
 * blast radius by sending scope='this_only' on their OWN recurring visit
 * with a changed date: the route's collective-move disclosure flow
 * (COLLECTIVE_MOVE_ACK_REQUIRED -> resubmit with seriesAck / seriesAckIds)
 * widens an ungrouped recurring anchor's date move into every future
 * occurrence, exactly like scope='series', with no additional guard.
 *
 * Fixed: the branch that performs this widening (admin-dispatch.js, the
 * `else if (job?.is_recurring === true && jobDate !== newDate)` arm) now
 * refuses a non-admin caller with 403 before ever previewing or
 * acknowledging the series move.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: 'technician' };
      req.technicianId = 'tech-1';
      req.techRole = 'technician';
      return next();
    },
  };
});
let mockVisitRow = null;
let mockOpenMembers = [];
jest.mock('../models/db', () => {
  const chain = () => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotIn', 'leftJoin', 'join', 'orderBy', 'limit', 'update', 'insert']) c[m] = () => c;
    c.select = async () => mockOpenMembers;
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
  collectiveMoveGateOn: () => process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true',
  previewSeriesMove: jest.fn().mockResolvedValue({ collective: true, movableCount: 4, occurrenceIds: ['o1', 'o2', 'o3', 'o4'], skippedCount: 0, exceptionCount: 0, conflictCount: 0 }),
}));
jest.mock('../routes/admin-schedule', () => ({
  sendRescheduleNoticeForVisit: jest.fn(async () => ({ sent: true, error: null })),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const SmartRebooker = require('../services/rebooker');
const router = require('../routes/admin-dispatch');
const { etDateString, addETDays } = require('../utils/datetime-et');

const VISIT_ID = '00000000-0000-4000-8000-000000000001';
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
  const res = await fetch(`${baseUrl}/api/admin/dispatch/${VISIT_ID}/reschedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notifyCustomer: false, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

const TODAY = etDateString(new Date());
const TARGET = etDateString(addETDays(new Date(), 7));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
  // OWN recurring visit, ungrouped (no visit_id), scheduled today, no explicit
  // window (date-only move) — is_recurring + a date change is exactly the
  // condition the collective-move branch widens to a series.
  mockVisitRow = {
    id: VISIT_ID, technician_id: 'tech-1', scheduled_date: TODAY,
    window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60,
    is_recurring: true, visit_id: null, status: 'pending',
  };
  mockOpenMembers = [];
});
afterEach(() => { delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; });

test("technician sends scope='this_only' with a changed date on their OWN recurring visit — refused 403 before any preview/ack, never reaches the rebooker", async () => {
  const { status, body } = await reschedule({ newDate: TARGET });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Admin access required for this action', code: 'admin_required' });
  expect(SmartRebooker.previewSeriesMove).not.toHaveBeenCalled();
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test("technician can't bypass it by pre-acknowledging with seriesAck/seriesAckIds either", async () => {
  const { status, body } = await reschedule({
    newDate: TARGET, seriesAck: true, seriesAckIds: ['o1', 'o2', 'o3', 'o4'],
  });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Admin access required for this action', code: 'admin_required' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('control: same-date move (no widening condition) is unaffected for a technician on their own visit', async () => {
  const { status } = await reschedule({ newDate: TODAY, newWindow: { start: '09:00', end: '10:00' } });
  expect(status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
});
