/**
 * procurement/auto-reorder.js — the daily low-stock → restock-request sweep.
 *
 * Contract:
 *   - gate off → {skipped:'gated'} before any DB read
 *   - a low product with no open|ordered request → ONE restock row
 *     (source auto_reorder, requested_quantity = reorder_quantity,
 *     target = threshold + reorder) + one bell deduped on the request id
 *   - an existing open|ordered request (any source) → deduped, no row, no bell
 *   - no reorder_quantity → unconfigured, no row
 *   - a per-product failure never stops the sweep
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { candidates: [], existing: null, pricing: null, fresh: undefined, inserted: [], updates: [], insertThrows: false, insertConflict: false };

jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'forUpdate']) q[m] = () => q;
    q.first = async () => {
      if (table === 'product_restock_requests') return mockState.existing;
      if (table === 'vendor_pricing') return mockState.pricing;
      // The locked re-read before the insert: defaults to the candidate's own
      // stock (still low); a test sets mockState.fresh to simulate a receive /
      // disable landing between the scan and the insert.
      if (table === 'products_catalog') {
        if (mockState.fresh !== undefined) return mockState.fresh;
        const c = mockState.candidates[0];
        return c ? { inventory_on_hand: c.inventory_on_hand, low_stock_threshold: c.low_stock_threshold, auto_reorder_enabled: true, active: true, reorder_quantity: c.reorder_quantity, auto_reorder_vendor_id: c.auto_reorder_vendor_id, inventory_unit: c.inventory_unit } : null;
      }
      return null;
    };
    q.update = async (row) => { mockState.updates.push({ table, row }); return 1; };
    const returning = async () => {
      if (mockState.insertThrows) throw new Error('insert boom');
      if (mockState.insertConflict) return [];
      const saved = { id: `req-${mockState.inserted.length + 1}`, ...row };
      mockState.inserted.push(saved);
      return [saved];
    };
    let row;
    q.insert = (r) => { row = r; return { onConflict: () => ({ ignore: () => ({ returning }) }), returning }; };
    q.then = (onOk, onErr) => Promise.resolve(table.startsWith('products_catalog') ? mockState.candidates : []).then(onOk, onErr);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(String(table)));
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

const { runSuppliesAutoReorderSweep } = require('../services/procurement/auto-reorder');

const lowSign = {
  id: 'prod-sign', name: 'Pesticide application sign 4x5', inventory_on_hand: '80', inventory_unit: 'each',
  low_stock_threshold: '100', reorder_quantity: '650', auto_reorder_vendor_id: 'vend-gemplers', vendor_name: 'Gemplers',
};

beforeEach(() => {
  process.env.GATE_AUTO_REORDER = 'true';
  mockState.candidates = [];
  mockState.existing = null;
  mockState.pricing = null;
  mockState.fresh = undefined;
  mockState.inserted = [];
  mockState.updates = [];
  mockState.insertThrows = false;
  mockState.insertConflict = false;
});
afterAll(() => { delete process.env.GATE_AUTO_REORDER; });

test('gate off → skipped before any DB read', async () => {
  delete process.env.GATE_AUTO_REORDER;
  const db = require('../models/db');
  db.mockClear();
  const res = await runSuppliesAutoReorderSweep();
  expect(res.skipped).toBe('gated');
  expect(db).not.toHaveBeenCalled();
});

test('low product with no open request → one auto_reorder row + one deduped bell', async () => {
  mockState.candidates = [lowSign];
  mockState.pricing = { vendor_sku: '127544', vendor_product_url: 'https://gemplers.com/products/universal-pesticide-application-signs' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.created).toHaveLength(1);
  expect(mockState.inserted).toHaveLength(1);
  const row = mockState.inserted[0];
  expect(row.source).toBe('auto_reorder');
  expect(row.status).toBe('open');
  expect(row.requested_quantity).toBe(650);
  expect(row.target_stock).toBe(750);
  expect(row.vendor).toBe('Gemplers');
  expect(row.metadata.vendorSku).toBe('127544');
  expect(notify).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = notify.mock.calls[0];
  expect(category).toBe('system');
  expect(title).toMatch(/low/);
  expect(body).toContain('gemplers.com');
  expect(opts.dedupeKey).toBe(`auto-reorder:${row.id}`);
  expect(opts.link).toBe('/admin/inventory?tab=restock');
  expect(opts.bell).toBe(true); // bell-policy opt-in: a suppressed restock alert is an unworked reorder
});

test('an existing open request of ANY source dedupes — no row, no bell', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-manual', status: 'open', source: 'manual' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.created).toHaveLength(0);
  expect(res.deduped).toEqual([{ productId: 'prod-sign', name: lowSign.name, requestId: 'req-manual' }]);
  expect(mockState.inserted).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
});

test('an existing OPEN auto_reorder request re-rings its deduped bell (failed-bell retry)', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(mockState.inserted).toHaveLength(0);
  expect(res.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][3].dedupeKey).toBe('auto-reorder:req-auto');
});

test('vendor pricing learned after the request was raised → request refreshed + bell refreshOnDedupe', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: null, metadata: { vendorSku: null } };
  mockState.pricing = { vendor_sku: '127544', vendor_product_url: 'https://gemplers.com/x' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.refreshed).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(mockState.updates).toHaveLength(1);
  expect(JSON.parse(mockState.updates[0].row.metadata)).toMatchObject({ vendorSku: '127544', vendorProductUrl: 'https://gemplers.com/x' });
  expect(mockState.updates[0].row.vendor).toBe('Gemplers');
  expect(notify.mock.calls[0][3].refreshOnDedupe).toBe(true);
});

test('an existing ORDERED auto request does not re-ring', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'ordered', source: 'auto_reorder' };
  const notify = jest.fn(async () => ({}));
  await runSuppliesAutoReorderSweep({ notify });
  expect(notify).not.toHaveBeenCalled();
});

test('a concurrent auto row (insert ignored by the unique index) → deduped, no bell', async () => {
  mockState.candidates = [lowSign];
  mockState.insertConflict = true;
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.created).toHaveLength(0);
  expect(res.deduped[0]).toMatchObject({ productId: 'prod-sign', reason: 'concurrent_auto_request' });
  expect(notify).not.toHaveBeenCalled();
});

test('stock received between the candidate scan and the insert → no row, no bell (locked re-read)', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '730', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: '650', auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.created).toHaveLength(0);
  expect(mockState.inserted).toHaveLength(0);
  expect(res.deduped[0]).toMatchObject({ productId: 'prod-sign', reason: 'no_longer_low' });
  expect(notify).not.toHaveBeenCalled();
});

test('auto-reorder disabled between the candidate scan and the insert → no row', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '80', low_stock_threshold: '100', auto_reorder_enabled: false, active: true, reorder_quantity: '650', auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  const res = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(mockState.inserted).toHaveLength(0);
  expect(res.deduped[0]).toMatchObject({ reason: 'no_longer_low' });
});

test('the request row is written from the locked re-read, not the scan snapshot', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '60', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: '650', auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(mockState.inserted[0].current_stock).toBe(60);
  expect(mockState.inserted[0].reason).toContain('at 60 each');
});

test('reorder quantity edited between the scan and the lock → the request and the bell use the locked value', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '80', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: '325', auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(mockState.inserted[0].requested_quantity).toBe(325);
  expect(mockState.inserted[0].target_stock).toBe(425);
  expect(res.created[0].requestedQuantity).toBe(325);
  expect(notify.mock.calls[0][2]).toContain('Reorder 325 each');
});

test('reorder quantity cleared under the lock → unconfigured, no row', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '80', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: null, auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  const res = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(mockState.inserted).toHaveLength(0);
  expect(res.unconfigured[0]).toMatchObject({ reason: 'no_reorder_quantity' });
});

test('no reorder_quantity → unconfigured, no row', async () => {
  mockState.candidates = [{ ...lowSign, reorder_quantity: null }];
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.unconfigured).toEqual([{ productId: 'prod-sign', name: lowSign.name, reason: 'no_reorder_quantity' }]);
  expect(mockState.inserted).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
});

test('a per-product failure is recorded and the sweep continues', async () => {
  mockState.candidates = [lowSign, { ...lowSign, id: 'prod-stake', name: 'Yard sign stake' }];
  mockState.insertThrows = true;
  const res = await runSuppliesAutoReorderSweep({ notify: jest.fn() });
  expect(res.errors).toHaveLength(2);
  expect(res.created).toHaveLength(0);
});
