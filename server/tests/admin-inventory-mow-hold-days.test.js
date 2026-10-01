/**
 * products_catalog.mow_hold_days is validated on every admin save (PUT /:id and
 * PATCH /lawn-outline-facts/:id): an integer 1..14 is stored, null / '' clears
 * it, anything else is a 400 before any write; a change is audited.
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
function wire(existingMow = undefined) {
  const updates = [];
  const resolve = (q) => {
    const update = q._calls.find(([name]) => name === 'update');
    if (update) { updates.push(update[1][0]); return { id: PRODUCT, name: 'Celsius WG', category: 'herbicide', mow_hold_days: null }; }
    return {
      id: PRODUCT, name: 'Celsius WG', category: 'herbicide', epa_reg_number: '432-1507', active_ingredient: 'x',
      ...(existingMow !== undefined ? { mow_hold_days: existingMow } : {}),
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

beforeEach(() => { db.mockReset(); db.transaction.mockReset(); recordAuditEvent.mockClear(); });

describe.each([
  ['PUT /:id', 'PUT', `/${PRODUCT}`],
  ['PATCH /lawn-outline-facts/:id', 'PATCH', `/lawn-outline-facts/${PRODUCT}`],
])('%s mow_hold_days', (_label, method, path) => {
  test.each([
    ['zero', 0],
    ['fifteen', 15],
    ['negative', -1],
    ['fractional', 1.5],
    ['non-numeric string', 'two'],
    ['fractional string', '1.5'],
    ['boolean', true],
    ['array', [2]],
    ['object', { days: 2 }],
  ])('rejects %s with a 400 and writes nothing', async (_name, value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { mowHoldDays: value });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/mowHoldDays/);
    });
    expect(updates).toEqual([]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test.each([[1, 1], [2, 2], [14, 14], ['3', 3]])('stores %j as the integer %j', async (value, stored) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { mowHoldDays: value });
      expect(res.status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].mow_hold_days).toBe(stored);
  });

  test.each([[null], ['']])('%j clears the value', async (value) => {
    const updates = wire(2);
    await withServer(async (base) => {
      const res = await send(base, method, path, { mowHoldDays: value });
      expect(res.status).toBe(200);
    });
    expect(updates[0].mow_hold_days).toBeNull();
  });

  test('a save that does not mention the field leaves the column out and audits nothing', async () => {
    const updates = wire(2);
    await withServer(async (base) => {
      const res = await send(base, method, path, { sku: 'X-1', publicSummary: 'ok' });
      expect(res.status).toBe(200);
    });
    expect(Object.keys(updates[0])).not.toContain('mow_hold_days');
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('records an audit entry with before/after inside the locked transaction', async () => {
    wire(2);
    await withServer(async (base) => {
      const res = await send(base, method, path, { mowHoldDays: 5 });
      expect(res.status).toBe(200);
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const call = recordAuditEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      actor_type: 'technician', actor_id: 'admin-1',
      action: 'products_catalog.mow_hold_days.updated',
      resource_type: 'products_catalog', resource_id: PRODUCT,
    });
    expect(call.metadata).toMatchObject({ before: 2, after: 5, actor_name: 'Owner' });
    expect(call.critical).toBe(true);
    expect(call.trx).toBeTruthy();
  });

  test('clearing records before -> null', async () => {
    wire(7);
    await withServer(async (base) => {
      expect((await send(base, method, path, { mowHoldDays: null })).status).toBe(200);
    });
    expect(recordAuditEvent.mock.calls[0][0].metadata).toMatchObject({ before: 7, after: null });
  });

  test('resubmitting the same value records nothing', async () => {
    wire(3);
    await withServer(async (base) => {
      expect((await send(base, method, path, { mowHoldDays: 3 })).status).toBe(200);
    });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a failed audit insert fails the save instead of being swallowed inside the transaction', async () => {
    wire();
    recordAuditEvent.mockImplementationOnce(async () => { throw new Error('audit down'); });
    await withServer(async (base) => {
      const res = await send(base, method, path, { mowHoldDays: 2 });
      expect(res.status).toBe(500);
    });
  });
});
