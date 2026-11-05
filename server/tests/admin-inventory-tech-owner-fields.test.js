// Technician visibility audit 2026-11-04 (A17 / C27): the product list gives a
// technician no pricing flag, vendor SKU, auto-reorder vendor or reorder
// quantity, and no price order or priced/needs-price subset. An admin still
// gets every field. Queries are built by real knex (pg dialect) with a fake
// runner that records the SQL and answers each table from the test.
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const state = { queries: [], answer: () => [] };
  knex.client.runner = (builder) => ({
    run: async () => {
      const { sql, bindings } = builder.toSQL();
      state.queries.push({ sql, bindings });
      const rows = await state.answer(sql, bindings);
      return builder._method === 'first' ? rows[0] : rows;
    },
  });
  const db = (table) => knex(table);
  db.raw = knex.raw.bind(knex);
  db.schema = { hasTable: async () => true };
  db.state = state;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireTechOrAdmin: jest.fn(), requireAdmin: jest.fn(),
}));

const db = require('../models/db');
const router = require('../routes/admin-inventory');

const productRow = {
  id: 'prod-1', name: 'Synthetic Herbicide', category: 'Herbicide', sku: 'SKU-100',
  needs_pricing: true, best_price: '12.50', best_vendor: 'Example Vendor',
  cost_per_unit: '0.5', cost_unit: 'oz', auto_reorder_vendor_id: 'vendor-1', reorder_quantity: 4,
  inventory_on_hand: 3, inventory_unit: 'gal', low_stock_threshold: 1, unit_size_oz: 128,
};

function handler(path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.get);
  return layer.route.stack[0].handle;
}

async function list(req = {}) {
  const res = { statusCode: 200, status: jest.fn(() => res), json: jest.fn((body) => { res.body = body; return res; }) };
  const next = jest.fn();
  await handler('/')({ query: {}, params: {}, techRole: 'admin', ...req }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res.body;
}

const listSql = () => db.state.queries.find((q) => q.sql.startsWith('select * from "products_catalog"') && q.sql.includes(' limit ')).sql;
const technician = { techRole: 'technician', technicianId: 'tech-1' };
const OWNER_FIELDS = ['needsPricing', 'sku', 'autoReorderVendorId', 'reorderQuantity',
  'bestPrice', 'bestVendor', 'costPerUnit', 'costUnit', 'monthlyCost'];

beforeEach(() => {
  db.state.queries = [];
  db.state.answer = (sql) => {
    if (sql.includes('group by "category"')) return [{ category: 'Herbicide', count: 1 }];
    if (sql.includes('avg_price')) return [{ total: 1, priced: 0, needs_price: 1, avg_price: 12.5 }];
    if (sql.includes('count(*) as "count"') && sql.includes('products_catalog')) return [{ count: 1 }];
    if (sql.includes('from "products_catalog"')) return [productRow];
    if (sql.includes('from "price_approvals"')) return [{ count: 0 }];
    return [];
  };
});

describe('GET / product list', () => {
  test('a technician gets no pricing flag, vendor SKU, auto-reorder vendor or reorder quantity', async () => {
    const body = await list(technician);
    expect(body.products).toHaveLength(1);
    for (const field of OWNER_FIELDS) expect(body.products[0]).not.toHaveProperty(field);
    // The stock and field columns stay.
    expect(body.products[0]).toMatchObject({ name: 'Synthetic Herbicide', inventoryOnHand: 3, unitSizeOz: 128 });
  });

  test('an admin still gets every one of those fields', async () => {
    const body = await list();
    expect(body.products[0]).toMatchObject({
      needsPricing: true, sku: 'SKU-100', autoReorderVendorId: 'vendor-1', reorderQuantity: 4, bestPrice: 12.5, bestVendor: 'Example Vendor',
    });
  });

  test('a technician\'s sort=price is ignored: the list stays in name order', async () => {
    await list({ ...technician, query: { sort: 'price' } });
    expect(listSql()).not.toContain('best_price');
    expect(listSql()).toContain('order by "name"');
  });

  test('an admin\'s sort=price still orders by best_price', async () => {
    await list({ query: { sort: 'price' } });
    expect(listSql()).toContain('order by "best_price"');
  });

  test.each(['true', 'false'])('a technician\'s needsPricing=%s filter is ignored (it would give the hidden flag back as a subset)', async (value) => {
    await list({ ...technician, query: { needsPricing: value } });
    expect(listSql()).not.toContain('needs_pricing');
  });

  test('an admin\'s needsPricing filter still applies', async () => {
    await list({ query: { needsPricing: 'true' } });
    expect(listSql()).toContain('"needs_pricing" = ?');
  });

  test('the list header counts carry no priced / needs-price split for a technician', async () => {
    const tech = await list(technician);
    expect(tech.stats).toMatchObject({ total: 1, priced: null, needsPrice: null, avgPrice: null });
    const admin = await list();
    expect(admin.stats).toMatchObject({ total: 1, priced: 0, needsPrice: 1 });
  });
});

describe('GET /stats', () => {
  test('a technician gets no priced / needs-price split; low stock stays', async () => {
    db.state.answer = (sql) => {
      if (sql.includes('total_products')) return [{ total_products: 3, priced: 1, needs_price: 2, low_stock: 1, avg_price: 10 }];
      if (sql.includes('from "vendors"')) return [{ total_vendors: 1, scraping_enabled: 0 }];
      if (sql.includes('from "product_restock_requests"')) return [{ count: 2 }];
      if (sql.includes('count(*)')) return [{ count: 0 }];
      return [];
    };
    const res = { json: jest.fn() };
    const next = jest.fn();
    await handler('/stats')({ query: {}, params: {}, techRole: 'technician' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].products).toEqual({ total: 3, priced: null, needsPrice: null, lowStock: 1, avgPrice: null });
  });
});
