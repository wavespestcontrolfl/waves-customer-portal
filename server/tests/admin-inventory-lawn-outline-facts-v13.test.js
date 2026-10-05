/**
 * GET /lawn-outline-facts lists the products the running lawn program references.
 * Gate off: the legacy definition list, unchanged. GATE_LAWN_V13 on: the v13
 * program's own products (every name in the recipe), each looked up by its exact
 * catalog name, and none of the legacy aliases that would match another v13
 * product by substring (Dylox 420 SL vs Dylox 6.2 G).
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
const v13 = require('../config/lawn-protocol-v13.json');

// A catalog whose rows are named exactly as the recipe names them, plus the
// legacy Dylox 420 SL the legacy alias 'Dylox' would hit first.
const RECIPE_NAMES = (() => {
  const names = new Set();
  for (const visit of v13.st_augustine.visits) {
    // A cadence variant's step (April on the 9x plan) names products the program uses too.
    const steps = [visit.primary, visit.secondary, ...Object.values(visit.cadenceVariants || {}).map((variant) => variant.primary)];
    for (const line of steps.join('\n').split('\n')) if (line.includes(' — ')) names.add(line.split(' — ')[0]);
  }
  return [...names].sort();
})();
const CATALOG = [...RECIPE_NAMES, 'Dylox 420 SL T&O Insecticide'].map((name, i) => ({ id: `p${i}`, name, category: 'insecticide' }));

function wireCatalog() {
  db.mockImplementation((table) => {
    if (table !== 'products_catalog') throw new Error(`Unexpected table ${table}`);
    const q = {};
    let needle = '';
    q.whereILike = jest.fn((_col, pattern) => { needle = pattern.slice(1, -1).toLowerCase(); return q; });
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => CATALOG.find((row) => row.name.toLowerCase().includes(needle)) || null);
    return q;
  });
}

async function getFacts() {
  const app = express();
  app.use('/admin/inventory', inventoryRouter);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/inventory/lawn-outline-facts`);
    expect(res.status).toBe(200);
    return await res.json();
  } finally { await new Promise((r) => server.close(r)); }
}

afterEach(() => { delete process.env.GATE_LAWN_V13; });
beforeEach(() => { jest.clearAllMocks(); wireCatalog(); });

test('gate on: readiness has a row for every product the v13 recipe names, matched to its own catalog row', async () => {
  process.env.GATE_LAWN_V13 = 'true';
  const body = await getFacts();
  const byLabel = Object.fromEntries(body.facts.map((row) => [row.needle, row]));
  expect(Object.keys(byLabel).sort()).toEqual(RECIPE_NAMES);
  for (const name of RECIPE_NAMES) {
    expect(byLabel[name].product?.name).toBe(name);
    expect(byLabel[name].referenceCount).toBeGreaterThan(0);
  }
  for (const name of ['Tetrino Insecticide', 'LESCO Nutra-TECH T&O Micronutrient Package', 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', 'Artavia 2 SC (Azoxy)', 'Velista']) {
    expect(byLabel[name]).toBeDefined();
  }
  // Dylox 6.2 G is its own row, never the legacy Dylox 420 SL.
  expect(byLabel['Dylox 6.2 G Granular Insecticide'].product.name).toBe('Dylox 6.2 G Granular Insecticide');
  expect(body.facts.some((row) => /420/.test(row.product?.name || ''))).toBe(false);
  expect(body.summary.total).toBe(RECIPE_NAMES.length);
});

test('gate off: the legacy list, with no v13-only product', async () => {
  const body = await getFacts();
  const labels = body.facts.map((row) => row.needle);
  expect(labels).not.toContain('Tetrino Insecticide');
  expect(labels).not.toContain('LESCO Nutra-TECH T&O Micronutrient Package');
  expect(body.facts.every((row) => !row.key.startsWith('v13_'))).toBe(true);
});

test('gate on: the 9x April product (Dimension 18-0-10, named only in the April cadence variant) is attributed to April', async () => {
  process.env.GATE_LAWN_V13 = 'true';
  const body = await getFacts();
  const dimension = body.facts.find((row) => row.needle === 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer');
  expect(dimension.referenceCount).toBeGreaterThan(0);
  expect(dimension.product?.name).toBe(dimension.needle);
});
