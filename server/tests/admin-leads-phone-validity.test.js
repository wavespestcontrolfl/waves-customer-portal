// Lead create/update refuse a US-shaped phone that can never be texted (area
// code or exchange starting 0/1; Twilio 21211) with a readable 400 and no write.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const BAD = '+11035550123';
let writes;
function prime(existing) {
  writes = [];
  db.mockImplementation((table) => {
    if (table === 'leads') {
      const q = {};
      for (const m of ['where', 'whereNull', 'forUpdate']) q[m] = jest.fn(() => q);
      q.first = jest.fn(async () => existing);
      q.insert = jest.fn((row) => { writes.push({ table, row }); return { returning: jest.fn(async () => [{ id: 'lead-1', ...row }]) }; });
      q.update = jest.fn((patch) => { writes.push({ table, patch }); return { returning: jest.fn(async () => [{ ...existing, ...patch }]) }; });
      return q;
    }
    if (table === 'lead_activities') return { insert: jest.fn(async () => [1]) };
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction = jest.fn(async (work) => work(db));
  db.raw = jest.fn(async () => ({ rows: [] }));
});

const send = (baseUrl, method, path, body) => fetch(`${baseUrl}/admin/leads${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('create refuses an impossible US phone with 400 INVALID_PHONE and writes nothing', async () => {
  prime(null);
  await withServer(async (baseUrl) => {
    const res = await send(baseUrl, 'POST', '', { first_name: 'Test', phone: '1035550123' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_PHONE');
    expect(body.error).toMatch(/not a valid US phone number/);
  });
  expect(writes).toEqual([]);
});

test('create still stores a valid number as E.164', async () => {
  prime(null);
  await withServer(async (baseUrl) => {
    const res = await send(baseUrl, 'POST', '', { first_name: 'Test', phone: '(203) 555-0123' });
    expect(res.status).toBe(200);
  });
  expect(writes[0].row.phone).toBe('+12035550123');
});

test('update refuses a newly entered impossible US phone and writes nothing', async () => {
  prime({ id: 'lead-1', status: 'new', phone: '+12035550123' });
  await withServer(async (baseUrl) => {
    const res = await send(baseUrl, 'PUT', '/lead-1', { phone: '1035550123' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PHONE');
  });
  expect(writes).toEqual([]);
});

test('update does not block an unchanged stored number echoed by a full-form save', async () => {
  prime({ id: 'lead-1', status: 'new', phone: BAD });
  await withServer(async (baseUrl) => {
    const res = await send(baseUrl, 'PUT', '/lead-1', { phone: BAD, first_name: 'Testb' });
    expect(res.status).toBe(200);
  });
  expect(writes.some((w) => w.patch && w.patch.first_name === 'Testb')).toBe(true);
});
