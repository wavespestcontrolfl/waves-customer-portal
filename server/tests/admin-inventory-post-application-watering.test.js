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
