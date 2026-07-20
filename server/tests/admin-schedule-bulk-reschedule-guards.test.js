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
 *   - window times are range-validated (25:00 / 18:75 fail per-row) and an
 *     explicit end needs a positive same-day span over the effective start
 *   - the write is a field-level CAS on the OBSERVED status + scheduled_date
 *     + window_start, so a concurrent ordinary move is refused, not clobbered
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
// Partial mock: real ET helpers (the route uses many), but sameDayWindowElapsed
// is a spy so the same-day elapsed-window guard is deterministic regardless of
// the wall clock. Existing future-date tests resolve to false via the real impl.
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  return { ...actual, sameDayWindowElapsed: jest.fn(actual.sameDayWindowElapsed) };
});

const db = require('../models/db');
const { clearTechCurrentJob } = require('../services/tech-status');
const datetimeEt = require('../utils/datetime-et');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');

// Real ET "today" — the date a same-day move targets.
const TODAY_ET = jest.requireActual('../utils/datetime-et').etDateString();

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
    reason: 'the visit changed concurrently (status, date, or window) while the reschedule was pending — re-check and retry',
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

test('a move to today whose window already elapsed lands in failed[] per-row (never moved)', async () => {
  // validScheduleDate accepts today, but a window already past in ET is as
  // unreachable as a past date — per-row failure, no UPDATE, no audit row.
  datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(true);
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: TODAY_ET },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'that window has already passed today (pick a later window or a future date)',
  }]);
});

test('a move to today with a still-future window still moves (guard passes)', async () => {
  datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(false);
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
    payload: { scheduledDate: TODAY_ET },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({ scheduled_date: TODAY_ET });
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

// --- Start-only moves: derived complete windows, never the stale stored end ---

test('a start-only move to today validates against the DERIVED end and persists the complete window', async () => {
  // Moving an 08:00–09:00 visit to a 16:00 start today: the old guard
  // preferred the STALE stored 09:00 end, so the move was rejected all
  // afternoon — and had it passed, the UPDATE would have persisted the 16:00
  // start beside the stale 09:00 end (an inverted window). The derived end is
  // 16:00 + the original 60-min duration = 17:00.
  datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(false);
  const updateChain = chain();
  wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending', window_start: '08:00:00', window_end: '09:00:00' }) }),
      updateChain,
    ],
    reschedule_log: [chain()],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: TODAY_ET, windowStart: '16:00' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual(['svc-1']);
  // The elapsed guard consulted the DERIVED 17:00 end — not the stale 09:00.
  expect(datetimeEt.sameDayWindowElapsed).toHaveBeenCalledWith(TODAY_ET, '17:00');
  // BOTH derived fields persisted — never a 16:00 start beside a 09:00 end.
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({
    scheduled_date: TODAY_ET,
    window_start: '16:00',
    window_end: '17:00',
  });
});

test('a start-only move preserves a longer stored duration in the derived end', async () => {
  const updateChain = chain();
  wireTrx({
    scheduled_services: [
      // 90-minute stored window — the derived end must carry the same span.
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending', window_start: '08:00:00', window_end: '09:30:00' }) }),
      updateChain,
    ],
    reschedule_log: [chain()],
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '16:00' },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({
    window_start: '16:00',
    window_end: '17:30',
  });
});

test('an explicit windowStart+windowEnd pair is persisted as given (no derivation)', async () => {
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
    payload: { scheduledDate: '2099-01-15', windowStart: '16:00', windowEnd: '18:30' },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({
    window_start: '16:00',
    window_end: '18:30',
  });
});

test('a row moved concurrently (stale date/window snapshot) is refused by the field CAS, not clobbered', async () => {
  // Two ORDINARY bulk moves of the same confirmed row both satisfied the
  // status-only predicate — the later write silently overwrote the newer
  // date/window and logged from a stale snapshot. The CAS now carries the
  // observed scheduled_date + window_start, so the stale writer matches zero
  // rows and lands in failed[] instead.
  const updateChain = chain({ update: jest.fn().mockResolvedValue(0) });
  const trx = wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'confirmed' }) }),
      updateChain,
    ],
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
    reason: 'the visit changed concurrently (status, date, or window) while the reschedule was pending — re-check and retry',
  }]);

  // The CAS carried the full observed snapshot — status AND schedule fields.
  expect(updateChain.where).toHaveBeenCalledWith('status', 'confirmed');
  expect(updateChain.where).toHaveBeenCalledWith({ scheduled_date: '2026-07-01', window_start: '09:00:00' });
  // No audit row for a move that did not happen.
  expect(trx).not.toHaveBeenCalledWith('reschedule_log');
});

// --- Window range + span validation (explicit ends) ---

test('an out-of-range windowStart (25:00) lands in failed[] instead of a raw PG time-cast error', async () => {
  // 25:00 matched the old shape-only normalizeHHMM and died downstream at the
  // TIME cast. Range validation turns it into the same clear per-row failure
  // as any other malformed time.
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '25:00' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{ id: 'svc-1', reason: 'windowStart must be HH:MM' }]);
});

test('an out-of-range windowEnd (18:75) lands in failed[] per-row', async () => {
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '16:00', windowEnd: '18:75' },
  });

  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{ id: 'svc-1', reason: 'windowEnd must be HH:MM' }]);
});

test('an explicit inverted windowStart+windowEnd pair (18:00–09:00) lands in failed[] — never persisted', async () => {
  // Both bounds pass shape+range individually; persisted as-is the pair
  // stored an inverted block invisible to every overlap predicate (they all
  // assume start < end). No update chain is queued: an attempted write would
  // throw Unexpected trx().
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '18:00', windowEnd: '09:00' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'windowEnd must be after the window start (same-day window)',
  }]);
});

test('a zero-length explicit pair (10:00–10:00) is rejected — a positive same-day span is required', async () => {
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '10:00', windowEnd: '10:00' },
  });

  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'windowEnd must be after the window start (same-day window)',
  }]);
});

test('an end-only edit at or before the STORED start is rejected against the effective start', async () => {
  // SVC stores 09:00:00–10:00:00. windowEnd 08:30 alone would persist a
  // 09:00–08:30 inverted window beside the untouched stored start — the same
  // invisible-to-overlap block as the explicit pair.
  wireTrx({
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) })],
  });

  const { body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowEnd: '08:30' },
  });

  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'windowEnd must be after the window start (same-day window)',
  }]);
});

test('an end-only edit after the stored start still persists (the span guard passes)', async () => {
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
    payload: { scheduledDate: '2099-01-15', windowEnd: '11:30' },
  });

  expect(body.updated).toEqual(['svc-1']);
  expect(updateChain.update.mock.calls[0][0]).toMatchObject({ window_end: '11:30' });
});

test('a start-only move whose derived end would cross midnight lands in failed[] — never persisted', async () => {
  // 23:30 + the original 60-min duration wraps past midnight. The old
  // modulo-24h derivation would have persisted a 23:30–00:30 same-day block —
  // a non-positive span invisible to every overlap predicate. No UPDATE chain
  // is queued: an attempted write would throw Unexpected trx().
  wireTrx({
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue({ ...SVC, status: 'pending' }) }),
    ],
  });

  const { status, body } = await bulk({
    action: 'reschedule',
    serviceIds: ['svc-1'],
    payload: { scheduledDate: '2099-01-15', windowStart: '23:30' },
  });

  expect(status).toBe(200);
  expect(body.updated).toEqual([]);
  expect(body.failed).toEqual([{
    id: 'svc-1',
    reason: 'that window would cross midnight (pick an earlier start)',
  }]);
});
