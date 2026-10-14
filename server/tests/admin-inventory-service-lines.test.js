/**
 * products_catalog.service_lines (which service lines apply a product; the tech
 * lawn sheet lists lawn-tagged products only) on PUT /admin/inventory/:id: a
 * list of detectServiceLine ids is stored as JSON, null clears the tag, any
 * other value is a 400 before any write, and a body without the field leaves
 * the column alone. The list read maps it back as serviceLines.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', name: 'Owner' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const inventoryRouter = require('../routes/admin-inventory');

const PRODUCT = '11111111-1111-4111-8111-111111111111';

function makeChain(table, resolve) {
  const q = { _table: table, _calls: [] };
  ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; }); });
  q.update = jest.fn((...args) => { q._calls.push(['update', args]); return q; });
  q.returning = jest.fn(async () => [resolve(q)]);
  q.first = jest.fn(async () => resolve(q));
  q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(q)).then(onOk, onErr);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

// Returns the update bodies written to products_catalog.
function wire() {
  const updates = [];
  const row = { id: PRODUCT, name: 'Arena 50 WDG', category: 'insecticide', epa_reg_number: '59639-150', active_ingredient: 'clothianidin', service_lines: null };
  const resolve = (q) => {
    const update = q._calls.find(([name]) => name === 'update');
    if (update) { updates.push(update[1][0]); return row; }
    return row;
  };
  const trx = jest.fn((table) => makeChain(table, resolve));
  trx.raw = jest.fn(async () => ({}));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction.mockImplementation(async (fn) => fn(trx));
  db.mockImplementation((table) => makeChain(table, resolve));
  return updates;
}

const put = (base, body) => fetch(`${base}/admin/inventory/${PRODUCT}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => { db.mockReset(); db.transaction.mockReset(); });

describe('PUT /:id serviceLines', () => {
  test('stores a list of service-line ids as JSON, de-duplicated', async () => {
    const updates = wire();
    await withServer(async (base) => {
      expect((await put(base, { serviceLines: ['lawn', 'pest', 'lawn'] })).status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].service_lines).toBe(JSON.stringify(['lawn', 'pest']));
  });

  test('null clears the tag (the sheets go by the category again)', async () => {
    const updates = wire();
    await withServer(async (base) => {
      expect((await put(base, { serviceLines: null })).status).toBe(200);
    });
    expect(updates[0].service_lines).toBeNull();
  });

  test('a body without the field leaves the column alone', async () => {
    const updates = wire();
    await withServer(async (base) => {
      expect((await put(base, { name: 'Arena 50 WDG' })).status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    expect('service_lines' in updates[0]).toBe(false);
  });

  test.each([
    ['an unknown line', ['lawn', 'pool']],
    ['a string', 'lawn'],
    ['an object', { lawn: true }],
  ])('rejects %s with a 400 and writes nothing', async (_name, value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await put(base, { serviceLines: value });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Service lines must be a list of: pest, lawn/);
    });
    expect(updates).toEqual([]);
  });
});
