// ADMIN-BUG-R64 (audit repro r1-inventory-time-5): technician token used to
// read per-product catalog cost ($/oz derived from products_catalog.best_price)
// via tank-mix endpoints. Fixed: a non-admin caller gets no per-product cost,
// and (owner ruling D3 A, 2026-11-04) no cost_per_tank / cost_per_1000sf
// either: the recipe and the rates stay, the chemical cost does not.
// POST /tank-mixes (create) + PUT /tank-mixes/:id (update) are requireAdmin
// outright since no client ever calls them.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'equipment-authorization-test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const equipmentRouter = require('../routes/admin-equipment');

const staff = Object.fromEntries(['admin', 'technician'].map(role => [role, {
  id: role, role, employment_status: 'active', auth_token_version: 1,
}]));
const catalogRow = { id: 'prod-1', name: 'Synthetic Bifenthrin', best_price: '80.00', unit_size_oz: '96' };
const mixRow = {
  id: 'mix-1', name: 'Synthetic mix', service_type: 'general', tank_size_gal: 100, coverage_sqft: 10000,
  products: JSON.stringify([{ product_id: 'prod-1', name: 'Synthetic Bifenthrin', oz_per_tank: 8, cost_per_oz: 0.8333, cost_in_tank: 6.67 }]),
  cost_per_tank: 6.67, cost_per_1000sf: 0.667, active: true,
};

let lastUpdate;
function query(table) {
  let where;
  const q = {};
  for (const method of ['select', 'orderBy', 'limit', 'offset']) q[method] = jest.fn(() => q);
  q.where = jest.fn((value) => { where = value; return q; });
  q.update = jest.fn((value) => { lastUpdate = value; return q; });
  q.returning = jest.fn(async () => [{ ...mixRow, ...lastUpdate }]);
  q.first = jest.fn(async () => {
    if (table === 'technicians') return staff[where?.id];
    if (table === 'products_catalog') return catalogRow;
    if (table === 'tank_mixes') return mixRow;
    return null;
  });
  q.then = (resolve, reject) => Promise.resolve([mixRow]).then(resolve, reject);
  return q;
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/equipment', equipmentRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(query);
  db.fn = { now: jest.fn(() => 'NOW()') };
});

function request(method, route, role) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = `Bearer ${jwt.sign({
    technicianId: role, type: 'access', tokenVersion: 1,
  }, config.jwt.secret, { expiresIn: '5m' })}`;
  return fetch(baseUrl + route, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
}

test('technician GET /tank-mixes keeps the recipe and the rates but loses every chemical cost', async () => {
  const res = await request('GET', '/equipment/tank-mixes', 'technician');
  expect(res.status).toBe(200);
  const body = await res.json();
  const mix = body.tank_mixes[0];
  const products = JSON.parse(mix.products);
  // Owner-only: the totals are the per-ounce cost summed (D3 A).
  expect(mix).not.toHaveProperty('cost_per_tank');
  expect(mix).not.toHaveProperty('cost_per_1000sf');
  expect(body.mixes[0]).not.toHaveProperty('cost_per_tank');
  // Owner-only: best_price-derived per-ounce cost is stripped.
  expect(products[0].cost_per_oz).toBeUndefined();
  expect(products[0].cost_in_tank).toBeUndefined();
  // The recipe stays.
  expect(mix.name).toBe('Synthetic mix');
  expect(mix.tank_size_gal).toBe(100);
  expect(products[0].oz_per_tank).toBe(8);
});

test('control: admin GET /tank-mixes still receives cost_per_oz', async () => {
  const res = await request('GET', '/equipment/tank-mixes', 'admin');
  expect(res.status).toBe(200);
  const body = await res.json();
  const products = JSON.parse(body.tank_mixes[0].products);
  expect(products[0].cost_per_oz).toBe(0.8333);
  expect(body.tank_mixes[0].cost_per_tank).toBe(6.67);
  expect(body.tank_mixes[0].cost_per_1000sf).toBe(0.667);
});

test('technician POST /tank-mixes/:id/recalculate still writes the row but the response strips every cost', async () => {
  const res = await request('POST', '/equipment/tank-mixes/mix-1/recalculate', 'technician');
  expect(res.status).toBe(200);
  const body = await res.json();
  const products = JSON.parse(body.tank_mix.products);
  expect(products[0].cost_per_oz).toBeUndefined();
  expect(body.tank_mix).not.toHaveProperty('cost_per_tank');
  expect(lastUpdate).toBeDefined(); // recalculate is still technician-reachable and writes
});

test('technician POST /tank-mixes (create) is now admin-only', async () => {
  const res = await request('POST', '/equipment/tank-mixes', 'technician');
  expect(res.status).toBe(403);
});

test('technician PUT /tank-mixes/:id (update) is now admin-only', async () => {
  const res = await request('PUT', '/equipment/tank-mixes/mix-1', 'technician');
  expect(res.status).toBe(403);
});

test('anonymous is rejected (guard exists, just not role-scoped)', async () => {
  const res = await request('GET', '/equipment/tank-mixes', null);
  expect(res.status).toBe(401);
});
