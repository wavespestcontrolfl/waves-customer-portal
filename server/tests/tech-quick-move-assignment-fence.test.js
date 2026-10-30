/**
 * Technician Quick Move (POST /api/tech/services/:id/rain-out) must fence the
 * WRITE to the authenticated technician, not only the ownsTrackedVisit
 * pre-read. Race: the route's read sees tech-1; dispatch reassigns the visit to
 * tech-2; RainOut.commit then reads the now-current tech-2 row. Without
 * requireAssignedTechnicianId the rebooker's options.expect carries no
 * technician_id, so tech-1's request would still move (and text) tech-2's
 * visit. The real RainOut.commit runs here; the rebooker is a stub that applies
 * the same technician_id predicate the real atomic UPDATE applies.
 *
 * Also covers the Dispatch Board broadcast: one dispatch:job_update per
 * successfully moved stop, one shared quality-date flush.
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
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn(),
  rescheduleSeries: jest.fn().mockResolvedValue({ rescheduledOccurrences: [] }),
  findRescheduleOptions: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n-1' }) }));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue(undefined),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
}));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(undefined),
  flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue('rendered body') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true, providerMessageId: 'SMtest' }),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlook: jest.fn().mockResolvedValue(null),
  getHourlyRainOutlook: jest.fn().mockResolvedValue(null),
  forecastLinkForZip: jest.fn(() => null),
}));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn().mockResolvedValue({ url: 'https://waves.test/r/t', line: '' }),
}));
jest.mock('../services/workflows/missed-appointment', () => ({ evaluateThreshold: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
  listOccupiedWindows: jest.fn().mockResolvedValue([]),
}));

const express = require('express');
const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../services/dispatch-assignment');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const techTrackRouter = require('../routes/tech-track');

const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = (() => { const d = new Date(`${etToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

const ROW = {
  id: 'svc-1', customer_id: 'cust-1', cust_id: 'cust-1', technician_id: 'tech-1',
  service_type: 'Quarterly Pest Control', status: 'confirmed', scheduled_date: etToday,
  window_start: '09:00', window_end: '11:00', first_name: 'Pat', phone: '+19415551234', zip: '34202',
  is_recurring: false,
};

// db('scheduled_services') hands out the queued reads in order: the route's
// ownership read first, then commit()'s own read.
function wireReads(...rows) {
  const queue = rows.map((r) => ({ ...r }));
  db.mockImplementation((table) => {
    if (table !== 'scheduled_services') throw new Error(`Unexpected db('${table}') call`);
    const row = queue.shift();
    const builder = {
      where: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(), leftJoin: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
      orderByRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(1),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  });
}

// The live row the writer's atomic UPDATE sees; the stub applies the same
// technician_id predicate rebooker.reschedule applies to options.expect.
let liveTechnicianId;
beforeEach(() => {
  jest.clearAllMocks();
  liveTechnicianId = 'tech-1';
  SmartRebooker.reschedule.mockImplementation(async (id, _date, _window, _reason, _by, options = {}) => {
    const expected = options.expect && options.expect.technician_id;
    if (expected && String(expected) !== String(liveTechnicianId)) {
      throw Object.assign(new Error('Cannot reschedule — appointment changed concurrently'), { statusCode: 409, isOperational: true });
    }
    return { id, success: true, visitMove: null };
  });
});

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', techTrackRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const body = { reasonCode: 'weather_rain', scope: 'job', target: { date: tomorrow, window: { start: '13:00', end: '14:00' } }, notifyCustomer: true };
async function moveVisit() {
  const res = await fetch(`${baseUrl}/api/tech/services/svc-1/rain-out`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('technician Quick Move assignment fence', () => {
  test('own visit: the move still lands, the writer carries the technician fence, board + reminder follow', async () => {
    wireReads(ROW, ROW);
    const r = await moveVisit();

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    expect(SmartRebooker.reschedule.mock.calls[0][5]).toEqual(expect.objectContaining({
      seriesPolicy: 'single',
      expect: { technician_id: 'tech-1' },
    }));
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    // Board: one update for the one moved stop, then ONE shared flush.
    expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'svc-1', actorId: 'tech-1', qualityDates: expect.any(Set) }));
    expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
    expect(flushDispatchQualityDates.mock.calls[0][0]).toBe(emitDispatchJobUpdate.mock.calls[0][0].qualityDates);
  });

  test('reassigned between the ownership read and the writer read: the move is refused with 409 and nothing is sent', async () => {
    // Route read sees tech-1; dispatch hands the visit to tech-2; commit()
    // reads the now-current tech-2 row and the live row is tech-2's.
    wireReads(ROW, { ...ROW, technician_id: 'tech-2' });
    liveTechnicianId = 'tech-2';

    const r = await moveVisit();

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed concurrently/i);
    expect(r.body.results).toEqual([expect.objectContaining({ ok: false, statusCode: 409 })]);
    expect(SmartRebooker.reschedule.mock.calls[0][5].expect).toEqual({ technician_id: 'tech-1' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
    expect(AppointmentReminders.markRescheduleNoticeSent).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
    expect(flushDispatchQualityDates).not.toHaveBeenCalled();
  });

  test('recurring visit with the series gate on: the technician call never takes the (unfenced) series branch', async () => {
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    try {
      const rec = { ...ROW, is_recurring: true, recurring_parent_id: 'parent-1' };
      wireReads(rec, rec);
      const r = await moveVisit();
      expect(r.status).toBe(200);
      expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
      expect(SmartRebooker.reschedule.mock.calls[0][5].expect).toEqual({ technician_id: 'tech-1' });
    } finally {
      delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
    }
  });
});
