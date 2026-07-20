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
 *   - live moves carry the rebooker-parity side effects
 *     (applyLiveMoveSideEffects, same trx for the history append):
 *     job_status_history row attributed to the acting staff, tech_status
 *     release, customer tracker refresh
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
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
const mockIoEmit = jest.fn();
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: mockIoEmit })) })),
}));

const db = require('../models/db');
const { clearTechCurrentJob } = require('../services/tech-status');
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
    { id: 'svc-1', reason: 'scheduledDate must be a valid YYYY-MM-DD date that is not in the past' },
    { id: 'svc-2', reason: 'scheduledDate must be a valid YYYY-MM-DD date that is not in the past' },
  ]);
});

test('a live en_route row moves WITH the lifecycle rewind and gets an admin_bulk reschedule_log row', async () => {
  const updateChain = chain();
  const logChain = chain();
  const historyChain = chain();
  wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'en_route', technician_id: 'tech-1' }) }),
      updateChain,
    ],
    job_status_history: [historyChain],
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
    // Landed back on 'confirmed' in the same UPDATE — never left en_route on
    // a future date.
    status: 'confirmed',
  });
  expect(logChain.insert.mock.calls[0][0]).toMatchObject({
    scheduled_service_id: 'svc-1',
    customer_id: 'cust-1',
    new_date: '2099-01-15',
    reason_code: 'admin',
    initiated_by: 'admin_bulk',
  });

  // Rebooker-parity side effects of the live flip — history append runs on
  // the SAME trx (atomic with the flip) and is attributed to the acting
  // staff…
  expect(historyChain.insert).toHaveBeenCalledWith({
    job_id: 'svc-1',
    from_status: 'en_route',
    to_status: 'confirmed',
    transitioned_by: 'staff-1',
  });
  // …the tech_status pointer is released…
  expect(clearTechCurrentJob).toHaveBeenCalledWith({
    tech_id: 'tech-1',
    current_job_id: 'svc-1',
    status: 'idle',
  });
  // …and an open TrackPage gets the refresh.
  expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
    job_id: 'svc-1',
    status: 'confirmed',
  }));
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
  // A non-live row's status is not restamped.
  expect(updateChain.update.mock.calls[0][0]).not.toHaveProperty('status');
  // And no live-move side effects fire (an unexpected trx('job_status_history')
  // would throw above).
  expect(clearTechCurrentJob).not.toHaveBeenCalled();
  expect(mockIoEmit).not.toHaveBeenCalled();
});

// --- Write-time status guard, post-commit ordering, strict date validation ---

test('an impossible calendar date is rejected before any DB work', async () => {
  // normalizeDateOnly only split on 'T', so 2099-02-31 passed the shape check
  // and reached the DATE column as a raw PG cast error. validScheduleDate
  // rejects it up front, per-row, like any other validation failure.
  db.transaction = jest.fn(async () => { throw new Error('transaction must not be opened'); });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-02-31' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([
    { id: 'svc-1', reason: 'scheduledDate must be a valid YYYY-MM-DD date that is not in the past' },
  ]);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('the validated date is what gets persisted, not the raw payload', async () => {
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
    // A 'T…' suffix only the normalizer strips.
    payload: { scheduledDate: '2099-01-15T00:00:00.000Z' },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({ scheduled_date: '2099-01-15' });
});

test('a row that changes status between the read and the write is skipped, not rewritten', async () => {
  // The terminal guard and the wasLive branch are both derived from the read
  // at the top of the trx. If the visit completes in between, an update by id
  // alone would rewrite the finished row back onto the schedule as
  // 'confirmed'. The status-conditional UPDATE matches zero rows instead.
  const updateChain = chain({ update: jest.fn().mockResolvedValue(0) });
  const trx = wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'en_route', technician_id: 'tech-1' }) }),
      updateChain,
    ],
    job_status_history: [chain()],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'status changed while the reschedule was pending (it may have been completed, cancelled, or started)',
  }]);

  // The UPDATE was scoped to the OBSERVED status, so a row that moved on
  // could not match it.
  expect(updateChain.where).toHaveBeenCalledWith('status', 'en_route');
  // Nothing downstream of the write ran: no audit row, no tech release, no
  // phantom refresh for a move that did not happen.
  expect(trx).not.toHaveBeenCalledWith('reschedule_log');
  expect(clearTechCurrentJob).not.toHaveBeenCalled();
  expect(mockIoEmit).not.toHaveBeenCalled();
});

test('a rollback leaves NO tech_status write and NO socket emit', async () => {
  // clearTechCurrentJob writes on the GLOBAL db connection and the customer
  // refresh emits immediately — neither rolls back. So both must run only
  // after a successful commit, never inside the trx.
  const trxFn = jest.fn((table) => {
    if (table === 'scheduled_services') {
      return chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'on_site', technician_id: 'tech-1' }) });
    }
    if (table === 'job_status_history') return chain();
    // The audit insert blows up AFTER the status flip → the whole trx rolls back.
    if (table === 'reschedule_log') return chain({ insert: jest.fn().mockRejectedValue(new Error('deadlock detected')) });
    return chain();
  });
  trxFn.raw = jest.fn();
  trxFn.fn = { now: jest.fn(() => 'now()') };
  // Real rollback semantics: the callback rejects, so db.transaction rejects.
  db.transaction = jest.fn(async (cb) => cb(trxFn));

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{ id: 'svc-1', reason: 'deadlock detected' }]);

  // The externally-visible half never fired for a move that was rolled back.
  expect(clearTechCurrentJob).not.toHaveBeenCalled();
  expect(mockIoEmit).not.toHaveBeenCalled();
});

test('a malformed window time is rejected rather than persisted raw', async () => {
  db.transaction = jest.fn(async (cb) => {
    const trx = jest.fn(() => chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) }));
    trx.raw = jest.fn();
    trx.fn = { now: jest.fn(() => 'now()') };
    return cb(trx);
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '2:00 PM' },
  });

  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{ id: 'svc-1', reason: 'windowStart must be HH:MM' }]);
});
