/**
 * products_catalog.post_application_watering is validated on every admin save
 * (PUT /:id and PATCH /lawn-outline-facts/:id): an invalid rule is a 400 before
 * any write; a valid one is stored normalized (stamped as an owner edit when
 * source / verified_* are omitted); null / '' clears it.
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
    if (update) { updates.push(update[1][0]); return { id: PRODUCT, name: 'Celsius WG', category: 'herbicide', post_application_watering: null }; }
    return { id: PRODUCT, name: 'Celsius WG', category: 'herbicide', epa_reg_number: '432-1507', active_ingredient: 'x' };
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

describe.each([
  ['PUT /:id', 'PUT', `/${PRODUCT}`],
  ['PATCH /lawn-outline-facts/:id', 'PATCH', `/lawn-outline-facts/${PRODUCT}`],
])('%s post_application_watering', (_label, method, path) => {
  test.each([
    ['unknown mode', { mode: 'sometimes', source: 'owner' }],
    ['negative hours', { mode: 'hold', hold_hours: -2, source: 'owner' }],
    ['mow_hold_days', { mode: 'hold', hold_hours: 24, source: 'owner', mow_hold_days: 2 }],
    ['not an object', 'hold'],
    ['array', [1]],
    ['bad json string', '{nope'],
  ])('rejects %s with a 400 and writes nothing', async (_name, value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { postApplicationWatering: value });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/postApplicationWatering/);
    });
    expect(updates).toEqual([]);
  });

  test('stores a valid rule normalized, stamped as an owner edit when source is omitted', async () => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { postApplicationWatering: { mode: 'hold', hold_hours: 12 } });
      expect(res.status).toBe(200);
    });
    expect(updates).toHaveLength(1);
    const stored = JSON.parse(updates[0].post_application_watering);
    expect(stored).toMatchObject({ mode: 'hold', hold_hours: 12, source: 'owner', verified_by: 'Owner' });
    expect(Date.parse(stored.verified_at)).not.toBeNaN();
  });

  test('keeps an explicit label source and note', async () => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, {
        postApplicationWatering: { mode: 'water_in', source: 'label', label_note: 'Apply in sufficient water' },
      });
      expect(res.status).toBe(200);
    });
    expect(JSON.parse(updates[0].post_application_watering)).toMatchObject({
      mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label', label_note: 'Apply in sufficient water',
    });
  });

  test.each([[null], ['']])('%j clears the rule', async (value) => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { postApplicationWatering: value });
      expect(res.status).toBe(200);
    });
    expect(updates[0].post_application_watering).toBeNull();
  });

  test('a save that does not mention the field leaves the column out of the update', async () => {
    const updates = wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { sku: 'X-1', publicSummary: 'ok' });
      expect(res.status).toBe(200);
    });
    expect(Object.keys(updates[0])).not.toContain('post_application_watering');
  });
});

describe('audit trail (local audit P1 on #5393)', () => {
  beforeEach(() => recordAuditEvent.mockClear());

  test.each([
    ['PATCH', `/lawn-outline-facts/${PRODUCT}`],
    ['PUT', `/${PRODUCT}`],
  ])('%s records an audit_log entry with before/after when the rule changes', async (method, path) => {
    wire();
    await withServer(async (base) => {
      const res = await send(base, method, path, { postApplicationWatering: { mode: 'hold', hold_hours: 12 } });
      expect(res.status).toBe(200);
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const call = recordAuditEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      actor_type: 'technician', actor_id: 'admin-1',
      action: 'products_catalog.post_application_watering.updated',
      resource_type: 'products_catalog', resource_id: PRODUCT,
    });
    expect(call.metadata.before).toBeNull();
    expect(call.metadata.after).toMatchObject({ mode: 'hold', hold_hours: 12, source: 'owner', verified_by: 'Owner' });
    // Both paths audit inside the locked transaction: critical, so the audit
    // and the catalog save commit or roll back together.
    expect(call.critical).toBe(true);
    expect(call.trx).toBeTruthy();
  });

  test.each([
    ['PUT', `/${PRODUCT}`],
    ['PATCH', `/lawn-outline-facts/${PRODUCT}`],
  ])('%s: a failed audit insert fails the save instead of being swallowed inside the transaction', async (method, path) => {
    wire();
    recordAuditEvent.mockImplementationOnce(async () => { throw new Error('audit down'); });
    await withServer(async (base) => {
      const res = await send(base, method, path, { postApplicationWatering: { mode: 'hold', hold_hours: 12 } });
      expect(res.status).toBe(500);
    });
  });

  test('PATCH reads the product row FOR UPDATE inside the transaction, ahead of the update', async () => {
    const order = [];
    const updates = wire();
    const trxImpl = db.transaction.getMockImplementation();
    db.transaction.mockImplementation(async (fn) => trxImpl(async (trx) => {
      const wrapped = jest.fn((table) => {
        const q = trx(table);
        const lock = q.forUpdate;
        q.forUpdate = jest.fn((...a) => { order.push('forUpdate'); return lock(...a); });
        const upd = q.update;
        q.update = jest.fn((...a) => { order.push('update'); return upd(...a); });
        return q;
      });
      Object.assign(wrapped, trx);
      return fn(wrapped);
    }));
    await withServer(async (base) => {
      const res = await send(base, 'PATCH', `/lawn-outline-facts/${PRODUCT}`, { postApplicationWatering: { mode: 'hold', hold_hours: 12 } });
      expect(res.status).toBe(200);
    });
    expect(order).toEqual(['forUpdate', 'update']);
    expect(updates).toHaveLength(1);
  });

  test('PATCH: 404 for a missing product (no write), 422 readiness refusal unchanged, both inside the lock', async () => {
    const updates = [];
    const resolve = (q) => {
      if (q._calls.find(([name]) => name === 'update')) { updates.push(1); return {}; }
      return q._missing ? null : { id: PRODUCT, name: 'Celsius WG', category: 'herbicide' };
    };
    const trx = jest.fn((table) => { const q = makeChain(table, resolve); q._missing = trx.missing; return q; });
    trx.raw = jest.fn(async () => ({}));
    db.transaction.mockImplementation(async (fn) => fn(trx));
    trx.missing = true;
    await withServer(async (base) => {
      expect((await send(base, 'PATCH', `/lawn-outline-facts/${PRODUCT}`, { publicSummary: 'x' })).status).toBe(404);
      trx.missing = false;
      const res = await send(base, 'PATCH', `/lawn-outline-facts/${PRODUCT}`, { approve: true });
      expect(res.status).toBe(422);
    });
    expect(updates).toEqual([]);
  });

  test('a save that does not mention the field records nothing', async () => {
    wire();
    await withServer(async (base) => {
      const res = await send(base, 'PATCH', `/lawn-outline-facts/${PRODUCT}`, { irrigationNotes: 'x' });
      expect(res.status).toBe(200);
    });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
