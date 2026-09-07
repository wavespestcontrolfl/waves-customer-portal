/**
 * PUT /:productId/pricing — optional `vendorSku` writes vendor_pricing.vendor_sku
 * (the identifier the order dispatcher orders by); omitted leaves the stored
 * SKU untouched; malformed → 400 before any write.
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
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.adminUser = { id: 'admin-1', name: 'Owner' }; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const inventoryRouter = require('../routes/admin-inventory');

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VENDOR = '22222222-2222-4222-8222-222222222222';

function makeChain(table, resolve) {
  const q = { _table: table, _calls: [] };
  ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'join', 'leftJoin', 'limit', 'offset', 'forUpdate', 'returning', 'groupBy']
    .forEach((m) => { q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; }); });
  q.update = jest.fn((...args) => { q._calls.push(['update', args]); return q; });
  q.insert = jest.fn((...args) => { q._calls.push(['insert', args]); return q; });
  q.first = jest.fn(async () => { q._calls.push(['first', []]); return resolve(q); });
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
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

// Wire a transaction whose vendor_pricing has `existing` (null = insert path);
// returns the vendor_pricing writes (insert bodies / update bodies) observed.
function wire(existing) {
  const writes = [];
  const resolve = (q) => {
    if (q._table === 'vendor_pricing') {
      if (q.called('insert')) { writes.push({ kind: 'insert', body: q.args('insert')[0] }); return [{ id: 'vp-new' }]; }
      if (q.called('update')) { writes.push({ kind: 'update', body: q.args('update')[0] }); return 1; }
      return existing;
    }
    if (q._table === 'products_catalog') return { id: PRODUCT, unit_size_oz: null, container_size: null };
    if (q._table === 'price_history' || q._table === 'price_snapshots') return q.called('insert') ? [{ id: 'snap-1' }] : null;
    return q.called('insert') || q.called('update') ? 1 : [];
  };
  const trx = jest.fn((table) => makeChain(table, resolve));
  trx.raw = jest.fn(async () => ({}));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction.mockImplementation(async (fn) => fn(trx));
  db.mockImplementation((table) => makeChain(table, resolve));
  return writes;
}

beforeEach(() => { jest.clearAllMocks(); db.fn = { now: jest.fn(() => 'NOW()') }; });

const put = (baseUrl, body) => fetch(`${baseUrl}/admin/inventory/${PRODUCT}/pricing`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vendorId: VENDOR, price: 13.14, quantity: '1 count', ...body }),
});

test('vendorSku lands on the new vendor_pricing row, trimmed', async () => {
  const writes = wire(null);
  await withServer(async (baseUrl) => {
    const res = await put(baseUrl, { vendorSku: ' IN2CARE-STNKIT ' });
    expect(res.status).toBe(200);
  });
  const ins = writes.find((w) => w.kind === 'insert');
  expect(ins.body.vendor_sku).toBe('IN2CARE-STNKIT');
  expect(ins.body.price).toBe(13.14);
});

test('vendorSku updates the existing row; omitting it leaves the stored SKU alone', async () => {
  let writes = wire({ id: 'vp-1', price: 12, quantity: '1 count', vendor_sku: 'OLD-SKU' });
  await withServer(async (baseUrl) => { expect((await put(baseUrl, { vendorSku: '68544840' })).status).toBe(200); });
  expect(writes.find((w) => w.kind === 'update').body.vendor_sku).toBe('68544840');

  writes = wire({ id: 'vp-1', price: 12, quantity: '1 count', vendor_sku: 'OLD-SKU' });
  await withServer(async (baseUrl) => { expect((await put(baseUrl, {})).status).toBe(200); });
  expect(Object.prototype.hasOwnProperty.call(writes.find((w) => w.kind === 'update').body, 'vendor_sku')).toBe(false);
});

test('a blank or over-long vendorSku is a 400 before any write', async () => {
  const writes = wire(null);
  await withServer(async (baseUrl) => {
    expect((await put(baseUrl, { vendorSku: '   ' })).status).toBe(400);
    expect((await put(baseUrl, { vendorSku: 'x'.repeat(51) })).status).toBe(400);
  });
  expect(writes).toEqual([]);
  expect(db.transaction).not.toHaveBeenCalled();
});
