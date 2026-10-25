/**
 * GATE_TECH_MOVE_SWITCH (owner 2026-10-25): a per-technician "Can move visits"
 * switch (technicians.can_move_visits). With the gate on, a non-admin whose
 * switch is off is refused on every route that moves a visit or lists the moves
 * it would make; admins never are. Gate off: today's behavior, no query.
 *
 * Real requireTechOrAdmin runs; only adminAuthenticate is stubbed to inject the
 * caller. rain-out / rebooker are stubbed so reaching them is the observable
 * "allowed" outcome and no move or text runs.
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
const mockCommit = jest.fn(async () => ({ ok: true, results: [], qualityDates: [] }));
const mockGetOptions = jest.fn(async () => ({ ok: true, sameDay: [{ kind: 'same_day' }], days: [{ kind: 'day' }] }));
jest.mock('../services/rain-out', () => ({
  commit: (...a) => mockCommit(...a),
  getOptions: (...a) => mockGetOptions(...a),
  previewMovedSms: jest.fn(async () => ({ ok: true })),
  checkTarget: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], technicians: [], queries: [] };
  const dbFn = (table) => {
    state.queries.push(table);
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
      async update() { return 0; }, async insert() { return [1]; }, async del() { return 0; },
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
const { techMoveRefusal } = require('../services/scheduling/tech-move-permission');
const dispatchRouter = require('../routes/admin-dispatch');
const techTrackRouter = require('../routes/tech-track');
// admin-dispatch calls SmartRebooker.findRescheduleOptions on the module object.
const mockFindRescheduleOptions = jest.spyOn(require('../services/rebooker'), 'findRescheduleOptions').mockImplementation(async () => []);

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
const prevGate = process.env.GATE_TECH_MOVE_SWITCH;

beforeEach(() => {
  process.env.GATE_TECH_MOVE_SWITCH = 'true';
  mockCaller.id = 'tech-1';
  mockCaller.role = 'technician';
  db.__state.scheduledServices = [
    { id: 'svc-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'scheduled', scheduled_date: etToday, is_recurring: false },
  ];
  db.__state.technicians = [
    { id: 'tech-1', can_move_visits: false },
    { id: 'tech-2', can_move_visits: true },
    { id: 'admin-1', can_move_visits: false },
  ];
  db.__state.queries = [];
  mockCommit.mockClear();
  mockGetOptions.mockClear();
  mockFindRescheduleOptions.mockClear();
});
afterAll(() => {
  if (prevGate === undefined) delete process.env.GATE_TECH_MOVE_SWITCH;
  else process.env.GATE_TECH_MOVE_SWITCH = prevGate;
});

const moveBody = { reasonCode: 'weather_rain', scope: 'job', target: { date: tomorrow, window: { start: '09:00', end: '10:00' } } };
async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('techMoveRefusal', () => {
  test('gate off: allowed without reading the technician row', async () => {
    delete process.env.GATE_TECH_MOVE_SWITCH;
    expect(await techMoveRefusal({ techRole: 'technician', technicianId: 'tech-1' })).toBeNull();
    expect(db.__state.queries).toEqual([]);
  });

  test('gate on: an admin is allowed whatever the row says', async () => {
    expect(await techMoveRefusal({ techRole: 'admin', technicianId: 'admin-1' })).toBeNull();
  });

  test('gate on: switch on is allowed; switch off, no row and no id are refused', async () => {
    expect(await techMoveRefusal({ techRole: 'technician', technicianId: 'tech-2' })).toBeNull();
    for (const req of [
      { techRole: 'technician', technicianId: 'tech-1' },
      { techRole: 'technician', technicianId: 'tech-missing' },
      { techRole: 'technician' },
    ]) {
      expect(await techMoveRefusal(req)).toEqual({ status: 403, payload: { error: 'Ask the office to move this visit.', code: 'move_not_allowed' } });
    }
  });
});

describe('every move route refuses a technician whose switch is off', () => {
  const routes = [
    ['GET', '/api/tech/services/svc-1/rain-out-options', null],
    ['POST', '/api/tech/services/svc-1/rain-out', moveBody],
    ['GET', '/api/admin/dispatch/svc-1/rain-out-options', null],
    ['POST', '/api/admin/dispatch/svc-1/rain-out', moveBody],
    ['GET', '/api/admin/dispatch/svc-1/reschedule-options', null],
    ['POST', '/api/admin/dispatch/svc-1/reschedule', { newWindow: { date: tomorrow, start: '09:00', end: '10:00' } }],
  ];
  test.each(routes)('%s %s', async (method, path, body) => {
    const r = await call(method, path, body);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Ask the office to move this visit.', code: 'move_not_allowed' });
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockGetOptions).not.toHaveBeenCalled();
    expect(mockFindRescheduleOptions).not.toHaveBeenCalled();
  });
});

describe('the same technician moves as before when allowed', () => {
  test('switch on: the tech app Quick Move reaches the move', async () => {
    db.__state.technicians.find((t) => t.id === 'tech-1').can_move_visits = true;
    const r = await call('POST', '/api/tech/services/svc-1/rain-out', moveBody);
    expect(r.status).toBe(200);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  test('gate off: switch off does not matter (today\'s behavior)', async () => {
    delete process.env.GATE_TECH_MOVE_SWITCH;
    const r = await call('POST', '/api/tech/services/svc-1/rain-out', moveBody);
    expect(r.status).toBe(200);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  test('an admin with the switch off still moves from Dispatch', async () => {
    mockCaller.id = 'admin-1';
    mockCaller.role = 'admin';
    const r = await call('GET', '/api/admin/dispatch/svc-1/rain-out-options');
    expect(r.status).toBe(200);
    expect(mockGetOptions).toHaveBeenCalledTimes(1);
  });
});
