// Daily-work audit 11-06: the Manual Adjustment form posted the same adjustment
// twice on a double tap (+5 became +10). A draft's idempotency key applies it
// once: a repeat send (two at once too) answers with the saved movement, the
// same key with other values is refused, and a call without a key is unchanged.
// CI's DB-gated pass runs this on the migrated PostgreSQL. Fixture tables are
// LIKE copies in a throwaway schema, dropped after the suite.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', name: 'Owner' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const { adjustStock } = require('../services/inventory-operations');

const TABLES = ['products_catalog', 'product_inventory_movements'];

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('manual stock adjustment idempotency on PostgreSQL', () => {
  const schema = `inventory_adjust_${randomUUID().replaceAll('-', '')}`;
  let product;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  });
  beforeEach(async () => {
    [product] = await mockConn('products_catalog').insert({
      name: 'Synthetic Restock SC', active: true, inventory_unit: 'lb', inventory_on_hand: 10,
    }).returning('*');
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  const stock = async () => Number((await mockConn('products_catalog').where({ id: product.id }).first()).inventory_on_hand);
  const movements = () => mockConn('product_inventory_movements').where({ product_id: product.id });
  const restock = { movementType: 'restock', quantity: 5, unit: 'lb' };
  const options = (idempotencyKey) => ({ source: 'admin_manual_adjustment', allowConversion: false, idempotencyKey });

  test('two sends of one draft at once add the stock once and both answer with the same movement', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([adjustStock(product.id, restock, options(key)), adjustStock(product.id, restock, options(key))]);
    expect(await stock()).toBe(15);
    expect(await movements()).toHaveLength(1);
    expect(a.movement.id).toBe(b.movement.id);
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
  });

  test('a retry after a lost reply answers with the saved movement and changes nothing', async () => {
    const key = randomUUID();
    const first = await adjustStock(product.id, restock, options(key));
    const retry = await adjustStock(product.id, restock, options(key));
    expect(retry).toMatchObject({ success: true, replayed: true, movement: { id: first.movement.id } });
    expect(await stock()).toBe(15);
    expect(await movements()).toHaveLength(1);
  });

  test('the same key with other values is refused and changes nothing', async () => {
    const key = randomUUID();
    await adjustStock(product.id, restock, options(key));
    await expect(adjustStock(product.id, { ...restock, quantity: 6 }, options(key)))
      .rejects.toMatchObject({ statusCode: 409, code: 'idempotency_key_mismatch' });
    expect(await stock()).toBe(15);
    expect(await movements()).toHaveLength(1);
  });

  test('a new draft key adjusts again, and a call without a key keeps the old behavior', async () => {
    await adjustStock(product.id, restock, options(randomUUID()));
    await adjustStock(product.id, restock, options(randomUUID()));
    await adjustStock(product.id, restock, options(undefined));
    await adjustStock(product.id, restock, options(undefined));
    expect(await stock()).toBe(30);
    const saved = await movements();
    expect(saved).toHaveLength(4);
    expect(saved.filter((m) => m.metadata.idempotencyKey)).toHaveLength(2);
  });

  test('a malformed key is refused before any write', async () => {
    await expect(adjustStock(product.id, restock, options('short'))).rejects.toMatchObject({ statusCode: 400 });
    await expect(adjustStock(product.id, restock, options(42))).rejects.toMatchObject({ statusCode: 400 });
    expect(await stock()).toBe(10);
    expect(await movements()).toHaveLength(0);
  });

  test('POST /:productId/adjust passes the form key through: a repeat send changes nothing', async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/admin/inventory', require('../routes/admin-inventory'));
    const server = app.listen(0);
    try {
      const post = () => fetch(`http://127.0.0.1:${server.address().port}/admin/inventory/${product.id}/adjust`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...restock, idempotencyKey: 'draft-key-0001' }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
      const first = await post();
      const second = await post();
      expect(first).toMatchObject({ status: 200, body: { success: true } });
      expect(first.body.replayed).toBeUndefined();
      expect(second).toMatchObject({ status: 200, body: { success: true, replayed: true, movement: { id: first.body.movement.id } } });
      expect(await stock()).toBe(15);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
