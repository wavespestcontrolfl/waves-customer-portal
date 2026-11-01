/**
 * Quick Move "let the customer pick a day" routes (GATE_QUICKMOVE_CUSTOMER_PICK):
 * POST /api/tech/services/:id/customer-pick and its dispatch twin
 * POST /api/admin/dispatch/:serviceId/customer-pick.
 *
 * Real routers, real requireTechOrAdmin, real techMoveRefusal; adminAuthenticate
 * injects the caller and RainOut.handOffToCustomer is a stub, so reaching it is
 * the observable "allowed" outcome and nothing moves or texts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const mockCaller = { id: 'tech-1', role: 'technician' };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: mockCaller.id, role: mockCaller.role };
      req.technicianId = mockCaller.id;
      req.techRole = mockCaller.role;
      return next();
    },
  };
});
const mockHandOff = jest.fn();
const mockCommit = jest.fn(async () => ({ ok: true, results: [], qualityDates: [] }));
jest.mock('../services/rain-out', () => ({
  handOffToCustomer: (...a) => mockHandOff(...a),
  commit: (...a) => mockCommit(...a),
  getOptions: jest.fn(async () => ({ ok: true, sameDay: [], days: [] })),
  customerPickOffer: jest.fn(async () => undefined),
  // Pure: the real status, words and code both routes answer with.
  pickRefusalResponse: jest.requireActual('../services/rain-out').pickRefusalResponse,
}));
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(null),
  flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
}));
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], technicians: [] };
  const dbFn = (table) => {
    const builder = {
      _where: {},
      where(w, op, val) {
        if (w && typeof w === 'object') Object.assign(builder._where, w);
        else if (val === undefined) builder._where[String(w).replace(/^scheduled_services\./, '')] = op;
        return builder;
      },
      andWhere(...a) { return builder.where(...a); },
      whereNot() { return builder; }, whereNotIn() { return builder; }, whereIn() { return builder; },
      whereNull() { return builder; }, modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; }, forUpdate() { return builder; }, orderBy() { return builder; },
      select() { return builder; },
      async first() {
        const rows = table === 'scheduled_services' ? state.scheduledServices
          : table === 'technicians' ? state.technicians : [];
        const found = rows.find((r) => Object.entries(builder._where).every(([k, v]) => r[k] === v));
        return found ? { ...found } : undefined;
      },
      async update() { return 0; }, async insert() { return [1]; },
    };
    return builder;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => { const trx = (t) => dbFn(t); trx.raw = async () => ({}); return cb(trx); };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../services/dispatch-assignment');
const dispatchRouter = require('../routes/admin-dispatch');
const techTrackRouter = require('../routes/tech-track');

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use('/api/tech/services', techTrackRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = (() => { const d = new Date(`${etToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const HANDED_OFF = {
  ok: true, dueDate: '2099-01-09', pickBy: '2099-01-03T01:00:00.000Z', pickByLabel: 'Fri 8 PM', textSent: true, needsAttention: [],
  qualityDates: [etToday, '2099-01-09'], movedCount: 1, coveredCount: 0, failedCount: 0, overlapCount: 0, overlapWarnings: [],
  results: [{ id: 'svc-own', ok: true, newDate: '2099-01-09', newWindow: null, smsSent: true, smsReason: null }],
};
const TECH = '/api/tech/services';
const DISPATCH = '/api/admin/dispatch';

const prevGates = { pick: process.env.GATE_QUICKMOVE_CUSTOMER_PICK, sw: process.env.GATE_TECH_MOVE_SWITCH };
beforeEach(() => {
  process.env.GATE_QUICKMOVE_CUSTOMER_PICK = 'true';
  delete process.env.GATE_TECH_MOVE_SWITCH;
  mockCaller.id = 'tech-1';
  mockCaller.role = 'technician';
  db.__state.scheduledServices = [
    { id: 'svc-own', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: etToday },
    { id: 'svc-other', technician_id: 'tech-2', customer_id: 'cust-2', status: 'confirmed', scheduled_date: etToday },
    { id: 'svc-future', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: tomorrow },
  ];
  db.__state.technicians = [{ id: 'tech-1', can_move_visits: false }];
  mockHandOff.mockReset().mockResolvedValue(HANDED_OFF);
  mockCommit.mockClear();
  emitDispatchJobUpdate.mockClear();
  flushDispatchQualityDates.mockClear();
});
afterAll(() => {
  for (const [key, name] of [['pick', 'GATE_QUICKMOVE_CUSTOMER_PICK'], ['sw', 'GATE_TECH_MOVE_SWITCH']]) {
    if (prevGates[key] === undefined) delete process.env[name];
    else process.env[name] = prevGates[key];
  }
});

async function post(path, body = { reasonCode: 'weather_rain' }) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe.each([
  ['tech app', TECH, 'Not assigned to this service', { initiatedBy: 'tech' }],
  ['dispatch', DISPATCH, 'Not assigned to this service', { initiatedBy: 'admin' }],
])('%s customer-pick route', (_label, base, ownershipError, expected) => {
  test('own visit: hands off with the technician fence and broadcasts the board once with both days', async () => {
    const r = await post(`${base}/svc-own/customer-pick`);

    expect(r.status).toBe(200);
    expect(r.body).toEqual(HANDED_OFF);
    expect(mockHandOff).toHaveBeenCalledWith({
      serviceId: 'svc-own', reasonCode: 'weather_rain', initiatedBy: expected.initiatedBy, actorUserId: 'tech-1',
      requireAssignedTechnicianId: 'tech-1', operatorInitiated: true,
    });
    expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
    const { qualityDates, ...emitted } = emitDispatchJobUpdate.mock.calls[0][0];
    expect(emitted).toEqual({ jobId: 'svc-own', actorId: 'tech-1' });
    expect([...qualityDates]).toEqual([etToday, '2099-01-09']);
    expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
    expect(flushDispatchQualityDates.mock.calls[0][0]).toBe(qualityDates);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  test('gate off: 404 disabled before any check, nothing reached', async () => {
    delete process.env.GATE_QUICKMOVE_CUSTOMER_PICK;
    const r = await post(`${base}/svc-own/customer-pick`);
    expect(r).toEqual({ status: 404, body: { error: 'disabled' } });
    expect(mockHandOff).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  test("another technician's visit: 403, nothing reached", async () => {
    const r = await post(`${base}/svc-other/customer-pick`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(ownershipError);
    expect(mockHandOff).not.toHaveBeenCalled();
  });

  test('a visit already moved to a future day: 409 future_scheduled_date', async () => {
    const r = await post(`${base}/svc-future/customer-pick`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('future_scheduled_date');
    expect(mockHandOff).not.toHaveBeenCalled();
  });

  test('an unknown visit: 404', async () => {
    const r = await post(`${base}/svc-missing/customer-pick`);
    expect(r.status).toBe(404);
    expect(mockHandOff).not.toHaveBeenCalled();
  });

  test('a technician whose "Can move visits" switch is off may hand the visit to the customer, and still may not move it', async () => {
    process.env.GATE_TECH_MOVE_SWITCH = 'true';
    const pick = await post(`${base}/svc-own/customer-pick`);
    expect(pick.status).toBe(200);
    expect(mockHandOff).toHaveBeenCalledTimes(1);

    const move = await post(`${base}/svc-own/rain-out`, { reasonCode: 'weather_rain', scope: 'job', target: { date: tomorrow, window: { start: '09:00', end: '10:00' } } });
    expect(move).toEqual({ status: 403, body: { error: 'Ask the office to move this visit.', code: 'move_not_allowed' } });
    expect(mockCommit).not.toHaveBeenCalled();
  });

  test.each([
    ['bad_reason', 400],
    ['not_found', 404],
    ['disabled', 404],
    ['state_changed', 409],
    ['pick_text_too_long', 409],
    ['customer_texts_off', 409],
    ['auto_dispatch_off', 409],
    ['auto_dispatch_held', 409],
    ['no_location', 409],
  ])('a %s refusal answers %i with the reason and broadcasts nothing', async (reason, status) => {
    mockHandOff.mockResolvedValue({ ok: false, reason });
    const r = await post(`${base}/svc-own/customer-pick`);
    // The sheet shows `error` (words, never the bare code); `reason` is the code.
    expect(r).toEqual({ status, body: { error: expect.any(String), reason } });
    if (reason !== 'disabled') expect(r.body.error).not.toBe(reason);
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
    expect(flushDispatchQualityDates).not.toHaveBeenCalled();
  });

  test('a board broadcast failure does not fail the committed hand-off', async () => {
    emitDispatchJobUpdate.mockRejectedValueOnce(new Error('socket down'));
    const r = await post(`${base}/svc-own/customer-pick`);
    expect(r.status).toBe(200);
    expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch customer-pick for an admin', () => {
  test("any visit, no technician fence; the admin's id stamps the text", async () => {
    mockCaller.id = 'admin-1';
    mockCaller.role = 'admin';
    const r = await post(`${DISPATCH}/svc-other/customer-pick`, { reasonCode: 'weather_wind' });
    expect(r.status).toBe(200);
    expect(mockHandOff).toHaveBeenCalledWith({
      serviceId: 'svc-other', reasonCode: 'weather_wind', initiatedBy: 'admin', actorUserId: 'admin-1',
      requireAssignedTechnicianId: null, operatorInitiated: true,
    });
  });
});
