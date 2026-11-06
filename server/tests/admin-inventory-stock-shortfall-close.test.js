/**
 * A pest visit that took a product below zero leaves one open office alert for it. The
 * Products table's inline stock edit (PUT /:id) writes the count and a correction movement directly, so it must close
 * that alert like adjustStock does, or the stale open row would hide the next real shortfall (dedupeOpenOnly).
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
jest.mock('../services/inventory-operations', () => ({
  ...jest.requireActual('../services/inventory-operations'),
  clearStockShortfallAlert: jest.fn(async () => {}),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', name: 'Owner' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const inventoryRouter = require('../routes/admin-inventory');
const { clearStockShortfallAlert } = require('../services/inventory-operations');

const PRODUCT = '22222222-2222-4222-8222-222222222222';

function makeChain(table, resolve, writes) {
  const q = { _table: table, _calls: [] };
  ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; }); });
  q.update = jest.fn((...args) => { q._calls.push(['update', args]); writes.push({ table, update: args[0] }); return q; });
  q.insert = jest.fn((...args) => { q._calls.push(['insert', args]); writes.push({ table, insert: args[0] }); return q; });
  q.returning = jest.fn(async () => [resolve(q)]);
  q.first = jest.fn(async () => resolve(q));
  q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(q)).then(onOk, onErr);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

// The product reads at `onHand` fl oz; returns the writes and the transaction the route ran on.
function wire(onHand) {
  const writes = [];
  const row = { id: PRODUCT, name: 'Taurus SC', category: 'insecticide', inventory_on_hand: onHand, inventory_unit: 'fl_oz', low_stock_threshold: null };
  const resolve = () => row;
  const trx = jest.fn((table) => makeChain(table, resolve, writes));
  trx.raw = jest.fn(async () => ({}));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction.mockImplementation(async (fn) => fn(trx));
  db.mockImplementation((table) => makeChain(table, resolve, writes));
  return { writes, trx };
}

const put = (base, body) => fetch(`${base}/admin/inventory/${PRODUCT}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { db.mockReset(); db.transaction.mockReset(); clearStockShortfallAlert.mockClear(); });

describe('PUT /:id inline stock edit and the pest stock shortfall alert', () => {
  test('a count edited from below zero to zero or above closes the alert, on the edit\'s own transaction', async () => {
    const { writes, trx } = wire('-6.0000');
    await withServer(async (base) => {
      const res = await put(base, { inventoryOnHand: 12, inventoryOnHandBefore: -6 });
      expect(res.status).toBe(200);
    });
    expect(writes).toEqual(expect.arrayContaining([
      { table: 'product_inventory_movements', insert: expect.objectContaining({ movement_type: 'correction', stock_before: -6, stock_after: 12 }) },
    ]));
    expect(clearStockShortfallAlert).toHaveBeenCalledTimes(1);
    expect(clearStockShortfallAlert).toHaveBeenCalledWith(trx, PRODUCT, 12, 'fl_oz');
  });

  test('a save that leaves the count alone does not touch the alert', async () => {
    wire('-6.0000');
    await withServer(async (base) => {
      const res = await put(base, { lowStockThreshold: 5 });
      expect(res.status).toBe(200);
    });
    expect(clearStockShortfallAlert).not.toHaveBeenCalled();
  });
});

// The inline editor fills its stock box from the list as it loaded; a visit
// closeout since then moved the live count (daily-work audit 11-05).
describe('PUT /:id refuses a stock count typed over a stale start', () => {
  test('a start that no longer matches the live count is refused with no write', async () => {
    const { writes } = wire('7.0000');
    let res;
    await withServer(async (base) => {
      res = await put(base, { name: 'Taurus SC 2', inventoryOnHand: 10, inventoryOnHandBefore: 10 });
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Stock changed after this product was opened/);
    expect(writes).toEqual([]);
    expect(clearStockShortfallAlert).not.toHaveBeenCalled();
  });

  test('a stock change without its start count is refused', async () => {
    const { writes } = wire('7.0000');
    let res;
    await withServer(async (base) => {
      res = await put(base, { inventoryOnHand: 10 });
    });
    expect(res.status).toBe(400);
    expect(writes).toEqual([]);
  });

  test('a start that matches the live count writes the new count', async () => {
    const { writes } = wire('7.0000');
    await withServer(async (base) => {
      const res = await put(base, { inventoryOnHand: 10, inventoryOnHandBefore: 7 });
      expect(res.status).toBe(200);
    });
    expect(writes).toEqual(expect.arrayContaining([
      { table: 'products_catalog', update: expect.objectContaining({ inventory_on_hand: 10 }) },
      { table: 'product_inventory_movements', insert: expect.objectContaining({ stock_before: 7, stock_after: 10 }) },
    ]));
  });
});
