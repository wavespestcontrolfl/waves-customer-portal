/**
 * Admin schedule writers honor the occupancy contract
 * (services/scheduling/occupancy.js ORDERING CONTRACT):
 *
 *   - PUT /:id/update-details date/window move takes the rung-1 date lock
 *     as the trx's first lock and runs the tech-blind global probe on the
 *     LOCKED row; a hit is the rebooker's SLOT_TAKEN 409 (same shape).
 *   - POST / (admin create) takes rung 1 before the comms lock and probes
 *     before the parent insert; a hit is the same SLOT_TAKEN 409.
 *   - Terminal rows (record corrections) are not occupancy and skip the probe.
 *   - The moving row excludes itself; cancelled + completed don't occupy.
 *
 * The admin UI's SlotConflictNotice is advisory only and carries no
 * overbook/force flag, so the gate is a hard block like every other writer.
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
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  return {
    ...actual,
    acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
    findConflictingVisits: jest.fn().mockResolvedValue([]),
  };
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

const db = require('../models/db');
const { acquireOccupancyLock, findConflictingVisits } = require('../services/scheduling/occupancy');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  scheduled_date: '2099-07-01',
  window_start: '09:00:00',
  window_end: '10:00:00',
  status: 'confirmed',
  technician_id: null,
  service_type: 'General Pest Control',
  estimated_duration_minutes: 60,
};

// Permissive knex-ish chain: every query resolves to the given row/rows so
// the route can run up to the occupancy probe without a scripted queue.
function chain(row) {
  const builder = {};
  const self = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.first = jest.fn().mockResolvedValue(row);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...SVC, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.delete = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({});
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const callOrder = [];
let trx;
beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
  findConflictingVisits.mockResolvedValue([]);
  acquireOccupancyLock.mockImplementation(async (_t, date) => { callOrder.push(`occupancy:${date}`); });
  lockCustomerComms.mockImplementation(async () => { callOrder.push('comms'); });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1', first_name: 'Test', last_name: 'Customer', phone: null, email: null } : undefined)));
  trx = jest.fn((table) => chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined)));
  trx.raw = jest.fn(async (sql, bindings) => { callOrder.push(`raw:${String(sql).slice(0, 40)}`); return { sql, bindings, rows: [] }; });
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  trx.commit = jest.fn();
  trx.rollback = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(trx));
});

async function put(id, body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/${id}/update-details`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function post(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('PUT /:id/update-details — date/window move', () => {
  test('takes the rung-1 date lock on the TARGET date first, probes globally, and 409s SLOT_TAKEN on a hit', async () => {
    findConflictingVisits.mockResolvedValueOnce([{ id: 'svc-other', window_start: '10:00:00', window_end: '11:00:00' }]);

    const { status, body } = await put('svc-1', { scheduledDate: '2099-07-03', windowStart: '10:00' });

    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.any(String), code: 'SLOT_TAKEN' });
    // Rung 1 keyed off the requested date, BEFORE the comms lock (rung 6).
    expect(acquireOccupancyLock).toHaveBeenCalledWith(trx, '2099-07-03');
    expect(callOrder.indexOf('occupancy:2099-07-03')).toBeLessThan(callOrder.indexOf('comms'));
    // Probe ran on the same trx, for the moved date/window, excluding the
    // moving row, with the rebooker's status exclusions.
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx,
      date: '2099-07-03',
      windowStart: '10:00',
      windowEnd: '11:00',
      excludeServiceIds: ['svc-1'],
      excludeStatuses: ['cancelled', 'completed'],
    }));
  });

  test('window-only edit keys rung 1 off the row\'s own date, derives the end from the duration, and persists that end', async () => {
    const updateCalls = [];
    trx.mockImplementation((table) => {
      const c = chain(table === 'scheduled_services' ? { ...SVC } : undefined);
      if (table === 'scheduled_services') c.update = jest.fn(async (data) => { updateCalls.push(data); return 1; });
      return c;
    });

    await put('svc-1', { windowStart: '13:00' });

    expect(acquireOccupancyLock).toHaveBeenCalledWith(trx, '2099-07-01');
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: '2099-07-01',
      windowStart: '13:00',
      windowEnd: '14:00',
      excludeServiceIds: ['svc-1'],
    }));
    // The probed block is what gets stored — never 13:00 with the stale 10:00 end.
    const rowUpdate = updateCalls.find((d) => d && d.window_start === '13:00');
    expect(rowUpdate).toBeTruthy();
    expect(rowUpdate.window_end).toBe('14:00');
  });

  test('a duration-only edit is an occupancy change — locks and probes', async () => {
    await put('svc-1', { estimatedDuration: 120 });

    expect(acquireOccupancyLock).toHaveBeenCalledWith(trx, '2099-07-01');
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: '2099-07-01',
      windowStart: '09:00',
      windowEnd: '10:00',
      excludeServiceIds: ['svc-1'],
    }));
  });

  test('no conflict → the move is not refused by the gate', async () => {
    const { status } = await put('svc-1', { scheduledDate: '2099-07-03', windowStart: '10:00' });
    expect(status).not.toBe(409);
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
  });

  test('a terminal row (record correction) never probes occupancy', async () => {
    trx.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC, status: 'completed' } : undefined));

    const { status } = await put('svc-1', { scheduledDate: '2099-07-03', windowStart: '10:00' });

    expect(status).not.toBe(409);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('an edit that touches neither date nor window takes no date lock', async () => {
    await put('svc-1', { notes: 'gate code 1234' });
    expect(acquireOccupancyLock).not.toHaveBeenCalled();
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });
});

describe('POST / — admin create', () => {
  const createBody = {
    customerId: 'cust-1',
    scheduledDate: '2099-07-03',
    windowStart: '10:00',
    serviceType: 'General Pest Control',
    sendConfirmationSms: false,
  };

  test('takes rung 1 before the comms lock and 409s SLOT_TAKEN when the parent window is occupied', async () => {
    findConflictingVisits.mockResolvedValueOnce([{ id: 'svc-other' }]);

    const { status, body } = await post(createBody);

    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.any(String), code: 'SLOT_TAKEN' });
    expect(acquireOccupancyLock).toHaveBeenCalledWith(trx, '2099-07-03');
    expect(callOrder.indexOf('occupancy:2099-07-03')).toBeLessThan(callOrder.indexOf('comms'));
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx,
      date: '2099-07-03',
      windowStart: '10:00',
      windowEnd: '11:00',
      excludeStatuses: ['cancelled', 'completed'],
    }));
  });
});
