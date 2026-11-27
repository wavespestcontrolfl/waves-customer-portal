/**
 * "About this home" routes: GET/PUT /admin/schedule/:id/home-note (routes/admin-schedule.js) and GET/PUT
 * /admin/customers/:id/home-note (routes/admin-customers.js). The note logic itself runs against PostgreSQL in
 * home-note-postgres.test.js; here: who may reach each route, and that each refusal reaches the caller unchanged.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockRead = jest.fn();
const mockSave = jest.fn();
jest.mock('../services/home-note', () => ({
  ...jest.requireActual('../services/home-note'),
  readHomeNote: (...args) => mockRead(...args),
  saveHomeNote: (...args) => mockSave(...args),
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/admin-schedule');
const customersRouter = require('../routes/admin-customers');

const VISIT = '0a1b2c3d-0000-4000-8000-000000000001';
const CUSTOMER = '0a1b2c3d-0000-4000-8000-000000000002';
const VISIT_ROW = { id: VISIT, customer_id: CUSTOMER };

// ownsVisit false = the visit exists but is not the technician's (or was reassigned): the ownership-scoped read finds nothing.
// ownsVisit as an array answers the visit reads in order (the fetch, then each later recheck), so a test can reassign the
// visit between the first read and the answer: [true, false].
function stubDb({ ownsVisit = true, customerExists = true } = {}) {
  const visitReads = [].concat(ownsVisit);
  const table = (name) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.forShare = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.modify = jest.fn((cb) => { cb(q); return q; });
    q.first = jest.fn(async () => {
      if (name === 'customers') return customerExists ? { id: CUSTOMER } : undefined;
      const owns = visitReads.length > 1 ? visitReads.shift() : visitReads[0];
      if (owns === 'throw') throw new Error('connection lost');
      return owns ? VISIT_ROW : undefined;
    });
    return q;
  };
  db.mockImplementation(table);
  db.transaction.mockImplementation(async (cb) => cb(table));
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', scheduleRouter);
  app.use('/admin/customers', customersRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}
const call = (base, path, { method = 'GET', role = 'admin', body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-test-role': role },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

const NOTE = { id: 'note-a', body: 'Side gate sticks.', revision: 3, updatedAt: '2026-11-26T15:00:00.000Z', updatedByFirstName: 'Ada' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ status: 200, note: NOTE, editable: true, customerId: CUSTOMER });
  mockSave.mockResolvedValue({ status: 200, note: NOTE });
});

describe('visit routes', () => {
  test('an assigned technician reads and saves; the save carries the actor and the expected time', async () => {
    stubDb();
    await withServer(async (base) => {
      const read = await call(base, `/admin/schedule/${VISIT}/home-note`, { role: 'technician' });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ note: NOTE, editable: true, customerId: CUSTOMER });
      expect(mockRead).toHaveBeenCalledWith(VISIT_ROW);
      const put = await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'New text', expectedNoteId: NOTE.id, expectedRevision: NOTE.revision, expectedCustomerId: CUSTOMER } });
      expect(put.status).toBe(200);
      const [row, input, opts] = mockSave.mock.calls[0];
      expect(row).toEqual(VISIT_ROW);
      expect(input).toMatchObject({ body: 'New text', expectedNoteId: NOTE.id, expectedRevision: NOTE.revision, expectedCustomerId: CUSTOMER, actor: { type: 'technician', id: 'tech-1' } });
      expect(opts.conn).toBeDefined();
    });
  });

  test('a technician who does not hold the visit (unassigned or reassigned away) is 403 on GET and PUT, and nothing is read or written', async () => {
    stubDb({ ownsVisit: false });
    await withServer(async (base) => {
      const get = await call(base, `/admin/schedule/${VISIT}/home-note`, { role: 'technician' });
      expect(get.status).toBe(403);
      expect((await get.json()).code).toBe('service_not_assigned');
      const put = await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'x' } });
      expect(put.status).toBe(403);
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  test('PUT refuses a visit outside the technician\'s scope BEFORE taking the customer lock, and keeps the locked recheck', async () => {
    stubDb({ ownsVisit: [false] });
    await withServer(async (base) => {
      const res = await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'x' } });
      expect(res.status).toBe(403);
      expect(db.mock.calls.filter(([table]) => table === 'customers')).toHaveLength(0);
      expect(mockSave).not.toHaveBeenCalled();
    });
    // In scope at the first lookup but lost by the locked recheck: still refused, nothing saved.
    stubDb({ ownsVisit: [true, false] });
    mockSave.mockClear();
    await withServer(async (base) => {
      const res = await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'x' } });
      expect(res.status).toBe(403);
      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  test('an admin reaches any visit, records as admin, and gets 404 for a visit that does not exist', async () => {
    stubDb();
    await withServer(async (base) => {
      expect((await call(base, `/admin/schedule/${VISIT}/home-note`)).status).toBe(200);
      await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', body: { body: 'x' } });
      expect(mockSave.mock.calls[0][1].actor.type).toBe('admin');
      stubDb({ ownsVisit: false });
      expect((await call(base, `/admin/schedule/${VISIT}/home-note`)).status).toBe(404);
      expect((await call(base, '/admin/schedule/not-a-uuid/home-note')).status).toBe(404);
    });
  });

  test('a stale save is 409 with the current note; too long is 400; both reach the caller as the service said them', async () => {
    stubDb();
    await withServer(async (base) => {
      mockSave.mockResolvedValueOnce({ status: 409, error: 'Someone else changed this note.', code: 'note_changed', note: NOTE });
      const stale = await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'x', expectedRevision: 2 } });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'Someone else changed this note.', code: 'note_changed', note: NOTE });
      mockSave.mockResolvedValueOnce({ status: 400, error: 'The note can be at most 1000 characters.', code: 'too_long' });
      expect((await call(base, `/admin/schedule/${VISIT}/home-note`, { method: 'PUT', body: { body: 'x'.repeat(1001) } })).status).toBe(400);
    });
  });
});

describe('visit brief read', () => {
  test('every visit-brief answer carries the home note (or null), so the tech panel needs no request of its own', async () => {
    stubDb();
    await withServer(async (base) => {
      expect(await (await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' })).json()).toEqual({ brief: null, homeNote: { note: NOTE, customerId: CUSTOMER } });
      mockRead.mockResolvedValueOnce({ status: 200, note: null, editable: true, customerId: CUSTOMER });
      expect(await (await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' })).json()).toEqual({ brief: null, homeNote: { note: null, customerId: CUSTOMER } });
    });
  });

  test('a visit with no customer, or a failed note read, leaves the answer exactly as before', async () => {
    stubDb();
    await withServer(async (base) => {
      mockRead.mockResolvedValueOnce({ status: 200, note: null, editable: false });
      expect(await (await call(base, `/admin/schedule/${VISIT}/visit-brief`)).json()).toEqual({ brief: null });
      mockRead.mockRejectedValueOnce(new Error('db down'));
      const res = await call(base, `/admin/schedule/${VISIT}/visit-brief`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ brief: null });
    });
  });
});

describe('reassignment between the first read and the answer', () => {
  test('GET /:id/home-note: the note is read, the visit is then no longer the technician\'s: 403, no note in the answer', async () => {
    stubDb({ ownsVisit: [true, false] });
    await withServer(async (base) => {
      const res = await call(base, `/admin/schedule/${VISIT}/home-note`, { role: 'technician' });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(NOTE.body);
      expect(mockRead).toHaveBeenCalledTimes(1);
    });
  });

  test('GET /:id/visit-brief: the note is read, the visit is then no longer the technician\'s: the whole answer is withheld', async () => {
    stubDb({ ownsVisit: [true, false] });
    await withServer(async (base) => {
      const res = await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ brief: null });
      expect(JSON.stringify(body)).not.toContain(NOTE.body);
      expect(mockRead).toHaveBeenCalledTimes(1);
    });
  });

  test('the recheck is on even with every brief gate off, and still passes an unchanged visit', async () => {
    stubDb({ ownsVisit: [true, true] });
    await withServer(async (base) => {
      db.mockClear();
      expect(await (await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' })).json()).toEqual({ brief: null, homeNote: { note: NOTE, customerId: CUSTOMER } });
      // One scoped visit fetch and ONE ownership recheck (finalRecheck), not a second copy for the note.
      expect(db.mock.calls.filter(([table]) => table === 'scheduled_services')).toHaveLength(2);
    });
  });
});

describe('the ownership check cannot run', () => {
  test('visit-brief withholds the whole answer, whatever the brief gates (cached access codes never go out)', async () => {
    stubDb({ ownsVisit: [true, 'throw'] });
    await withServer(async (base) => {
      const res = await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ brief: null });
    });
  });

  test('visit-brief withholds the answer when the note read itself fails but the visit was lost', async () => {
    stubDb({ ownsVisit: [true, false] });
    mockRead.mockRejectedValueOnce(new Error('db down'));
    await withServer(async (base) => {
      expect(await (await call(base, `/admin/schedule/${VISIT}/visit-brief`, { role: 'technician' })).json()).toEqual({ brief: null });
    });
  });
});

describe('office routes', () => {
  test('an admin reads and saves a customer\'s home note; the service is told it is the office', async () => {
    stubDb();
    await withServer(async (base) => {
      expect((await call(base, `/admin/customers/${CUSTOMER}/home-note`)).status).toBe(200);
      expect(mockRead).toHaveBeenCalledWith({ customer_id: CUSTOMER });
      const put = await call(base, `/admin/customers/${CUSTOMER}/home-note`, { method: 'PUT', body: { body: 'Call before arriving.' } });
      expect(put.status).toBe(200);
      expect(mockSave.mock.calls[0][0]).toEqual({ customer_id: CUSTOMER });
    });
  });

  test('a technician is 403 on both office routes and the service is never called', async () => {
    stubDb();
    await withServer(async (base) => {
      expect((await call(base, `/admin/customers/${CUSTOMER}/home-note`, { role: 'technician' })).status).toBe(403);
      expect((await call(base, `/admin/customers/${CUSTOMER}/home-note`, { method: 'PUT', role: 'technician', body: { body: 'x' } })).status).toBe(403);
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  test('an unknown customer is 404', async () => {
    stubDb({ customerExists: false });
    await withServer(async (base) => {
      expect((await call(base, `/admin/customers/${CUSTOMER}/home-note`)).status).toBe(404);
      expect((await call(base, `/admin/customers/${CUSTOMER}/home-note`, { method: 'PUT', body: { body: 'x' } })).status).toBe(404);
    });
  });
});
