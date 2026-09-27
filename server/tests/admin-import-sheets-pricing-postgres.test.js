/**
 * admin-import-sheets.js's POST /pricing route — the catalog-create race
 * with createCatalogProduct (inventory-operations.js) and the purchase-
 * receipt inventory agent (2026-09-27 review, item 3): the importer's own
 * product insert now takes the SAME advisory lock and re-checks the SAME
 * exact-active-name duplicate under it, so it can never create a second row
 * for a name another writer just committed. Same PG-suite convention as
 * inventory-agent-postgres.test.js (a LIKE-copy schema, dropped after the
 * suite) and the same real-HTTP-server pattern admin-projects-routes.test.js
 * uses (no supertest in this repo) — global fetch against an ephemeral
 * express server with the router under test mounted.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const express = require('express');
const fs = require('fs');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const inventoryOperations = require('../services/inventory-operations');
const importRouter = require('../routes/admin-import-sheets');

const TABLES = ['products_catalog', 'vendor_pricing', 'vendors'];

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('admin-import-sheets pricing import on PostgreSQL', () => {
  const schema = `import_sheets_${randomUUID().replaceAll('-', '')}`;
  let existsSpy;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    // The route reads a bundled CSV file (server/data/pricing.csv) before it
    // ever looks at the request body — force both file fallbacks to miss so
    // the test's own CSV (sent as req.body.csvData) is what actually runs.
    existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  });
  afterEach(async () => {
    for (const table of TABLES) await mockConn.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    existsSpy.mockRestore();
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  function appServer() {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/import', importRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { server, baseUrl };
  }

  async function withServer(fn) {
    const { server, baseUrl } = appServer();
    try {
      return await fn(baseUrl);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function postPricing(baseUrl, csvData) {
    return fetch(`${baseUrl}/api/admin/import/pricing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvData }),
    });
  }

  test('a name with nothing already in the catalog inserts exactly one product', async () => {
    const csv = 'Product,Category,Size\nBifen XTS,insecticide,96 oz\n';
    await withServer(async (baseUrl) => {
      const res = await postPricing(baseUrl, csv);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, imported: 1 });
    });
    const products = await mockConn('products_catalog').where({ name: 'Bifen XTS' });
    expect(products).toHaveLength(1);
  });

  test('a product created by another writer WHILE the import is waiting on the catalog lock is reused, never duplicated', async () => {
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The admin "add product" screen's own insert (createCatalogProduct),
    // holding its transaction — and the catalog lock — open. Its row is
    // NOT YET COMMITTED when the import route runs its own pre-check
    // (whereILike), so that pre-check sees nothing, exactly like the real
    // race the review flagged: the import's OWN transaction only discovers
    // the new row once it acquires the same lock, after this one commits.
    const manual = mockConn.transaction(async (trx) => {
      await inventoryOperations.createCatalogProduct({ name: 'Bifen XTS', category: 'insecticide', unitSize: '96 oz', inventoryUnit: 'oz' }, { trx });
      signalLocked();
      await held;
    });
    await locked;

    const csv = 'Product,Category,Size\nBifen XTS,insecticide,96 oz\n';
    await withServer(async (baseUrl) => {
      const reqPromise = postPricing(baseUrl, csv);
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      release();
      await manual;
      const res = await reqPromise;
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, imported: 1 });
    });

    const products = await mockConn('products_catalog').where({ name: 'Bifen XTS' });
    expect(products).toHaveLength(1); // never two, however the race lands
    expect(products[0].container_size).toBe('96 oz'); // the manual side's row, reused — not a second insert
  });

  test('a duplicate discovered under the lock is enriched the SAME way the outer whereILike hit is (review item 3)', async () => {
    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // Another writer's row, sparse on details (createCatalogProduct's own
    // placeholders for active_ingredient/epa_reg_number, no sku, no
    // unit_size_oz) — exactly what this importer would have backfilled had
    // it found the row through its OWN whereILike pre-check instead of
    // discovering it a moment later, under the lock.
    const manual = mockConn.transaction(async (trx) => {
      await inventoryOperations.createCatalogProduct({ name: 'Bifen XTS', category: 'insecticide', unitSize: '96 oz', inventoryUnit: 'oz' }, { trx });
      signalLocked();
      await held;
    });
    await locked;

    const csv = 'Product,Category,Size,SKU,EPA Reg #,Active Ingredient\nBifen XTS,insecticide,96 oz,SKU123,12345-67,Bifenthrin\n';
    await withServer(async (baseUrl) => {
      const reqPromise = postPricing(baseUrl, csv);
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      release();
      await manual;
      const res = await reqPromise;
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, imported: 1 });
    });

    const products = await mockConn('products_catalog').where({ name: 'Bifen XTS' });
    expect(products).toHaveLength(1); // still never duplicated
    const [product] = products;
    // Backfilled — the row was missing these (placeholder/blank).
    expect(product.active_ingredient).toBe('Bifenthrin');
    expect(product.epa_reg_number).toBe('12345-67');
    expect(product.sku).toBe('SKU123');
    expect(Number(product.unit_size_oz)).toBe(96);
    // NOT overwritten — the manual side's row already had a container_size.
    expect(product.container_size).toBe('96 oz');
  });
});
