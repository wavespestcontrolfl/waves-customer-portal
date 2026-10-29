/**
 * products_catalog.bid_list (Bid kit "Products proposed for bid work", owner 2026-10-28): PUT /:id saves a real true or false,
 * rejects anything else with a 400 before any write, and leaves the column out of a save that does not mention it.
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
const { recordAuditEvent } = require('../services/audit-log');

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
  const resolve = (q) => {
    const update = q._calls.find(([name]) => name === 'update');
    if (update) { updates.push(update[1][0]); return { id: PRODUCT, name: 'Termidor SC', category: 'herbicide', bid_list: false }; }
    return {
      id: PRODUCT, name: 'Termidor SC', category: 'herbicide', epa_reg_number: '432-1507', active_ingredient: 'x',
    };
  };
  const trx = jest.fn((table) => makeChain(table, resolve));
  trx.raw = jest.fn(async () => ({}));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction.mockImplementation(async (fn) => fn(trx));
  db.mockImplementation((table) => makeChain(table, resolve));
  return updates;
}

const send = (base, method, path, body) => fetch(`${base}/admin/inventory${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => { db.mockReset(); db.transaction.mockReset(); });

describe('PUT /:id bidList', () => {
  test.each([['true', true], ['false', false]])('saves %s as bid_list', async (_n, value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, 'PUT', `/${PRODUCT}`, { bidList: value });
      expect(res.status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].bid_list).toBe(value);
  });
  test.each([['string true', 'true'], ['zero', 0], ['one', 1], ['null', null], ['empty string', ''], ['array', [true]], ['object', { on: true }]])('rejects %s with a 400 and writes nothing', async (_n, value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, 'PUT', `/${PRODUCT}`, { bidList: value });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/bidList/);
    });
    expect(updates).toEqual([]);
  });
  test('a save that does not mention the field leaves the column out', async () => {
    const updates = wire();
    await withServer(async (base) => {
      expect((await send(base, 'PUT', `/${PRODUCT}`, { sku: 'X-1' })).status).toBe(200);
    });
    expect(Object.keys(updates[0])).not.toContain('bid_list');
  });
});
