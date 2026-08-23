/**
 * Admin schedule writers honor the occupancy contract
 * (services/scheduling/occupancy.js ORDERING CONTRACT):
 *
 *   - PUT /:id/update-details date/window move takes the rung-1 date lock
 *     as the trx's first lock and runs the tech-blind global probe on the
 *     LOCKED row; a hit is the rebooker's SLOT_TAKEN 409 (same shape).
 *   - POST / (admin create) takes rung 1 before the comms lock and probes
 *     before the parent insert; a hit is the same SLOT_TAKEN 409.
 *   - A recurring POST locks the parent AND every generated child/booster
 *     date (sorted, first statements of the trx) and probes each timed
 *     generated row before inserting it; any hit 409s the whole request.
 *   - PUT /:id/update-details recurrence paths (cadence rewrite moves,
 *     make-recurring spawn, visit-count top-up) lock the parent's date AND
 *     every destination date up front (sorted) and probe each timed row
 *     before its write; a hit 409s SLOT_TAKEN naming the date.
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
  const mocked = {
    ...actual,
    acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
    findConflictingVisits: jest.fn().mockResolvedValue([]),
  };
  // Mirrors the real helper's dedup + ascending order, routed through the
  // mocked single-date lock so callOrder sees every date.
  mocked.acquireOccupancyLocks = jest.fn(async (trx, dates) => {
    const sorted = [...new Set((dates || []).filter(Boolean).map((d) => String(d).split('T')[0]))].sort();
    for (const d of sorted) await mocked.acquireOccupancyLock(trx, d);
  });
  return mocked;
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

const db = require('../models/db');
const { acquireOccupancyLock, acquireOccupancyLocks, findConflictingVisits } = require('../services/scheduling/occupancy');
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

  test('a duration-only edit on an end-less row widens occupancy — locks and probes', async () => {
    trx.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...SVC, window_end: null } : undefined));

    await put('svc-1', { estimatedDuration: 120 });

    expect(acquireOccupancyLock).toHaveBeenCalledWith(trx, '2099-07-01');
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: '2099-07-01',
      windowStart: '09:00',
      windowEnd: '11:00',
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

  test('echoed-but-unchanged date/window/duration (mobile modal re-save) does NOT probe', async () => {
    findConflictingVisits.mockResolvedValue([{ id: 'svc-other' }]);

    const { status } = await put('svc-1', {
      notes: 'updated notes', scheduledDate: '2099-07-01', windowStart: '09:00', windowEnd: '10:00', estimatedDuration: 60,
    });

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

  const recurringBody = {
    ...createBody,
    isRecurring: true,
    recurringPattern: 'monthly',
    recurringCount: 3,
    boosterMonths: [11],
  };
  // monthly from Fri 07-03 ×3 anchors on the ordinal weekday → children on
  // the first Fridays 08-07, 09-04; November booster → 11-03.
  const generatedDates = ['2099-08-07', '2099-09-04', '2099-11-03'];

  test('recurring create locks the parent + every generated date, sorted, before any insert', async () => {
    const inserts = [];
    trx.mockImplementation((table) => {
      const c = chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined));
      if (table === 'scheduled_services') {
        c.insert = jest.fn((data) => {
          inserts.push(data);
          callOrder.push(`insert:${data.scheduled_date}`);
          return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
        });
      }
      return c;
    });

    const { status } = await post(recurringBody);

    expect(status).not.toBe(409);
    expect(acquireOccupancyLocks).toHaveBeenCalledTimes(1);
    expect(acquireOccupancyLocks).toHaveBeenCalledWith(trx, ['2099-07-03', ...generatedDates]);
    const lockSeq = callOrder.filter((c) => c.startsWith('occupancy:'));
    expect(lockSeq).toEqual(['occupancy:2099-07-03', 'occupancy:2099-08-07', 'occupancy:2099-09-04', 'occupancy:2099-11-03']);
    // All locks precede the comms lock and the first insert.
    const lastLock = callOrder.lastIndexOf('occupancy:2099-11-03');
    expect(lastLock).toBeLessThan(callOrder.indexOf('comms'));
    expect(lastLock).toBeLessThan(callOrder.findIndex((c) => c.startsWith('insert:')));
    // Every generated timed row was probed on its own date.
    for (const d of ['2099-07-03', ...generatedDates]) {
      expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
        db: trx, date: d, windowStart: '10:00', windowEnd: '11:00', excludeStatuses: ['cancelled', 'completed'],
      }));
    }
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', ...generatedDates]);
  });

  test('a conflicting generated child date 409s SLOT_TAKEN (naming the date) and inserts nothing', async () => {
    const inserts = [];
    trx.mockImplementation((table) => {
      const c = chain(table === 'scheduled_services' ? { ...SVC } : (table === 'customers' ? { id: 'cust-1' } : undefined));
      if (table === 'scheduled_services') {
        c.insert = jest.fn((data) => {
          inserts.push(data);
          return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
        });
      }
      return c;
    });
    findConflictingVisits.mockImplementation(async ({ date }) => (date === '2099-09-04' ? [{ id: 'svc-other' }] : []));

    const { status, body } = await post(recurringBody);

    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.stringContaining('2099-09-04'), code: 'SLOT_TAKEN' });
    // The trx threw, so the parent + 08-07 child inserts that ran before the
    // 09-04 probe roll back; nothing after the conflict was attempted.
    expect(inserts.map((d) => d.scheduled_date)).toEqual(['2099-07-03', '2099-08-07']);
    expect(trx.commit).not.toHaveBeenCalled();
  });
});

describe('PUT /:id/update-details — recurrence paths lock + probe every destination date', () => {
  // Wed 2099-07-01 monthly (ordinal weekday) → first Wednesdays 08-05, 09-02.
  const spawnDates = ['2099-08-05', '2099-09-02'];

  test('a recurrence-only save that spawns children locks the parent + every child date, sorted, before any insert', async () => {
    const inserts = [];
    trx.mockImplementation((table) => {
      const c = chain(table === 'scheduled_services' ? { ...SVC, is_recurring: false } : (table === 'customers' ? { id: 'cust-1' } : undefined));
      if (table === 'scheduled_services') {
        c.insert = jest.fn((data) => {
          inserts.push(data);
          callOrder.push(`insert:${data.scheduled_date}`);
          return { returning: jest.fn().mockResolvedValue([{ ...SVC, ...data, id: `new-${inserts.length}` }]) };
        });
      }
      return c;
    });

    // No date/window fields at all — the old gate took zero date locks here.
    const { status } = await put('svc-1', { isRecurring: true, recurringPattern: 'monthly', recurringCount: 3 });

    expect(status).toBe(200);
    expect(acquireOccupancyLocks).toHaveBeenCalledTimes(1);
    expect(acquireOccupancyLocks).toHaveBeenCalledWith(trx, ['2099-07-01', ...spawnDates]);
    const lockSeq = callOrder.filter((c) => c.startsWith('occupancy:'));
    expect(lockSeq).toEqual(['occupancy:2099-07-01', 'occupancy:2099-08-05', 'occupancy:2099-09-02']);
    const lastLock = callOrder.lastIndexOf('occupancy:2099-09-02');
    expect(lastLock).toBeLessThan(callOrder.indexOf('comms'));
    expect(lastLock).toBeLessThan(callOrder.findIndex((c) => c.startsWith('insert:')));
    // Each generated timed child probed on its own date, excluding the parent.
    for (const d of spawnDates) {
      expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
        db: trx, date: d, windowStart: '09:00', windowEnd: '10:00', excludeServiceIds: ['svc-1'], excludeStatuses: ['cancelled', 'completed'],
      }));
    }
    expect(inserts.map((d) => d.scheduled_date)).toEqual(spawnDates);
  });

  test('a cadence change that moves a child onto an occupied date 409s SLOT_TAKEN and writes nothing', async () => {
    const parentRow = { ...SVC, is_recurring: true, recurring_pattern: 'monthly', recurring_parent_id: null };
    const childRow = {
      ...SVC, id: 'child-1', scheduled_date: '2099-08-05', status: 'pending', is_recurring: true, recurring_parent_id: 'svc-1',
    };
    const childWrites = [];
    // Stateful series mock: the parent update lands (so the in-trx re-read
    // sees the new cadence), children/boosters resolve by their where shape.
    const seriesChain = (table) => {
      if (table !== 'scheduled_services') return chain(table === 'customers' ? { id: 'cust-1' } : undefined);
      const c = chain({ ...parentRow });
      c.first = jest.fn(async () => ({ ...parentRow }));
      c.then = (resolve, reject) => {
        const wheres = c.where.mock.calls.map((args) => args[0]);
        const wantsChildren = wheres.some((w) => w && typeof w === 'object' && w.recurring_parent_id === 'svc-1' && w.is_recurring === true);
        const wantsBoosters = wheres.some((w) => w && typeof w === 'object' && w.recurring_parent_id === 'svc-1' && w.is_recurring === false);
        const rows = wantsChildren ? [{ ...childRow }] : (wantsBoosters ? [] : [{ ...parentRow }]);
        return Promise.resolve(rows).then(resolve, reject);
      };
      c.update = jest.fn(async (data) => {
        const wheres = c.where.mock.calls.map((args) => args[0]);
        if (wheres.some((w) => w && typeof w === 'object' && w.id === 'child-1')) childWrites.push(data);
        else if (wheres.some((w) => w && typeof w === 'object' && w.id === 'svc-1')) Object.assign(parentRow, data);
        return 1;
      });
      return c;
    };
    db.mockImplementation(seriesChain);
    trx.mockImplementation(seriesChain);
    // monthly → every 14 days from 07-01: the child is re-dated to 07-15.
    findConflictingVisits.mockImplementation(async ({ date }) => (date === '2099-07-15' ? [{ id: 'svc-other' }] : []));

    const { status, body } = await put('svc-1', {
      isRecurring: true, spawnRecurringChildren: false, recurringPattern: 'custom', recurringIntervalDays: 14,
    });

    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.stringContaining('2099-07-15'), code: 'SLOT_TAKEN' });
    // The destination date was in the up-front lock set, with the parent's own date.
    expect(acquireOccupancyLocks).toHaveBeenCalledTimes(1);
    expect(acquireOccupancyLocks.mock.calls[0][1]).toEqual(expect.arrayContaining(['2099-07-01', '2099-07-15']));
    expect(callOrder.indexOf('occupancy:2099-07-01')).toBeLessThan(callOrder.indexOf('comms'));
    // Probed on the child's own block, ignoring the parent and the row being moved.
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx, date: '2099-07-15', windowStart: '09:00', windowEnd: '10:00',
      excludeServiceIds: expect.arrayContaining(['svc-1', 'child-1']),
      excludeStatuses: ['cancelled', 'completed'],
    }));
    expect(childWrites).toEqual([]);
    expect(trx.commit).not.toHaveBeenCalled();
  });
});
