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

const mockState = { candidates: [], existing: null, pricing: null, lockedPricing: undefined, locked: false, fresh: undefined, inserted: [], updates: [], insertThrows: false, insertConflict: false, raws: [], pricingThrows: false };

jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'select', 'orderBy', 'orWhereExists', 'whereExists', 'from']) q[m] = () => q;
    // The product row lock: from here on the pricing row is the LOCKED one
    // (a test sets lockedPricing to simulate a pricing edit that committed
    // between an unlocked read and the lock).
    q.forUpdate = () => { if (!mockState.raws.some((r) => /pg_advisory_xact_lock/.test(r))) throw new Error('row lock taken before the pricing advisory lock'); mockState.locked = true; return q; };
    q.first = async () => {
      if (table === 'product_restock_requests') return mockState.existing;
      if (table === 'vendors') return mockState.vendorRow === undefined ? { name: 'Gemplers', active: true } : mockState.vendorRow;
      if (table === 'vendor_pricing') {
        if (mockState.pricingThrows) throw new Error('relation "vendor_pricing" does not exist');
        return mockState.locked && mockState.lockedPricing !== undefined ? mockState.lockedPricing : mockState.pricing;
      }
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
  dbFn.raw = (sql) => { mockState.raws.push(String(sql)); return sql; };
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

jest.mock('../services/procurement/order-dispatch', () => ({
  canAutoOrder: jest.fn(async ({ vendorId }) => mockState.autoOrder === true && (!mockState.autoOrderVendor || vendorId === mockState.autoOrderVendor)),
  findLiveAutoOrder: jest.fn(async () => mockState.liveAutoOrder || null), // the product's unreconciled automatic order
  // A pre-submit park's ledger bell is settled before the generic hand-off re-rings (Codex r31 P2).
  settleRequestLedgerBells: jest.fn(async () => { if (mockState.ledgerBellThrows) throw new Error('ledger bell lost connection'); mockState.ledgerBellsSettled = (mockState.ledgerBellsSettled || 0) + 1; }),
}));

const { runSuppliesAutoReorderSweep, sweepFailureError } = require('../services/procurement/auto-reorder');

const lowSign = {
  id: 'prod-sign', name: 'Pesticide application sign 4x5', inventory_on_hand: '80', inventory_unit: 'each',
  low_stock_threshold: '100', reorder_quantity: '650', auto_reorder_vendor_id: 'vend-gemplers', vendor_name: 'Gemplers',
  auto_reorder_enabled: true, active: true,
};

beforeEach(() => {
  process.env.GATE_AUTO_REORDER = 'true';
  mockState.candidates = [];
  mockState.existing = null;
  mockState.pricing = null;
  mockState.lockedPricing = undefined;
  mockState.locked = false;
  mockState.fresh = undefined;
  mockState.inserted = [];
  mockState.updates = [];
  mockState.insertThrows = false;
  mockState.insertConflict = false;
  mockState.raws = [];
  mockState.pricingThrows = false;
  mockState.vendorRow = undefined;
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
  expect(row.target_stock).toBe(730); // on hand 80 + reorder 650: the level receiving it produces (Codex r15 P2)
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

test('a vendor id learned alone (name already on the request, no SKU/URL yet) is still written to the request (pre-push P1)', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', metadata: {} };
  mockState.pricing = null;
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.refreshed).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(JSON.parse(mockState.updates[0].row.metadata)).toMatchObject({ vendorId: 'vend-gemplers' });
  expect(notify.mock.calls[0][3].metadata.vendorId).toBe('vend-gemplers');
});

test('a request pinned to another vendor learns nothing from the product\'s new vendor — no mixed SKU/link (Codex r8 P2)', async () => {
  mockState.candidates = [{ ...lowSign, vendor_name: 'Amazon', auto_reorder_vendor_id: 'vend-amazon' }];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', requested_quantity: '650', unit: 'each', metadata: { vendorId: 'vend-gemplers' } };
  mockState.pricing = { vendor_sku: 'B0AMZ', vendor_product_url: 'https://amazon.com/y' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.refreshed).toEqual([]);
  expect(mockState.updates).toHaveLength(0);
  const [, , body, opts] = notify.mock.calls[0];
  expect(body).toContain('from Gemplers');
  expect(body).not.toContain('amazon');
  expect(opts.metadata.vendorSku).toBeNull();
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
  expect(mockState.inserted[0].target_stock).toBe(405);
  expect(res.created[0].requestedQuantity).toBe(325);
  expect(notify.mock.calls[0][2]).toContain('Reorder 325 each');
});

test('the vendor SKU/link come from the pricing row read UNDER the lock, not an unlocked scan (Codex r9 P2)', async () => {
  mockState.candidates = [lowSign];
  mockState.pricing = { vendor_sku: 'old-sku', vendor_product_url: 'https://gemplers.com/old' };
  mockState.lockedPricing = { vendor_sku: '127544', vendor_product_url: 'https://gemplers.com/new' };
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.created).toHaveLength(1);
  expect(mockState.inserted[0].metadata).toMatchObject({ vendorSku: '127544', vendorProductUrl: 'https://gemplers.com/new' });
  expect(notify.mock.calls[0][3].metadata.vendorSku).toBe('127544');
});

test('the pricing advisory lock is taken before the product row lock, and a failing pricing read is a recorded per-product error, not a silent linkless request (Codex r10 P1 + P2)', async () => {
  mockState.candidates = [lowSign];
  const notify = jest.fn(async () => ({}));
  const ok = await runSuppliesAutoReorderSweep({ notify });
  expect(ok.created).toHaveLength(1);
  expect(mockState.raws.filter((r) => /pg_advisory_xact_lock/.test(r))).toHaveLength(1);
  mockState.inserted = []; mockState.raws = []; mockState.pricingThrows = true;
  const bad = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(bad.created).toHaveLength(0);
  expect(bad.errors).toEqual([{ productId: 'prod-sign', name: lowSign.name, message: expect.stringMatching(/vendor_pricing/) }]);
  expect(mockState.inserted).toHaveLength(0);
});

test('a restock bell that rejects, or resolves null (not persisted), is a sweep error the job-health path sees — the request row stays for the next re-ring (Codex r13 P2)', async () => {
  mockState.candidates = [lowSign];
  const rejected = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => { throw new Error('bell down'); }) });
  expect(rejected.created).toHaveLength(1);
  expect(rejected.bells).toHaveLength(0);
  expect(rejected.errors).toEqual([{ productId: 'prod-sign', name: lowSign.name, requestId: 'req-1', message: 'bell: bell down' }]);
  expect(sweepFailureError(rejected)).toBeInstanceOf(Error);
  mockState.inserted = [];
  const nullRow = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => null) });
  expect(nullRow.errors).toEqual([expect.objectContaining({ message: 'bell: notification not persisted' })]);
});

test('an open auto request pinned to a vendor the product has left (no vendorId learnable) still rings — the dispatcher never claims it (Codex r10 P1)', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-old', status: 'open', source: 'auto_reorder', vendor: 'Old Vendor', metadata: {} };
  mockState.pricing = { vendor_sku: '127544', vendor_product_url: 'https://gemplers.com/x' };
  mockState.autoOrder = true; // vendor B (the product's current vendor) IS auto-orderable
  const notify = jest.fn(async () => ({}));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(mockState.updates).toHaveLength(0); // not the request's vendor: nothing learned
  expect(r.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-old' }]);
  expect(notify).toHaveBeenCalledTimes(1);
  mockState.autoOrder = false;
});

test('reorder quantity cleared under the lock → unconfigured, no row', async () => {
  mockState.candidates = [lowSign];
  mockState.fresh = { inventory_on_hand: '80', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: null, auto_reorder_vendor_id: 'vend-gemplers', inventory_unit: 'each' };
  const res = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(mockState.inserted).toHaveLength(0);
  expect(res.unconfigured[0]).toMatchObject({ reason: 'no_reorder_quantity' });
});

test('an open auto request still re-rings when the product\'s reorder quantity was cleared afterwards (Codex r14 P2)', async () => {
  mockState.candidates = [{ ...lowSign, reorder_quantity: null }];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', metadata: { vendorId: 'vend-gemplers' } };
  const notify = jest.fn(async () => ({}));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.unconfigured).toHaveLength(0);
  expect(r.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(notify).toHaveBeenCalledTimes(1);
});

test('a low product whose received request carries a late automatic order (landedAfterReceive) gets NO fresh request and no bell (hook r27 P1)', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = null; // the received request is not a live request
  mockState.liveAutoOrder = { status: 'needs_review', external_order_number: 'S1-9', vendor_name: 'SiteOne' };
  const notify = jest.fn(async () => ({}));
  try {
    const r = await runSuppliesAutoReorderSweep({ notify });
    expect(r.created).toEqual([]);
    expect(r.deduped).toEqual([expect.objectContaining({ productId: 'prod-sign', reason: 'auto_order_live' })]);
    expect(notify).not.toHaveBeenCalled();
  } finally { mockState.liveAutoOrder = null; }
});

test('an open auto request with an automatic order already OUT (ambiguous submit / stale recovery park) is NOT re-belled "order manually" when the dispatcher no longer orders — the ledger bell owns it (hook r27 P0)', async () => {
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Sticker Mule', metadata: { vendorId: 'vend-sm' } };
  mockState.autoOrder = false; // gate closed since the order went out
  mockState.liveAutoOrder = { status: 'needs_review', external_order_number: null, vendor_name: 'Sticker Mule' };
  const notify = jest.fn(async () => ({}));
  try {
    const r = await runSuppliesAutoReorderSweep({ notify });
    expect(r.renotified).toEqual([]);
    expect(r.deduped).toEqual([expect.objectContaining({ requestId: 'req-auto' }), expect.objectContaining({ requestId: 'req-auto', reason: 'auto_order_live' })]);
    expect(notify).not.toHaveBeenCalled();
  } finally { mockState.liveAutoOrder = null; }
});

test('a re-ring settles the request\'s parked ledger bell (a pre-submit park\'s "order manually") BEFORE the generic hand-off rings; a failed settle withholds the hand-off and is a sweep error (Codex r31 P2)', async () => {
  const { settleRequestLedgerBells } = require('../services/procurement/order-dispatch');
  settleRequestLedgerBells.mockClear();
  mockState.candidates = [lowSign];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Sticker Mule', metadata: { vendorId: 'vend-sm' } };
  mockState.autoOrder = false; // the vendor gate closed after a no_price park
  const order = [];
  settleRequestLedgerBells.mockImplementationOnce(async () => { order.push('settle'); });
  const notify = jest.fn(async () => { order.push('bell'); return {}; });
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(settleRequestLedgerBells).toHaveBeenCalledWith(expect.anything(), 'req-auto');
  expect(order).toEqual(['settle', 'bell']);
  mockState.ledgerBellThrows = true;
  try {
    const bad = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
    expect(bad.renotified).toEqual([]);
    expect(bad.errors).toEqual([{ productId: 'prod-sign', name: lowSign.name, requestId: 'req-auto', message: 'ledger bell: ledger bell lost connection' }]);
  } finally { mockState.ledgerBellThrows = false; }
});

test('an open auto request is found and re-belled even after the product\'s low-stock threshold was cleared (Codex r15 P2)', async () => {
  mockState.candidates = [{ ...lowSign, low_stock_threshold: null }];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', metadata: { vendorId: 'vend-gemplers' } };
  const notify = jest.fn(async () => ({}));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(notify).toHaveBeenCalledTimes(1);
});

test('a product that is not low (or has no threshold) and has no live request is left alone', async () => {
  mockState.candidates = [{ ...lowSign, inventory_on_hand: '500' }, { ...lowSign, id: 'p2', low_stock_threshold: null }];
  const r = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(r.created).toHaveLength(0);
  expect(r.unconfigured).toHaveLength(0);
  expect(mockState.inserted).toHaveLength(0);
});

test('a deactivated vendor steers nothing: no name, SKU or link on the request, bell says order manually (Codex r15 P2)', async () => {
  mockState.candidates = [lowSign];
  mockState.pricing = { vendor_sku: '127544', vendor_product_url: 'https://gemplers.com/x' };
  mockState.vendorRow = { name: 'Gemplers', active: false };
  const notify = jest.fn(async () => ({}));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.created).toHaveLength(1);
  expect(mockState.inserted[0].vendor).toBeNull();
  expect(mockState.inserted[0].metadata).toMatchObject({ vendorId: null, vendorSku: null, vendorProductUrl: null });
  expect(notify.mock.calls[0][2]).not.toContain('gemplers.com');
});

test('an open auto request is still re-belled after "reorder when low" was turned off; nothing new is raised for that product (Codex r16 P2)', async () => {
  mockState.candidates = [{ ...lowSign, auto_reorder_enabled: false }];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', metadata: { vendorId: 'vend-gemplers' } };
  const notify = jest.fn(async () => ({}));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.renotified).toEqual([{ productId: 'prod-sign', requestId: 'req-auto' }]);
  expect(notify).toHaveBeenCalledTimes(1);
  mockState.existing = null; mockState.inserted = [];
  const none = await runSuppliesAutoReorderSweep({ notify: jest.fn(async () => ({})) });
  expect(none.created).toHaveLength(0);
  expect(mockState.inserted).toHaveLength(0);
});

test('no reorder_quantity → unconfigured, no row', async () => {
  mockState.candidates = [{ ...lowSign, reorder_quantity: null }];
  const notify = jest.fn(async () => ({}));
  const res = await runSuppliesAutoReorderSweep({ notify });
  expect(res.unconfigured).toEqual([{ productId: 'prod-sign', name: lowSign.name, reason: 'no_reorder_quantity' }]);
  expect(mockState.inserted).toHaveLength(0);
  expect(notify).not.toHaveBeenCalled();
});

test('a per-product failure is recorded and the sweep continues — and the run still fails for job health (pre-push P1)', async () => {
  mockState.candidates = [lowSign, { ...lowSign, id: 'prod-stake', name: 'Yard sign stake' }];
  mockState.insertThrows = true;
  const res = await runSuppliesAutoReorderSweep({ notify: jest.fn() });
  expect(res.errors).toHaveLength(2);
  expect(res.created).toHaveLength(0);
  const failure = sweepFailureError(res);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(/2 product\(s\) failed: .*Yard sign stake \(insert boom\)/);
  expect(sweepFailureError({ errors: [] })).toBeNull();
  expect(sweepFailureError({ skipped: 'gated' })).toBeNull();
});

test('PR 2: when the dispatcher will order from the vendor, the request is raised with NO manual bell', async () => {
  mockState.autoOrder = true;
  mockState.candidates = [lowSign];
  const notify = jest.fn(async () => ({ id: 'n' }));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.created).toHaveLength(1);
  expect(r.autoOrder).toEqual([r.created[0].requestId]);
  expect(notify).not.toHaveBeenCalled();
  // …and the re-bell branch for an already-open auto request stays silent too.
  mockState.existing = { id: 'req-open', status: 'open', source: 'auto_reorder', metadata: {} };
  const r2 = await runSuppliesAutoReorderSweep({ notify });
  expect(r2.deduped).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
  // …and the sweep touches no bell on the hand-off — the dispatcher's claim retires it (Codex r20 P1).
  expect(mockState.updates.filter((u) => u.table === 'notifications')).toHaveLength(0);
  mockState.autoOrder = false;
});

test('a dispatcher eligibility check that THROWS (credential lookup infrastructure failure) records the product as an error and rings NO "order manually" bell (Codex #3853 r17 P1)', async () => {
  const { canAutoOrder } = require('../services/procurement/order-dispatch');
  canAutoOrder.mockRejectedValueOnce(new Error('canAutoOrder: credential lookup for SiteOne failed: ECONNRESET'));
  mockState.candidates = [lowSign];
  const notify = jest.fn(async () => ({ id: 'n' }));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.errors).toEqual([expect.objectContaining({ productId: lowSign.id, message: expect.stringContaining('ECONNRESET') })]);
  expect(notify).not.toHaveBeenCalled();
});

test('PR 2: the bell decision follows the LOCKED vendor — a switch to a manual vendor mid-sweep still bells', async () => {
  mockState.autoOrder = true;
  mockState.autoOrderVendor = 'vend-gemplers'; // only the scan-time vendor auto-orders
  mockState.candidates = [lowSign];
  // Between the scan and the locked insert the admin moved the product to a manual vendor.
  mockState.fresh = { inventory_on_hand: '80', low_stock_threshold: '100', auto_reorder_enabled: true, active: true, reorder_quantity: '650', auto_reorder_vendor_id: 'vend-manual', inventory_unit: 'each' };
  const notify = jest.fn(async () => ({ id: 'n' }));
  const r = await runSuppliesAutoReorderSweep({ notify });
  expect(r.created).toHaveLength(1);
  expect(r.autoOrder).toBeUndefined();
  expect(notify).toHaveBeenCalledTimes(1);
  mockState.autoOrder = false;
  mockState.autoOrderVendor = null;
});

test('re-bell on an open auto request says what the REQUEST says, not the product\'s edited config (Codex r6 P2)', async () => {
  // Admin cut reorder_quantity 650 → 100 and swapped the vendor after the
  // request was raised; the Restock queue still shows the original 650 from
  // Gemplers, so the bell must too.
  mockState.candidates = [{ ...lowSign, reorder_quantity: '100', vendor_name: 'Amazon', auto_reorder_vendor_id: 'vend-amazon' }];
  mockState.existing = { id: 'req-auto', status: 'open', source: 'auto_reorder', vendor: 'Gemplers', requested_quantity: '650', unit: 'each', current_stock: '80', metadata: { vendorId: 'vend-gemplers', vendorSku: '127544', vendorProductUrl: 'https://gemplers.com/x' } };
  mockState.pricing = { vendor_sku: 'B0AMZ', vendor_product_url: 'https://amazon.com/y' };
  const notify = jest.fn(async () => ({}));
  await runSuppliesAutoReorderSweep({ notify });
  expect(mockState.updates).toHaveLength(0); // populated request never rewritten
  const [, , body, opts] = notify.mock.calls[0];
  expect(body).toContain('Reorder 650 each from Gemplers');
  expect(body).toContain('gemplers.com/x');
  expect(body).not.toContain('amazon');
  expect(opts.metadata).toMatchObject({ vendorId: 'vend-gemplers', vendorSku: '127544' });
});
