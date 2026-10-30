/**
 * Technician Quick Move emits the Dispatch Board job update for each
 * successfully moved stop (covered grouped members included), exactly like
 * the admin-dispatch rain-out twin, and flushes route quality once. Failed
 * stops and stops whose series effects pass already broadcast are skipped.
 * RainOut.commit is stubbed so each result shape is driven directly.
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
const mockCommit = jest.fn();
jest.mock('../services/rain-out', () => ({
  commit: (...a) => mockCommit(...a),
  getOptions: jest.fn(),
  previewMovedSms: jest.fn(),
  checkTarget: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue(undefined),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
}));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(undefined),
  flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
}));
const mockRows = [];
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    const b = {
      where() { return b; },
      async first() { return table === 'scheduled_services' ? mockRows[0] : undefined; },
    };
    return b;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (s) => s;
  return dbFn;
});

const express = require('express');
const logger = require('../services/logger');
const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../services/dispatch-assignment');
const techTrackRouter = require('../routes/tech-track');

const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = (() => { const d = new Date(`${etToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', techTrackRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  mockRows.push({ id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: etToday });
});

async function moveVisit() {
  const res = await fetch(`${baseUrl}/api/tech/services/svc-1/rain-out`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasonCode: 'weather_rain', scope: 'job', target: { date: tomorrow, window: { start: '09:00', end: '10:00' } } }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('emits once per moved stop (covered members included), skips failed and series-handled ones, flushes once', async () => {
  mockCommit.mockResolvedValue({
    ok: true, movedCount: 1, coveredCount: 1, failedCount: 1,
    qualityDates: [etToday],
    results: [
      { id: 'svc-1', ok: true, newDate: tomorrow, newWindow: { start: '09:00', end: '10:00' }, smsSent: true },
      { id: 'svc-2', ok: true, coveredByVisit: 'visit-1', newDate: tomorrow, smsSent: false },
      { id: 'svc-3', ok: false, error: 'Cannot reschedule — appointment changed concurrently', statusCode: 409 },
      { id: 'svc-4', ok: true, newDate: tomorrow, newWindow: { start: '11:00', end: '12:00' }, boardBroadcastBySeriesEffects: true },
    ],
  });

  const r = await moveVisit();

  expect(r.status).toBe(200);
  expect(mockCommit).toHaveBeenCalledWith(expect.objectContaining({ technicianId: 'tech-1', requireAssignedTechnicianId: 'tech-1' }));
  expect(emitDispatchJobUpdate.mock.calls.map((c) => c[0].jobId)).toEqual(['svc-1', 'svc-2']);
  const sets = emitDispatchJobUpdate.mock.calls.map((c) => c[0].qualityDates);
  expect(sets[0]).toBe(sets[1]);
  expect(sets[0]).toBeInstanceOf(Set);
  expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  expect(flushDispatchQualityDates.mock.calls[0][0]).toBe(sets[0]);
  // The quality dates commit() collected ride the same Set.
  expect(sets[0].has(etToday)).toBe(true);
  // Reminder re-arm behavior is unchanged: a result per moved stop.
  expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(3);
});

test('a failed commit emits and flushes nothing', async () => {
  mockCommit.mockResolvedValue({
    ok: false, reason: 'Cannot reschedule — appointment changed concurrently',
    results: [{ id: 'svc-1', ok: false, error: 'x', statusCode: 409 }], qualityDates: [etToday],
  });
  const r = await moveVisit();
  expect(r.status).toBe(409);
  expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  expect(flushDispatchQualityDates).not.toHaveBeenCalled();
  expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
});

test('a board broadcast failure never fails the committed move and does not stop later stops', async () => {
  mockCommit.mockResolvedValue({
    ok: true, qualityDates: [],
    results: [
      { id: 'svc-1', ok: true, newDate: tomorrow, smsSent: false },
      { id: 'svc-2', ok: true, newDate: tomorrow, smsSent: false },
    ],
  });
  emitDispatchJobUpdate.mockRejectedValueOnce(new Error('socket down'));
  const r = await moveVisit();
  expect(r.status).toBe(200);
  expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(2);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('board broadcast failed for svc-1'));
});
