/**
 * admin-inventory costing fixes:
 *  - restock receive is guarded by status (second receive → 409, stock added once)
 *  - recalcBestPrice picks the cheapest vendor PER OZ and persists best_price
 *    scaled to the product's own unit_size_oz
 *  - bulk approve mirrors the single-approve field set (quantity, source url)
 *    and reports failed ids instead of swallowing them
 *  - PUT /:productId/pricing validates vendorId/price up front
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
  adminAuthenticate: (req, _res, next) => {
    req.adminUser = { id: 'admin-1', name: 'Owner' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const inventoryRouter = require('../routes/admin-inventory');

const { recalcBestPrice } = inventoryRouter._test;

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Chainable thenable query mock: resolve() decides the awaited value based on
// the calls recorded so far.
function makeChain(table, resolve) {
  const q = { _table: table, _calls: [] };
  [
    'where', 'whereIn', 'whereNull', 'whereNotNull', 'select', 'orderBy',
    'join', 'leftJoin', 'limit', 'offset', 'forUpdate', 'returning', 'groupBy',
  ].forEach((m) => {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  });
  q.update = jest.fn((...args) => { q._calls.push(['update', args]); return q; });
  q.insert = jest.fn((...args) => { q._calls.push(['insert', args]); return q; });
  q.first = jest.fn(async () => {
    q._calls.push(['first', []]);
    return resolve(q);
  });
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(q)).then(onOk, onErr);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.schema.hasTable.mockResolvedValue(true);
  db.fn = { now: jest.fn(() => 'NOW()') };
});

// ---------------------------------------------------------------------------
// Restock receive guard
// ---------------------------------------------------------------------------

describe('POST /restock-requests/:id/action', () => {
  function wireRestock(requestRow) {
    const movements = [];
    const stockUpdates = [];
    const statusUpdates = [];
    const route = (q) => {
      if (q._table === 'product_restock_requests') {
        if (q.called('update')) {
          statusUpdates.push(q.args('update')[0]);
          return [{ ...requestRow, ...q.args('update')[0] }];
        }
        return requestRow;
      }
      if (q._table === 'products_catalog') {
        if (q.called('update')) {
          stockUpdates.push(q.args('update')[0]);
          return 1;
        }
        return { id: 'prod-1', inventory_on_hand: 10, inventory_unit: 'gal' };
      }
      if (q._table === 'product_inventory_movements') {
        movements.push(q.args('insert')[0]);
        return [{ id: 'movement-1', ...q.args('insert')[0] }];
      }
      throw new Error(`Unexpected table ${q._table}`);
    };
    const trx = (table) => makeChain(table, route);
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    db.mockImplementation((table) => makeChain(table, route));
    return { movements, stockUpdates, statusUpdates };
  }

  test('receives an open request once: stock updated, movement written, status received', async () => {
    const { movements, stockUpdates, statusUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'open', requested_quantity: 2, unit: 'gal',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'receive' }),
      });
      expect(res.status).toBe(200);
      expect(stockUpdates).toHaveLength(1);
      expect(stockUpdates[0].inventory_on_hand).toBe(12);
      expect(movements).toHaveLength(1);
      expect(statusUpdates.some((u) => u.status === 'received')).toBe(true);
    });
  });

  test('second receive of an already-received request → 409, no stock added', async () => {
    const { movements, stockUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'received', requested_quantity: 2, unit: 'gal',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'receive' }),
      });
      expect(res.status).toBe(409);
      expect(stockUpdates).toHaveLength(0);
      expect(movements).toHaveLength(0);
    });
  });

  test.each(['cancel', 'mark_ordered'])('%s on a received request → 409 (cannot reopen)', async (action) => {
    const { statusUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'received', requested_quantity: 2, unit: 'gal',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(409);
      expect(statusUpdates).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// recalcBestPrice — cheapest per-oz wins, persisted for the product's own size
// ---------------------------------------------------------------------------

describe('recalcBestPrice', () => {
  function wireBestPrice({ rows, product }) {
    const catalogUpdates = [];
    const pricingUpdates = [];
    db.mockImplementation((table) => makeChain(table, (q) => {
      if (table === 'vendor_pricing') {
        if (q.called('update')) {
          pricingUpdates.push({ where: q.args('where'), update: q.args('update')[0] });
          return 1;
        }
        return rows;
      }
      if (table === 'products_catalog') {
        if (q.called('update')) {
          catalogUpdates.push(q.args('update')[0]);
          return 1;
        }
        return product;
      }
      throw new Error(`Unexpected table ${table}`);
    }));
    return { catalogUpdates, pricingUpdates };
  }

  test('picks the cheaper PER-OZ vendor over the cheaper sticker price', async () => {
    // Vendor A: $100 for a 128 oz container → $0.78/oz.
    // Vendor B: $40 for a 32 oz container → $1.25/oz. Raw ordering would pick B.
    const { catalogUpdates, pricingUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 100, quantity: '128 oz', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 40, quantity: '32 oz', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates).toHaveLength(1);
    // best_price is scaled to the product's own 64 oz container: 100/128 * 64 = 50
    expect(catalogUpdates[0].best_price).toBe(50);
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A');
    // Backing/cache fields move atomically with the winner (pricing-engine
    // db-bridge only trusts best_price when best_vendor_pricing_id matches).
    expect(catalogUpdates[0].best_vendor_pricing_id).toBe('vp-a');
    expect(catalogUpdates[0].best_price_amount_cached).toBe(50);
    expect(catalogUpdates[0].best_price_vendor_id_cached).toBe('v-a');
    expect(catalogUpdates[0].best_price_status).toBe('current');
    const flagged = pricingUpdates.find((u) => u.update.is_best_price === true);
    expect(flagged.where).toEqual([{ id: 'vp-a' }]);
  });

  test('uses stored normalized_unit_price when the quantity is unparseable', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 90, quantity: null, normalized_unit_price: 0.5, price_per_oz: 0.5, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 10, quantity: null, normalized_unit_price: 0.9, price_per_oz: 0.9, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 100 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A');
    expect(catalogUpdates[0].best_price).toBe(50); // 0.5/oz * 100 oz
  });

  test('rederives per-oz from current price+quantity over a stale stored value', async () => {
    // vp-a was approved from $100/128oz down to $40/32oz but the legacy
    // approval write left normalized_unit_price at the old 0.78125/oz.
    // The current price/quantity say $1.25/oz, so vp-b ($1.00/oz) must win.
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 40, quantity: '32 oz', normalized_unit_price: 0.78125, price_per_oz: 0.78125, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 64, quantity: '64 oz', normalized_unit_price: 1, price_per_oz: 1, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor B');
    expect(catalogUpdates[0].best_price).toBe(64); // 1.00/oz * 64 oz
  });

  test('only considers active, approved, unexpired vendor rows', async () => {
    const filterCalls = [];
    db.mockImplementation((table) => makeChain(table, (q) => {
      if (table === 'vendor_pricing') {
        if (q.called('update')) return 1;
        filterCalls.push(q._calls.filter(([m]) => ['where', 'whereIn', 'whereNull'].includes(m)));
        return [];
      }
      throw new Error(`Unexpected table ${table}`);
    }));
    await recalcBestPrice('prod-1');
    const calls = filterCalls[0];
    expect(calls).toContainEqual(['where', ['vendor_pricing.is_active', true]]);
    expect(calls).toContainEqual(['whereIn', ['vendor_pricing.approval_status', ['approved', 'auto_approved']]]);
    expect(calls.some(([m, args]) => m === 'where' && typeof args[0] === 'function')).toBe(true); // unexpired guard
  });

  test('falls back to raw price only when no row has size info', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', price: 90, quantity: null, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-b', price: 40, quantity: 'each', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_price).toBe(40);
    expect(catalogUpdates[0].best_vendor).toBe('Vendor B');
  });
});

// ---------------------------------------------------------------------------
// Bulk approve parity + failed[]
// ---------------------------------------------------------------------------

describe('POST /approvals/bulk', () => {
  test('approve sets quantity/source url like single approve and reports failed ids', async () => {
    const approvals = {
      'ap-1': { id: 'ap-1', product_id: 'prod-1', vendor_id: 'v-1', new_price: 25, new_quantity: '32 oz', source_url: 'https://vendor.example/p1', status: 'pending' },
      'ap-2': { id: 'ap-2', product_id: 'prod-2', vendor_id: 'v-2', new_price: 30, new_quantity: '1 gal', source_url: 'https://vendor.example/p2', status: 'pending' },
    };
    const pricingInserts = [];
    db.mockImplementation((table) => makeChain(table, (q) => {
      if (table === 'price_approvals') {
        if (q.called('update')) return 1;
        const id = q.args('where')[0]?.id;
        return approvals[id] || null;
      }
      if (table === 'vendor_pricing') {
        if (q.called('insert')) {
          const row = q.args('insert')[0];
          if (row.product_id === 'prod-2') throw new Error('insert failed');
          pricingInserts.push(row);
          return 1;
        }
        if (q.called('update')) return 1;
        if (q.called('join')) return [];
        return null; // no existing vendor_pricing row
      }
      if (table === 'price_history') return 1;
      if (table === 'products_catalog') return { unit_size_oz: 64 };
      throw new Error(`Unexpected table ${table}`);
    }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/approvals/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['ap-1', 'ap-2', 'ap-gone'], action: 'approve' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(pricingInserts).toHaveLength(1);
      expect(pricingInserts[0]).toEqual(expect.objectContaining({
        product_id: 'prod-1',
        vendor_id: 'v-1',
        price: 25,
        quantity: '32 oz',
        vendor_product_url: 'https://vendor.example/p1',
        // per-oz unit costs refreshed in the same write as the new price
        price_per_oz: 0.7813,
        normalized_unit_price: 0.7813,
        unit_normalized: 'oz',
        // approving must make the row eligible for best-price selection
        approval_status: 'approved',
        is_active: true,
      }));
      expect(body.processed).toBe(1);
      expect(body.failed).toEqual(['ap-2']);
      expect(body.skipped).toEqual(['ap-gone']);
      expect(body.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /:productId/pricing input validation
// ---------------------------------------------------------------------------

describe('PUT /:productId/pricing validation', () => {
  test.each([
    [{ price: 10 }, 'missing vendorId'],
    [{ vendorId: 'not-a-uuid', price: 10 }, 'non-uuid vendorId'],
    [{ vendorId: '3f7b4a52-9c1d-4e8f-a6b0-1c2d3e4f5a6b' }, 'missing price'],
    [{ vendorId: '3f7b4a52-9c1d-4e8f-a6b0-1c2d3e4f5a6b', price: 0 }, 'zero price'],
    [{ vendorId: '3f7b4a52-9c1d-4e8f-a6b0-1c2d3e4f5a6b', price: -4 }, 'negative price'],
  ])('%o → 400 (%s)', async (payload) => {
    db.mockImplementation(() => { throw new Error('db should not be touched on invalid input'); });
    db.transaction.mockImplementation(() => { throw new Error('no transaction on invalid input'); });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/prod-1/pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    });
  });
});
