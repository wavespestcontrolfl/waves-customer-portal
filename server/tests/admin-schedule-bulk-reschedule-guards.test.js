/**
 * Bulk-action 'reschedule' guards.
 *
 * The bulk mover previously moved ANY selected row to ANY date: terminal
 * rows (resurrecting finished/cancelled visits), past target dates (visits
 * no upcoming query ever finds), live rows with stale tracker timestamps,
 * and all without a reschedule_log audit row. These pin, via the real route:
 *   - terminal rows land in failed[] per-row (batch keeps going)
 *   - a past scheduledDate lands in failed[] per-row
 *   - moved rows get a reschedule_log row (initiated_by 'admin_bulk')
 *   - en_route/on_site rows get the rebooker LIVE_LIFECYCLE_RESET
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
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/estimate-deposits', () => ({
  restoreDepositCreditForVoidedInvoice: jest.fn().mockResolvedValue({ restored: true }),
}));
jest.mock('../services/customer-credit', () => ({
  restoreAccountCreditForVoidedInvoice: jest.fn().mockResolvedValue({ restored: true }),
}));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn().mockResolvedValue({ status: 'canceled' }),
}));
jest.mock('../services/call-booking-catalog', () => ({
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
  cancelCallFollowUpsForParentCancel: jest.fn().mockResolvedValue(0),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
  handleCancellation: jest.fn().mockResolvedValue({}),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 0 }),
}));

const db = require('../models/db');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    ...overrides,
  });
  return builder;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
   
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function bulk(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/bulk-action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  // Best-effort post-trx lookups (appointment_reminders re-arm read) may run;
  // default any un-programmed db() table to a harmless chain.
  db.mockImplementation(() => chain());
});

function wireTrx(queues) {
  const trx = jest.fn((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected trx('${table}') call`);
    return q.shift();
  });
  trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  trx.fn = { now: jest.fn(() => 'now()') };
  db.transaction = jest.fn(async (cb) => cb(trx));
  return trx;
}

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_date: '2026-07-01',
  window_start: '09:00:00',
  window_end: '10:00:00',
};

test('terminal rows land in failed[] with the reason; nothing is updated', async () => {
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'completed' }) })],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{ id: 'svc-1', reason: 'already completed' }]);
});

test('a past scheduledDate produces per-row failed[] entries instead of moving anything', async () => {
  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1', 'svc-2'],
    payload: { scheduledDate: '2000-01-01' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([
    { id: 'svc-1', reason: 'scheduledDate is invalid or in the past' },
    { id: 'svc-2', reason: 'scheduledDate is invalid or in the past' },
  ]);
});

test('a live en_route row moves WITH the lifecycle rewind and gets an admin_bulk reschedule_log row', async () => {
  const updateChain = chain();
  const logChain = chain();
  wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'en_route' }) }),
      updateChain,
    ],
    reschedule_log: [logChain],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual(['svc-1']);
  expect(body.failed).toEqual([]);

  expect(updateChain.update.mock.calls[0][0]).toMatchObject({
    scheduled_date: '2099-01-15',
    track_state: 'scheduled',
    en_route_at: null,
    arrived_at: null,
    actual_start_time: null,
    check_in_time: null,
    track_sms_sent_at: null,
    arrival_sms_sent_at: null,
  });
  expect(logChain.insert.mock.calls[0][0]).toMatchObject({
    scheduled_service_id: 'svc-1',
    customer_id: 'cust-1',
    new_date: '2099-01-15',
    reason_code: 'admin',
    initiated_by: 'admin_bulk',
  });
});

test('a pending row moves WITHOUT lifecycle fields', async () => {
  const updateChain = chain();
  wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) }),
      updateChain,
    ],
    reschedule_log: [chain()],
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15' },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).not.toHaveProperty('track_state');
});
