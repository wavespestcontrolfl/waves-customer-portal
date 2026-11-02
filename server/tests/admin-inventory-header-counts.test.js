// Inventory header counts (metrics audit 2026-11-01): each card counts with the
// same rule as the list it opens, a count the server cannot read is null (never
// a zero), and the manual scrape trigger no longer records a job that never ran.
// Queries are built by real knex (pg dialect); a fake runner records the SQL and
// answers each table from the test.
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
const { listRestockRequests } = require('../services/inventory-restock-queue');

function handler(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[0].handle;
}

async function call(method, path, req = {}) {
  const res = { statusCode: 200 };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  const next = jest.fn();
  await handler(method, path)({ query: {}, params: {}, techRole: 'admin', ...req }, res, next);
  return { res, next };
}

const fromTable = (sql, table) => sql.includes(`from "${table}"`);
let failing;

beforeEach(() => {
  db.state.queries = [];
  failing = new Set();
  db.state.answer = (sql) => {
    for (const table of failing) if (fromTable(sql, table)) throw new Error(`synthetic ${table} read failure`);
    if (fromTable(sql, 'products_catalog') && sql.includes('total_products')) {
      return [{ total_products: 3, priced: 1, needs_price: 2, low_stock: 0, avg_price: 10 }];
    }
    if (fromTable(sql, 'vendors')) return [{ total_vendors: 2, scraping_enabled: 1 }];
    if (fromTable(sql, 'price_approvals')) return [{ pending: 4, approved: 1, rejected: 0 }];
    if (fromTable(sql, 'price_scrape_jobs')) return [{ total_jobs: 0, completed: 0, failed: 0 }];
    if (fromTable(sql, 'product_restock_requests')) return [{ count: 5 }];
    if (sql.includes('count(*)')) return [{ count: 0 }];
    return [];
  };
});

describe('GET /stats', () => {
  test('reports every count it read', async () => {
    const { res, next } = await call('get', '/stats');
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      products: { total: 3, priced: 1, needsPrice: 2, lowStock: 0 },
      approvals: { pending: 4, approved: 1, rejected: 0 },
      scrapeJobs: { total: 0, completed: 0, failed: 0 },
      restockRequests: { open: 5 },
    });
  });

  test.each([
    ['price_approvals', { approvals: null }],
    ['price_scrape_jobs', { scrapeJobs: null }],
    ['product_restock_requests', { restockRequests: { open: null } }],
  ])('a failed %s read is null (unknown), never a zero', async (table, expected) => {
    failing.add(table);
    const { res, next } = await call('get', '/stats');
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ products: { total: 3 }, ...expected });
  });

  test('a technician gets null restock when its read fails, too', async () => {
    failing.add('product_restock_requests');
    const { res } = await call('get', '/stats', { techRole: 'technician' });
    expect(res.body).toMatchObject({ approvals: null, scrapeJobs: null, restockRequests: { open: null } });
  });

  test('the Restock badge counts the active queue, including a received request whose order landed after the receipt', async () => {
    await call('get', '/stats');
    const badge = db.state.queries.find((q) => fromTable(q.sql, 'product_restock_requests'));
    expect(badge.sql).toContain('count(distinct "prr"."id")');
    expect(badge.sql).toContain('landedAfterReceive');

    db.state.queries = [];
    await listRestockRequests({ status: 'active' });
    const list = db.state.queries.find((q) => fromTable(q.sql, 'product_restock_requests'));
    const where = (sql, end) => sql.slice(sql.indexOf(' where '), sql.indexOf(end));
    expect(where(badge.sql, ' limit ')).toBe(where(list.sql, ' order by '));
  });
});

describe('GET / (product list)', () => {
  test('the Priced list uses the Priced card\'s rule: a product flagged for review is not listed even with an old price', async () => {
    const { next } = await call('get', '/', { query: { needsPricing: 'false', page: '1', limit: '50' } });
    expect(next).not.toHaveBeenCalled();
    const list = db.state.queries.find((q) => q.sql.startsWith('select * from "products_catalog"') && q.sql.includes(' limit '));
    expect(list.sql).toContain('where "needs_pricing" = ?');
    expect(list.bindings).toContain(false);
    expect(list.sql).not.toContain('best_price');
  });
});

describe('POST /scrape-jobs/:vendorId/trigger', () => {
  test('says no scraper is connected and writes nothing', async () => {
    db.state.answer = (sql) => (fromTable(sql, 'vendors') ? [{ id: 'v1', name: 'Synthetic Vendor' }] : []);
    const { res, next } = await call('post', '/scrape-jobs/:vendorId/trigger', { params: { vendorId: 'v1' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.body).toEqual({ scraped: false, message: 'Price scraping is not connected yet. Nothing was scraped for Synthetic Vendor, and no job was recorded.' });
    expect(db.state.queries.map((q) => q.sql).filter((sql) => /^(insert|update|delete)/i.test(sql))).toEqual([]);
  });

  test('an unknown vendor is still a 404', async () => {
    db.state.answer = () => [];
    const { res } = await call('post', '/scrape-jobs/:vendorId/trigger', { params: { vendorId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });
});
