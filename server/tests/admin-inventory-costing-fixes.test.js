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
  requireAdmin: (_req, _res, next) => next(),
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
    'where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy',
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
    const orderUpdates = [];
    const bellRetires = [];
    const route = (q) => {
      if (q._table === 'notifications') { bellRetires.push(q.args('update')[0]); return 1; } // settleRequestLedgerBells
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
      if (q._table === 'vendor_orders') {
        if (q.called('update')) { orderUpdates.push(q.args('update')[0]); return 1; } // settleLandedAfterReceive
        return requestRow.ledger || null; // assertManualActionAllowed's one read
      }
      if (q._table === 'product_inventory_movements') {
        movements.push(q.args('insert')[0]);
        return [{ id: 'movement-1', ...q.args('insert')[0] }];
      }
      throw new Error(`Unexpected table ${q._table}`);
    };
    const trx = (table) => makeChain(table, route);
    trx.fn = { now: jest.fn(() => 'NOW()') };
    trx.raw = jest.fn((sql) => sql); // settleLandedAfterReceive's evidence patch
    db.transaction.mockImplementation(async (fn) => fn(trx));
    db.mockImplementation((table) => makeChain(table, route));
    return { movements, stockUpdates, statusUpdates, orderUpdates, bellRetires };
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

  test('ONE more receive on a received request whose automatic order landed after that receipt: stock added, marker settled (Codex r27 P1)', async () => {
    const { movements, stockUpdates, statusUpdates, orderUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'received', requested_quantity: 2, unit: 'gal',
      ledger: { id: 'vo-9', status: 'needs_review', placed_at: new Date(), external_order_number: 'S1-9', evidence: { landedAfterReceive: '2026-09-05T01:00:00Z' } },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive' }),
      });
      expect(res.status).toBe(200);
      expect(stockUpdates).toHaveLength(1);
      expect(stockUpdates[0].inventory_on_hand).toBe(12);
      expect(movements).toHaveLength(1);
      expect(movements[0].metadata.secondReceive).toBe(true);
      expect(statusUpdates.some((u) => u.status === 'received')).toBe(true);
      expect(orderUpdates.some((u) => String(u.evidence).includes("- 'landedAfterReceive'"))).toBe(true); // the marker comes off in the same transaction
    });
  });

  test.each(['cancel', 'mark_ordered'])('%s on a received request whose automatic order landed after the receipt → 409 (only the receive is admitted)', async (action) => {
    const { statusUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'received', requested_quantity: 2, unit: 'gal',
      ledger: { id: 'vo-9', status: 'needs_review', placed_at: new Date(), external_order_number: 'S1-9', evidence: { landedAfterReceive: '2026-09-05T01:00:00Z' } },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(409);
      expect(statusUpdates).toHaveLength(0);
    });
  });

  test.each(['cancel', 'mark_ordered', 'receive'])('%s while the automatic order is placing → 409, request untouched (pre-push P0)', async (action) => {
    const { statusUpdates, stockUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'open', requested_quantity: 2, unit: 'gal', ledger: { id: 'vo-1', status: 'placing', placed_at: null, evidence: {} },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/being placed right now/);
      expect(statusUpdates).toHaveLength(0);
      expect(stockUpdates).toHaveLength(0);
    });
  });

  test('receive defaults to what the automatic order actually bought (packages round up), not the requested figure (r2 P1)', async () => {
    const { stockUpdates, movements } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'ordered', requested_quantity: 2, unit: 'gal',
      ledger: { id: 'vo-7', status: 'placed', placed_at: new Date(), evidence: {}, request_payload: JSON.stringify({ quantity: 2, unit: 'gal', vendorQuantity: 2, packSize: '2.5 gal', orderedQuantity: 5 }) },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive' }),
      });
      expect(res.status).toBe(200);
      expect(stockUpdates[0].inventory_on_hand).toBe(15); // 10 on hand + 5 gal (two 2.5 gal jugs), not + 2
      expect(movements).toHaveLength(1);
    });
  });

  test('cancel while a dispatched automatic order is unreceived and unrevoked → 409 naming the revoke script (pre-push P0)', async () => {
    const { statusUpdates } = wireRestock({
      id: 'req-1', product_id: 'prod-1', status: 'open', requested_quantity: 2, unit: 'gal',
      ledger: { id: 'vo-7', status: 'needs_review', placed_at: new Date(), external_order_number: null, evidence: {} },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/may already have gone out.*auto-order-revoke\.js --order=vo-7/);
      expect(statusUpdates).toHaveLength(0);
    });
  });

  test.each([
    ['cancel', { id: 'vo-7', status: 'needs_review', placed_at: new Date(), evidence: { revokedAt: '2026-09-03T10:00:00Z' } }, 'cancelled'],
    ['mark_ordered', { id: 'vo-7', status: 'needs_review', placed_at: new Date(), evidence: {} }, 'ordered'],
  ])('%s proceeds once the order is revoked / when it only confirms the order — and retires the ledger bell it resolves (Codex r28 P2)', async (action, ledger, expected) => {
    const { statusUpdates, bellRetires } = wireRestock({ id: 'req-1', product_id: 'prod-1', status: 'open', requested_quantity: 2, unit: 'gal', ledger });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/inventory/restock-requests/req-1/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(200);
      expect(statusUpdates.some((u) => u.status === expected)).toBe(true);
      expect(bellRetires).toHaveLength(1); // the parked row's "order manually" bell must not outlive the action
      expect(bellRetires[0].read_at).toBeInstanceOf(Date);
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
    // recalcBestPrice serializes via a product-scoped advisory xact lock —
    // callers without a transaction open one, so the mock trx proxies the
    // table builder and stubs raw() (the lock).
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({}));
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction.mockImplementation(async (fn) => fn(trx));
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
    // Cache = the winning row's RAW amount (control-layer contract), while
    // best_price stays scaled to the catalog container.
    expect(catalogUpdates[0].best_price_amount_cached).toBe(100);
    expect(catalogUpdates[0].best_price_vendor_id_cached).toBe('v-a');
    expect(catalogUpdates[0].best_price_status).toBe('current');
    const flagged = pricingUpdates.find((u) => u.update.is_best_price === true);
    expect(flagged.where).toEqual([{ id: 'vp-a' }]);
  });

  test('COUNT-BASED product: the cheapest PER-UNIT row wins, best_price scales to the catalog count and cost_per_unit follows — current, never the r19 stale guard', async () => {
    // Summit dunks: catalog "20 count", seeded cost_per_unit 1.344/tablet; Amazon $26.88/20, SiteOne $20.07/20.
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-amz', vendor_id: 'v-amz', price: 26.88, quantity: '20 count', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Amazon' },
        { id: 'vp-s1', vendor_id: 'v-s1', price: 20.07, quantity: '20 count', normalized_unit_price: null, price_per_oz: null, vendor_name: 'SiteOne' },
      ],
      product: { unit_size_oz: null, best_price: 26.88, container_size: '20 count', cost_unit: 'tablet' },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates).toHaveLength(1);
    expect(catalogUpdates[0].best_price).toBe(20.07);
    expect(catalogUpdates[0].best_vendor).toBe('SiteOne');
    expect(catalogUpdates[0].best_price_status).toBe('current');
    expect(catalogUpdates[0].needs_pricing).toBe(false);
    // COGS moves with the winner (r1 P1): 20.07 / 20 per tablet, unit kept.
    expect(catalogUpdates[0].cost_per_unit).toBe(1.0035);
    expect(catalogUpdates[0].cost_unit).toBe('tablet');
  });

  test('COUNT-BASED product: a pack of 10 scales to the catalog\'s single unit — $86.94/10 stations → $8.69/station, cost_unit from the catalog noun', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [{ id: 'vp-ves', vendor_id: 'v-ves', price: 86.94, quantity: '10 stations', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Veseris' }],
      product: { unit_size_oz: null, best_price: 8.69, container_size: '1 station', cost_unit: null },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_price).toBe(8.69);
    expect(catalogUpdates[0].best_price_amount_cached).toBe(86.94);
    expect(catalogUpdates[0].best_price_status).toBe('current');
    expect(catalogUpdates[0].cost_per_unit).toBe(8.694);
    expect(catalogUpdates[0].cost_unit).toBe('station');
  });

  test('COUNT-BASED product: rows rank by LANDED per-unit — a $10/10 pack with $20 shipping does not beat a delivered $20/10 pack; the sticker per-unit is what persists', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-cheap', vendor_id: 'v-cheap', price: 10, quantity: '10 stations', landed_cost: 30, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Cheap Sticker' },
        { id: 'vp-deliv', vendor_id: 'v-deliv', price: 20, quantity: '10 stations', landed_cost: 20, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Delivered' },
      ],
      product: { unit_size_oz: null, best_price: null, container_size: '1 station', cost_unit: null },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Delivered');
    expect(catalogUpdates[0].best_price).toBe(2);
  });

  test('COUNT-BASED product whose catalog noun is a container ("1 case") never scales against a generic count ("12 count") — the r19 stale guard stays', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [{ id: 'vp-s1', vendor_id: 'v-s1', price: 31.16, quantity: '12 count', normalized_unit_price: null, price_per_oz: null, vendor_name: 'SiteOne' }],
      product: { unit_size_oz: null, best_price: 31.16, container_size: '1 case', cost_unit: null },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_price_status).toBe('stale');
    expect(catalogUpdates[0].needs_pricing).toBe(true);
    expect(catalogUpdates[0].cost_per_unit).toBeUndefined();
  });

  test('a measured row still takes precedence over count-based rows', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 100, quantity: '128 oz', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-c', vendor_id: 'v-c', price: 1, quantity: '20 count', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor C' },
      ],
      product: { unit_size_oz: 64, best_price: null, container_size: '20 count' },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A');
    expect(catalogUpdates[0].best_price).toBe(50);
    expect(catalogUpdates[0].cost_per_unit).toBeUndefined();
  });

  test('scoreVendorRows is the shared basis the Intelligence Bar reads: count mode ranks compatible rows per unit and puts incompatible rows last with a null rank', () => {
    const { scoreVendorRows } = inventoryRouter;
    const rows = [
      { id: 'a', price: 26.88, quantity: '20 count', vendor_name: 'Amazon' },
      { id: 'b', price: 20.07, quantity: '20 count', vendor_name: 'SiteOne' },
      { id: 'c', price: 5, quantity: '1 case', vendor_name: 'Case Seller' },
    ];
    const out = scoreVendorRows(rows, { unit_size_oz: null, container_size: '20 count' });
    expect(out.mode).toBe('count');
    expect(out.ranked.map((r) => r.row.id)).toEqual(['b', 'a', 'c']);
    expect(out.ranked[0].rank).toBeCloseTo(20.07 / 20, 6);
    expect(out.ranked[2].rank).toBeNull();
    const oz = scoreVendorRows([{ id: 'x', price: 100, quantity: '128 oz' }, { id: 'y', price: 40, quantity: '32 oz' }], { unit_size_oz: 64 });
    expect(oz.mode).toBe('oz');
    expect(oz.ranked[0].row.id).toBe('x');
  });

  test('PUT /:id with a new containerSize recalculates the best price — "1 case" → "12 count" turns a stale count product current (r1 P2)', async () => {
    const product = { id: 'prod-1', container_size: '1 case', unit_size_oz: null, best_price: 31.16, cost_unit: null, inventory_on_hand: null, inventory_unit: null, low_stock_threshold: null };
    const rows = [{ id: 'vp-s1', vendor_id: 'v-s1', price: 31.16, quantity: '12 count', normalized_unit_price: null, price_per_oz: null, vendor_name: 'SiteOne' }];
    const catalogUpdates = [];
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({}));
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    db.mockImplementation((table) => makeChain(table, (q) => {
      if (table === 'vendor_pricing') return q.called('update') ? 1 : rows;
      if (table === 'products_catalog') {
        if (q.called('update')) { const u = q.args('update')[0]; catalogUpdates.push(u); Object.assign(product, u); return 1; }
        return { ...product }; // a fresh read each time, like a real row — the route's pre-update snapshot must not mutate
      }
      throw new Error(`Unexpected table ${table}`);
    }));
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/admin/inventory/prod-1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ containerSize: '12 count' }) });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.product.container_size).toBe('12 count');
    });
    const best = catalogUpdates.find((u) => u.best_price_status);
    expect(best).toBeDefined();
    expect(best.best_price_status).toBe('current');
    expect(best.best_price).toBe(31.16);
    expect(best.cost_per_unit).toBe(2.5967);
  });

  test('parsePackCount reads count packs with their noun; countUnitsCompatible refuses container-vs-item scaling', () => {
    const { parsePackCount, countUnitsCompatible } = require('../services/product-costing');
    expect(parsePackCount('20 count')).toEqual({ count: 20, unit: 'each' });
    expect(parsePackCount('10 stations')).toEqual({ count: 10, unit: 'station' });
    expect(parsePackCount('1 trap')).toEqual({ count: 1, unit: 'trap' });
    expect(parsePackCount('12 ct')).toEqual({ count: 12, unit: 'each' });
    expect(parsePackCount('25')).toEqual({ count: 25, unit: 'each' });
    expect(parsePackCount('100 case')).toEqual({ count: 100, unit: 'case' });
    expect(parsePackCount('2.5 gal')).toBeNull();
    expect(parsePackCount('78 fl oz')).toBeNull();
    expect(parsePackCount('4 x 30g tubes')).toBeNull();
    expect(parsePackCount('one case')).toBeNull();
    expect(parsePackCount('')).toBeNull();
    expect(countUnitsCompatible('each', 'station')).toBe(true);
    expect(countUnitsCompatible('station', 'station')).toBe(true);
    expect(countUnitsCompatible('case', 'case')).toBe(true);
    expect(countUnitsCompatible('case', 'each')).toBe(false);
    expect(countUnitsCompatible('each', 'pack')).toBe(false);
    expect(countUnitsCompatible('station', 'trap')).toBe(false);
  });

  test('ranks by LANDED per-oz when present — cheap sticker + heavy shipping must not win', async () => {
    // Vendor A: $50/64 oz sticker ($0.78/oz) but $30 shipping → landed $1.25/oz.
    // Vendor B: $60/64 oz delivered → landed $0.9375/oz. B wins the ordering;
    // persistence keeps the sticker-per-oz canonical-container contract.
    const { catalogUpdates, pricingUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 50, quantity: '64 oz', landed_unit_price: 1.25, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 60, quantity: '64 oz', landed_unit_price: 0.9375, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor B');
    // Persisted from the winner's STICKER per-oz, scaled to the product size.
    expect(catalogUpdates[0].best_price).toBe(60);
    const flagged = pricingUpdates.find((u) => u.update.is_best_price === true);
    expect(flagged.where).toEqual([{ id: 'vp-b' }]);
  });

  test('a landed-only row (no quantity, no normalized price) never enters the sized pool', async () => {
    // The report contract allows landed_unit_price without size info — such a
    // row has nothing to scale to the catalog container, so it must not win
    // the sized pool and persist its raw pack price as best_price.
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 100, quantity: '128 oz', landed_unit_price: null, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 30, quantity: null, landed_unit_price: 0.10, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Landed Only' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A');
    expect(catalogUpdates[0].best_price).toBe(50); // 100/128 * 64 — scaled, never vp-b's raw 30
  });

  test('a non-positive landed_unit_price never poisons the ordering — falls back to sticker per-oz', async () => {
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 100, quantity: '128 oz', landed_unit_price: 0, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' },
        { id: 'vp-b', vendor_id: 'v-b', price: 40, quantity: '32 oz', landed_unit_price: null, normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor B' },
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A'); // 0.78/oz beats 1.25/oz
    expect(catalogUpdates[0].best_price).toBe(50);
  });

  test("a 'lb'-normalized stored cost converts to per-oz — never treated as $/oz", async () => {
    // LESCO-style row: $0.6758/lb with unit_normalized='lb' → $0.0422/oz.
    // Treated as $/oz it would beat (and grossly misprice) everything.
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 0, price_amount: 33.79, quantity: null, unit_normalized: 'lb', normalized_unit_price: 0.6758, price_per_oz: null, landed_unit_price: null, vendor_name: 'LESCO' },
      ],
      product: { unit_size_oz: 800 },
    });
    await recalcBestPrice('prod-1');
    // 0.6758/16 = 0.04224/oz × 800 oz = 33.79 — not 540.64.
    expect(catalogUpdates[0].best_price).toBe(33.79);
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

  test('parses multipack quantities instead of dropping the vendor from per-oz scoring', async () => {
    // "4 x 32 oz" is a supported pack form (parsePackSize) that the simple
    // normalizer cannot read; the row must still be scored per-oz.
    const { catalogUpdates } = wireBestPrice({
      rows: [
        { id: 'vp-a', vendor_id: 'v-a', price: 64, quantity: '4 x 32 oz', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor A' }, // $0.50/oz
        { id: 'vp-b', vendor_id: 'v-b', price: 48, quantity: '64 oz', normalized_unit_price: null, price_per_oz: null, vendor_name: 'Vendor B' }, // $0.75/oz
      ],
      product: { unit_size_oz: 64 },
    });
    await recalcBestPrice('prod-1');
    expect(catalogUpdates[0].best_vendor).toBe('Vendor A');
    expect(catalogUpdates[0].best_price).toBe(32); // 0.50/oz * 64 oz
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

  test('only considers active, approved, unexpired vendor rows and invalidates the catalog when none remain', async () => {
    const filterCalls = [];
    const catalogUpdates = [];
    const pricingUpdates = [];
    db.mockImplementation((table) => makeChain(table, (q) => {
      if (table === 'vendor_pricing') {
        if (q.called('update')) {
          pricingUpdates.push(q.args('update')[0]);
          return 1;
        }
        filterCalls.push(q._calls.filter(([m]) => ['where', 'whereIn', 'whereNull', 'whereRaw'].includes(m)));
        return [];
      }
      if (table === 'products_catalog') {
        if (q.called('update')) {
          catalogUpdates.push(q.args('update')[0]);
          return 1;
        }
        return { unit_size_oz: 64 };
      }
      throw new Error(`Unexpected table ${table}`);
    }));
    await recalcBestPrice('prod-1');
    const calls = filterCalls[0];
    expect(calls).toContainEqual(['where', ['vendor_pricing.is_active', true]]);
    expect(calls).toContainEqual(['whereIn', ['vendor_pricing.approval_status', ['approved', 'auto_approved']]]);
    // positivity guard = COALESCE whereRaw (authoritative-first); the
    // unexpired guard stays a grouped where-callback
    expect(calls.some(([m, args]) => m === 'whereRaw' && /COALESCE\(vendor_pricing\.price_amount, vendor_pricing\.price\) > 0/.test(String(args[0])))).toBe(true);
    expect(calls.filter(([m, args]) => m === 'where' && typeof args[0] === 'function').length).toBeGreaterThanOrEqual(1);
    // No eligible rows: the stale winner must be invalidated, not left current.
    expect(catalogUpdates).toHaveLength(1);
    expect(catalogUpdates[0]).toEqual(expect.objectContaining({
      best_price: null,
      best_vendor: null,
      best_vendor_pricing_id: null,
      best_price_amount_cached: null,
      best_price_vendor_id_cached: null,
      best_price_status: 'no_valid_price',
      needs_pricing: true,
    }));
    expect(pricingUpdates).toContainEqual({ is_best_price: false });
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
    const route = (q) => {
      if (q._table === 'price_approvals') {
        if (q.called('update')) return 1; // claim succeeds
        const id = q.args('where')[0]?.id;
        return approvals[id] || null;
      }
      if (q._table === 'vendor_pricing') {
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
      if (q._table === 'price_history') return 1;
      if (q._table === 'products_catalog') {
        if (q.called('update')) return 1;
        return { unit_size_oz: 64 };
      }
      throw new Error(`Unexpected table ${q._table}`);
    };
    // Approvals run inside one transaction per id (claim + price + history + recalc).
    const trx = (table) => makeChain(table, route);
    trx.fn = { now: jest.fn(() => 'NOW()') };
    trx.raw = jest.fn(async () => ({})); // product-scoped advisory lock
    db.transaction.mockImplementation(async (fn) => fn(trx));
    db.mockImplementation((table) => makeChain(table, route));

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
      // ap-2's transaction threw (rolled back) and is reported, not swallowed
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
