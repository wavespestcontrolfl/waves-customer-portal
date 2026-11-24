/**
 * Limits tab save (owner 2026-11-24): PUT /:id with expectedInventoryUnit
 * saves the suggested threshold + reorder amount only when the product is
 * still stocked in the unit the suggestion was worked out in; a unit change
 * since the report loaded answers 409 and writes nothing.
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
  const resolve = (q) => {
    const update = q._calls.find(([name]) => name === 'update');
    if (update) { updates.push(update[1][0]); return { id: PRODUCT, name: 'Synthetic jug', inventory_unit: 'gal' }; }
    return { id: PRODUCT, name: 'Synthetic jug', inventory_unit: 'gal', inventory_on_hand: 1, low_stock_threshold: 1.5, reorder_quantity: 2 };
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

describe('PUT /:id expectedInventoryUnit', () => {
  test('same unit: saves the threshold and reorder amount, never the unit or auto-reorder', async () => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, 'PUT', `/${PRODUCT}`, { lowStockThreshold: 0.75, reorderQuantity: 3, expectedInventoryUnit: 'gal' });
      expect(res.status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ low_stock_threshold: 0.75, reorder_quantity: 3 });
    expect(Object.keys(updates[0])).not.toEqual(expect.arrayContaining(['inventory_unit']));
    expect(Object.keys(updates[0])).not.toContain('auto_reorder_enabled');
  });

  test('unit changed since the report loaded: 409 and nothing written', async () => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, 'PUT', `/${PRODUCT}`, { lowStockThreshold: 96, reorderQuantity: 384, expectedInventoryUnit: 'fl_oz' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/refresh the suggested limits/);
    });
    expect(updates).toEqual([]);
  });
});
