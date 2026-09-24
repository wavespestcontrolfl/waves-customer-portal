// Audit repro r2-tech-reachable-leftovers-dispatch-protocols-1:
// GET /api/admin/dispatch/products/catalog returns the raw products_catalog
// row (best_price, best_vendor, cost_per_unit, monthly_cost_estimate, cached
// best-price fields, vendor ids) to a technician-role token. The router is
// adminAuthenticate + requireTechOrAdmin (admin-dispatch.js:205) and the
// handler (admin-dispatch.js:2869) selects every column with no projection.
//
// Expected behaviour (asserted here, so the test FAILS on current code):
// the same owner-only projection admin-inventory applies to technician
// callers of GET /api/admin/inventory (OWNER_ONLY_PRODUCT_FIELDS /
// stripOwnerPricing, admin-inventory.js:608-619).
//
// Pattern: real adminAuthenticate + requireTechOrAdmin with a signed JWT and
// a mocked technicians row (tests/audit-repro/r1-inventory-time-5-*.test.js).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-dispatch-catalog-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');

const staff = Object.fromEntries(['admin', 'technician'].map(role => [role, {
  id: role, role, employment_status: 'active', auth_token_version: 1,
}]));

// One active catalog row shaped like the real products_catalog table
// (columns confirmed against waves_audit_tpl information_schema).
const catalogRow = {
  id: 'prod-1', name: 'Talak 7.9F', category: 'insecticide', active: true,
  active_ingredient: 'bifenthrin', default_rate: '1', default_unit: 'oz/1000',
  unit_size_oz: '96', inventory_on_hand: '3', low_stock_threshold: '1',
  // owner-only (2026-08-25 role lockdown):
  best_price: '123.45', best_vendor: 'SiteOne', cost_per_unit: '0.99', cost_unit: 'oz',
  monthly_cost_estimate: '410.00', needs_pricing: false, siteone_sku: 'SO-12345',
  best_vendor_pricing_id: 'vp-1', best_price_amount_cached: '123.45',
  best_price_vendor_id_cached: 'vendor-1', best_price_updated_at: '2026-09-01T00:00:00Z',
  best_price_status: 'fresh', auto_reorder_vendor_id: 'vendor-1', reorder_quantity: 2,
};

const OWNER_ONLY_COLUMNS = [
  'best_price', 'best_vendor', 'best_vendor_pricing_id', 'best_price_amount_cached',
  'best_price_vendor_id_cached', 'best_price_updated_at', 'best_price_status',
  'cost_per_unit', 'cost_unit', 'monthly_cost_estimate',
];

let lastCatalogSelect;
function query(table) {
  let where;
  const q = {};
  for (const method of ['orderBy', 'limit', 'offset', 'whereNull', 'whereNotNull', 'whereIn']) q[method] = jest.fn(() => q);
  q.select = jest.fn((...cols) => { if (table === 'products_catalog') lastCatalogSelect = cols; return q; });
  q.where = jest.fn((value) => { where = value; return q; });
  q.first = jest.fn(async () => {
    if (table === 'technicians') return staff[where?.id];
    return null;
  });
  q.then = (resolve, reject) => {
    const rows = table === 'products_catalog' ? [{ ...catalogRow }] : [];
    return Promise.resolve(rows).then(resolve, reject);
  };
  return q;
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  lastCatalogSelect = undefined;
  db.mockImplementation(query);
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => sql);
});

function request(route, role) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = `Bearer ${jwt.sign({
    technicianId: role, type: 'access', tokenVersion: 1,
  }, config.jwt.secret, { expiresIn: '5m' })}`;
  return fetch(baseUrl + route, { method: 'GET', headers });
}

test('technician GET /dispatch/products/catalog must NOT receive owner-only pricing/vendor/cost columns', async () => {
  const res = await request('/dispatch/products/catalog', 'technician');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.products).toHaveLength(1);
  const product = body.products[0];
  // agronomic fields the tech modals need are still there
  expect(product.name).toBe('Talak 7.9F');
  expect(product.active_ingredient).toBe('bifenthrin');
  // EXPECTED: technician projection (like admin-inventory stripOwnerPricing)
  const leaked = OWNER_ONLY_COLUMNS.filter((col) => product[col] !== undefined);
  expect(leaked).toEqual([]);
});

test('technician response must not carry vendor/reorder identifiers either', async () => {
  const res = await request('/dispatch/products/catalog', 'technician');
  const body = await res.json();
  const product = body.products[0];
  const leaked = ['siteone_sku', 'auto_reorder_vendor_id', 'reorder_quantity', 'needs_pricing']
    .filter((col) => product[col] !== undefined);
  expect(leaked).toEqual([]);
});

test('control: admin token still receives the pricing columns', async () => {
  const res = await request('/dispatch/products/catalog', 'admin');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.products[0].best_price).toBe('123.45');
  expect(body.products[0].best_vendor).toBe('SiteOne');
});

test('control: anonymous is rejected (401) — guard exists, just not role-scoped', async () => {
  const res = await request('/dispatch/products/catalog', null);
  expect(res.status).toBe(401);
});
