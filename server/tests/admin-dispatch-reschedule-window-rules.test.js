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
  collectiveMoveGateOn: () => process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true',
  previewSeriesMove: jest.fn().mockResolvedValue({ collective: true, movableCount: 4, skippedCount: 0, exceptionCount: 0, conflictCount: 0 }),
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

beforeEach(() => { jest.clearAllMocks(); mockVisitRow = null; delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; });

describe('collective disclosure contract (GATE_ADMIN_COLLECTIVE_MOVE)', () => {
  const recurringRow = () => ({ is_recurring: true, scheduled_date: etDateString(addETDays(new Date(), 2)), window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60 });

  test('gate on: a this_only date move of a recurring visit without seriesAck is refused with the preview — nothing moves', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    mockVisitRow = recurringRow();
    const { status, body } = await reschedule({ newDate: TARGET, newWindow: { start: '09:00', end: '10:00' }, scope: 'this_only' });
    expect(status).toBe(409);
    expect(body.code).toBe('COLLECTIVE_MOVE_ACK_REQUIRED');
    expect(body.preview).toMatchObject({ movableCount: 4 });
    expect(body.error).toMatch(/3 later visit/);
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('gate on: the same move WITH seriesAck reaches the rebooker (the choke point widens it server-side)', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    mockVisitRow = recurringRow();
    const { status } = await reschedule({ newDate: TARGET, newWindow: { start: '09:00', end: '10:00' }, scope: 'this_only', seriesAck: true });
    expect(status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
  });

  test('gate on: a one-time visit needs no ack; gate off: a recurring visit needs none either', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    mockVisitRow = { ...recurringRow(), is_recurring: false };
    expect((await reschedule({ newDate: TARGET, newWindow: { start: '09:00', end: '10:00' } })).status).toBe(200);
    delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    mockVisitRow = recurringRow();
    expect((await reschedule({ newDate: TARGET, newWindow: { start: '09:00', end: '10:00' } })).status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(2);
  });
});

test('a 06:30 drop is refused with 422 INVALID_APPOINTMENT_WINDOW before the rebooker runs', async () => {
  const { status, body } = await reschedule({ newDate: TARGET, newWindow: '06:30-07:30' });
  expect(status).toBe(422);
  expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
  expect(body.error).toMatch(/on the hour/);
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('a pre-8am on-the-hour window reaches the rebooker (no day-start floor); a series-scope half-hour window is refused', async () => {
  let r = await reschedule({ newDate: TARGET, newWindow: { start: '07:00', end: '08:00' } });
  expect(r.status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
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

  test('date-only move: a 07:00 stored window rides along (no day-start floor); a windowless row still moves', async () => {
    mockVisitRow = { window_start: '07:00:00', window_end: '08:00:00' };
    let r = await reschedule({ newDate: TARGET });
    expect(r.status).toBe(200);
    r = await reschedule({ newDate: TARGET, scope: 'series' });
    expect(r.status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledTimes(1);
    mockVisitRow = { window_start: null, window_end: null };
    r = await reschedule({ newDate: TARGET });
    expect(r.status).toBe(200);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(2);
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
    expect.any(String), TARGET, { start: '10:00' }, 'admin', 'admin', {
      allowLive: true,
      adminWindowRules: true,
      sourceSurface: 'dispatch_board',
      // Staff surface — occupancy clashes commit with a warning (owner
      // ruling 2026-08-25, rebooker.overlapAdvisory).
      overlapAdvisory: true,
      // The anchor state this route's window resolution read, pinned through
      // the series writer's existing expectAnchor fence.
      expectAnchor: { window_start: '09:00:00' },
    },
  );
});

test('an explicit newWindow: null on a WINDOWLESS row is a 200 date-only move (the Day grid bulk move shape)', async () => {
  mockVisitRow = { window_start: null, window_end: null, estimated_duration_minutes: null };
  const { status } = await reschedule({ newDate: TARGET, newWindow: null });
  expect(status).toBe(200);
  expect(SmartRebooker.reschedule).toHaveBeenCalledWith(expect.any(String), TARGET, null, 'admin', 'admin', expect.any(Object));
});

describe('the resolved window is fenced by the rebooker CAS (options.expect)', () => {
  // resolveRescheduleWindow reads and validates the row OUTSIDE the rebooker's
  // transaction, and the rebooker's own CAS pins status + tracker state (plus
  // its own null-end duration) — not the fields this resolution derived from.
  // The route now feeds those fields into the rebooker's existing
  // options.expect predicate, so a concurrent resize/window edit makes the
  // UPDATE miss and surfaces the existing changed-concurrently 409.
  const ROW = {
    scheduled_date: '2026-08-01', window_start: '19:00:00', window_end: null,
    estimated_duration_minutes: 60,
  };

  // Stand-in for the rebooker's CAS: the UPDATE matches only if every
  // options.expect field still equals the row at commit time.
  function casRebooker(rowAtCommit) {
    return jest.fn(async (_id, _date, _win, _reason, _by, options = {}) => {
      const pin = options.expect || {};
      const matched = Object.entries(pin).every(([col, val]) => (rowAtCommit[col] ?? null) === val);
      if (!matched) {
        throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), { statusCode: 409 });
      }
      return { success: true };
    });
  }

  test('a start-only move pins the date, window and the duration its end was derived from', async () => {
    mockVisitRow = { ...ROW };
    const { status } = await reschedule({ newDate: TARGET, newWindow: { start: '09:00' } });
    expect(status).toBe(200);
    expect(SmartRebooker.reschedule.mock.calls[0][5]).toMatchObject({
      expect: {
        scheduled_date: '2026-08-01', window_start: '19:00:00', window_end: null,
        estimated_duration_minutes: 60,
      },
    });
  });

  test('a DATE-ONLY move pins the stored window it validated', async () => {
    mockVisitRow = { ...ROW, window_start: '09:00:00', window_end: '10:00:00' };
    const { status } = await reschedule({ newDate: TARGET, newWindow: null });
    expect(status).toBe(200);
    expect(SmartRebooker.reschedule.mock.calls[0][5]).toMatchObject({
      expect: {
        scheduled_date: '2026-08-01', window_start: '09:00:00', window_end: '10:00:00',
        estimated_duration_minutes: 60,
      },
    });
  });

  test('a concurrent DURATION change between the resolve and the CAS is a 409 — nothing moved', async () => {
    mockVisitRow = { ...ROW };
    // The row was resized to 120 minutes after this route read it: the 09:00
    // end it derived (10:00) is stale.
    SmartRebooker.reschedule.mockImplementation(casRebooker({ ...ROW, estimated_duration_minutes: 120 }));
    const { status, body } = await reschedule({ newDate: TARGET, newWindow: { start: '09:00' } });
    expect(status).toBe(409);
    expect(body.error).toMatch(/concurrently/);
  });

  test('a concurrent WINDOW edit between the resolve and the CAS is a 409 too', async () => {
    mockVisitRow = { ...ROW, window_start: '09:00:00', window_end: '10:00:00' };
    SmartRebooker.reschedule.mockImplementation(casRebooker({ ...ROW, window_start: '07:00:00', window_end: '08:00:00' }));
    const { status } = await reschedule({ newDate: TARGET, newWindow: null });
    expect(status).toBe(409);
  });

  test('an UNCHANGED row moves normally through the same predicate', async () => {
    mockVisitRow = { ...ROW };
    SmartRebooker.reschedule.mockImplementation(casRebooker({ ...ROW }));
    const { status } = await reschedule({ newDate: TARGET, newWindow: { start: '09:00' } });
    expect(status).toBe(200);
  });

  test('a FULL explicit window reads no row and pins nothing (it derived from nothing stored)', async () => {
    mockVisitRow = { ...ROW };
    const { status } = await reschedule({ newDate: TARGET, newWindow: '09:00-10:00' });
    expect(status).toBe(200);
    expect(SmartRebooker.reschedule.mock.calls[0][5]).not.toHaveProperty('expect');
  });
});
