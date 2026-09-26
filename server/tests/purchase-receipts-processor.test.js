/**
 * purchase-receipts/receipt-processor.js — classification (match + pack-size
 * agreement) and idempotent writes through the EXISTING restock/adjust path
 * (inventory-operations.js), never raw SQL for the stock write itself.
 *
 * product-costing's parsePackSize and inventory-units' convertInventoryQuantity
 * run for REAL here (pure, already covered by their own suites) — only the
 * product match and the DB/inventory-operations boundary are mocked.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// live-restock-request.js is used for real (unmocked) here — it is a pure,
// side-effect-free constant + a function this module no longer even calls
// (see selectRestockRequestOutcome, which queries product_restock_requests
// directly for the vendor-correlation rule below).
const mockState = {
  match: { matched: false, reason: 'unmatched' },
  // Seeds the fake `product_restock_requests` table for
  // selectRestockRequestOutcome's own query (see the db mock below) — every
  // row here is treated as already-filtered to open/ordered for the product.
  liveRequests: [],
  // Seeds the fake `vendors` table lookup findAmazonVendor runs.
  amazonVendor: { id: 'vend-amazon', name: 'Amazon', website: 'https://www.amazon.com', active: true },
  adjustResult: null, adjustError: null, updateResult: null, updateError: null, claimUpdateError: null,
};

jest.mock('../services/purchase-receipts/product-matcher', () => ({
  matchAmazonTitleToProduct: jest.fn(async () => mockState.match),
}));
const mockAdjustStock = jest.fn(async () => {
  if (mockState.adjustError) throw mockState.adjustError;
  return mockState.adjustResult;
});
const mockUpdateRestockRequest = jest.fn(async () => {
  if (mockState.updateError) throw mockState.updateError;
  return mockState.updateResult;
});
jest.mock('../services/inventory-operations', () => ({
  adjustStock: (...args) => mockAdjustStock(...args),
  updateRestockRequest: (...args) => mockUpdateRestockRequest(...args),
}));

const dbState = { lines: {} };
jest.mock('../models/db', () => {
  const fn = (table) => {
    // findAmazonVendor's lookup — `.where(cb).where('active', true).first()`.
    if (table === 'vendors') {
      const q = {};
      q.where = () => q;
      q.first = async () => mockState.amazonVendor;
      return q;
    }
    // selectRestockRequestOutcome's own query — `.where({product_id}).whereIn('status', [...])`,
    // awaited directly (no .first()); mockState.liveRequests stands in as
    // "every row already scoped to this product and open/ordered".
    if (table === 'product_restock_requests') {
      const q = {};
      q.where = () => q;
      q.whereIn = () => q;
      q.then = (resolve, reject) => Promise.resolve(mockState.liveRequests).then(resolve, reject);
      return q;
    }
    const q = {};
    q.where = (cond) => { q._cond = cond; return q; };
    q.first = async () => {
      if (!q._cond?.vendor) return undefined;
      return dbState.lines[`${q._cond.vendor}|${q._cond.order_number}|${q._cond.shipment_key}|${q._cond.line_no}`];
    };
    q.insert = (row) => {
      const res = {
        onConflict: () => res,
        ignore: () => res,
        returning: async () => {
          const key = `${row.vendor}|${row.order_number}|${row.shipment_key}|${row.line_no}`;
          if (dbState.lines[key]) return [];
          const saved = { id: `line-${Object.keys(dbState.lines).length + 1}`, ...row };
          dbState.lines[key] = saved;
          return [saved];
        },
      };
      return res;
    };
    q.update = async (fields) => {
      if (mockState.claimUpdateError && fields.movement_id !== undefined) throw mockState.claimUpdateError;
      const found = Object.values(dbState.lines).find((l) => l.id === q._cond?.id);
      if (found) Object.assign(found, fields);
      return found ? 1 : 0;
    };
    q.del = async () => {
      const key = Object.keys(dbState.lines).find((k) => dbState.lines[k].id === q._cond?.id);
      if (key) delete dbState.lines[key];
      return key ? 1 : 0;
    };
    return q;
  };
  const mockDb = jest.fn(fn);
  // Simulates real knex transaction rollback for the purposes of this
  // suite: a callback that throws restores purchase_receipt_lines to its
  // pre-transaction state (mirroring an actual ROLLBACK undoing the claim
  // insert along with everything after it), rather than a bespoke
  // delete-on-failure compensation.
  mockDb.transaction = async (cb) => {
    const snapshot = JSON.parse(JSON.stringify(dbState.lines));
    try {
      return await cb(mockDb);
    } catch (err) {
      dbState.lines = snapshot;
      throw err;
    }
  };
  return mockDb;
});

const { processReceiptLine, classifyItem } = require('../services/purchase-receipts/receipt-processor');
const { matchAmazonTitleToProduct } = require('../services/purchase-receipts/product-matcher');

const taurus = { id: 'p-taurus', name: 'Taurus SC', container_size: '78 fl oz', inventory_unit: 'fl_oz' };

beforeEach(() => {
  mockState.match = { matched: false, reason: 'unmatched' };
  mockState.liveRequests = [];
  mockState.amazonVendor = { id: 'vend-amazon', name: 'Amazon', website: 'https://www.amazon.com', active: true };
  mockState.adjustResult = { movement: { id: 'mv-1' }, product: taurus };
  mockState.adjustError = null;
  mockState.updateResult = { movement: { id: 'mv-2' }, request: { id: 'req-1' } };
  mockState.updateError = null;
  mockState.claimUpdateError = null;
  for (const k of Object.keys(dbState.lines)) delete dbState.lines[k];
  mockAdjustStock.mockClear();
  mockUpdateRestockRequest.mockClear();
  matchAmazonTitleToProduct.mockClear();
});

describe('classifyItem', () => {
  test('unmatched title -> status unmatched, no product', async () => {
    const result = await classifyItem({ title: 'Lenovo Chromebook Duet 11 inch', quantity: 1 });
    expect(result).toEqual({ status: 'unmatched', productId: null });
  });

  test('matched product with no parseable container_size -> needs_size', async () => {
    mockState.match = { matched: true, product: { id: 'p1', name: 'Mystery Product', container_size: null } };
    const result = await classifyItem({ title: 'Mystery Product', quantity: 1 });
    expect(result).toMatchObject({ status: 'needs_size', productId: 'p1' });
  });

  test('title pack size disagrees with container_size -> size_mismatch, nothing computed', async () => {
    mockState.match = { matched: true, product: taurus };
    const result = await classifyItem({ title: 'Control Solutions Taurus SC Termiticide 96 oz', quantity: 1 });
    expect(result).toMatchObject({ status: 'size_mismatch', productId: 'p-taurus' });
  });

  test('title pack size agrees numerically via ambiguous "oz" standing in for the product\'s fl_oz dimension -> logged', async () => {
    mockState.match = { matched: true, product: taurus };
    const result = await classifyItem({ title: 'Control Solutions Taurus SC Termiticide 78 oz', quantity: 2 });
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz' });
  });

  test('no size in the title at all -> logged using the container_size alone', async () => {
    mockState.match = { matched: true, product: taurus };
    const result = await classifyItem({ title: 'Taurus SC Termiticide', quantity: 1 });
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 78, receivedUnit: 'fl_oz' });
  });

  test('a weight container size (lb) agrees with an ambiguous "oz" title amount converted through the product\'s own dimension', async () => {
    const granular = { id: 'p-gran', name: 'Granular Bait', container_size: '1 lb' };
    mockState.match = { matched: true, product: granular };
    // 16 oz == 1 lb: the SAME numeric conversion path as the fl_oz case, just weight this time.
    const result = await classifyItem({ title: 'Granular Bait 16 oz Bag', quantity: 1 });
    expect(result).toEqual({ status: 'logged', productId: 'p-gran', product: granular, receivedQty: 1, receivedUnit: 'lb' });
  });
});

describe('classifyItem — multipack markers (anywhere in the title, not just a leading multiplier)', () => {
  beforeEach(() => { mockState.match = { matched: true, product: taurus }; });

  test('"N x SIZE" form: per-unit size matches the container -> N packs logged', async () => {
    const result = await classifyItem({ title: 'Taurus SC 2 x 78 oz', quantity: 1 });
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz' });
  });

  test('"N × SIZE" (unicode multiplication sign) form', async () => {
    const result = await classifyItem({ title: 'Taurus SC 2 × 78 oz', quantity: 1 });
    expect(result.receivedQty).toBe(156);
    expect(result.status).toBe('logged');
  });

  test('"(Pack of N)" form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz (Pack of 2)', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('"Pack of N" (no parens) form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz Pack of 2', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('"N-Pack" form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz 2-Pack', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('"N Pack" (no hyphen) form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz 2 Pack', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('"Case of N" form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz Case of 2', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('"Set of N" form', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 78 oz Set of 2', quantity: 1 });
    expect(result.receivedQty).toBe(156);
  });

  test('order quantity still multiplies on top of the pack math (2 shipped, each a 2-pack of 78 oz)', async () => {
    const result = await classifyItem({ title: 'Taurus SC 2 x 78 oz', quantity: 2 });
    expect(result.receivedQty).toBe(312); // 2 (order qty) * 2 (pack) * 78
  });

  test('agreement branch B: N x per-unit size equals the catalog container (the container IS the whole pack)', async () => {
    const bulkContainer = { id: 'p-taurus', name: 'Taurus SC', container_size: '156 fl oz' };
    mockState.match = { matched: true, product: bulkContainer };
    const result = await classifyItem({ title: 'Taurus SC 2 x 78 oz', quantity: 1 });
    // 78 != 156 (branch A fails) but 2*78 == 156 (branch B) -> the container
    // already IS the 2-pack, so received per item is just the container size.
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: bulkContainer, receivedQty: 156, receivedUnit: 'fl_oz' });
  });

  test('mismatch: neither the per-unit size nor N times it agrees with the container -> size_mismatch, never assumed', async () => {
    const result = await classifyItem({ title: 'Taurus SC 2 x 50 oz', quantity: 1 });
    expect(result).toMatchObject({ status: 'size_mismatch', productId: 'p-taurus' });
  });

  test('a multipack marker with NO parseable per-unit size anywhere in the title is never assumed -> size_mismatch', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide (Pack of 2)', quantity: 1 });
    expect(result).toMatchObject({ status: 'size_mismatch', productId: 'p-taurus' });
  });

  test('"count" is never treated as a multipack marker (e.g. "20 count" tablet counts keep working as before)', async () => {
    const result = await classifyItem({ title: 'Taurus SC Termiticide 20 count', quantity: 1 });
    // No multipack marker matches "count" and parsePackSize has no "each"/
    // "count" dimension either, so this is identical to "no size in the
    // title at all" -> logged straight from the container size, unscaled.
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 78, receivedUnit: 'fl_oz' });
  });
});

describe('processReceiptLine', () => {
  const email = { id: 'email-1', received_at: new Date() };

  test('unmatched item: inserts a purchase_receipt_lines row, never touches inventory-operations', async () => {
    const outcome = await processReceiptLine({ email, orderNumber: '111-1111111-1111111', shipmentKey: 'ship-1', item: { title: 'Chromebook', quantity: 1 }, lineNo: 1 });
    expect(outcome).toMatchObject({ status: 'unmatched', inserted: true });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    expect(dbState.lines['amazon|111-1111111-1111111|ship-1|1']).toMatchObject({ status: 'unmatched', product_id: null });
  });

  test('logged item with no live restock request calls adjustStock with the computed amount + amazon_delivery provenance', async () => {
    mockState.match = { matched: true, product: taurus };
    const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 });
    expect(outcome.status).toBe('logged');
    expect(outcome.viaRequest).toBe(false);
    expect(mockAdjustStock).toHaveBeenCalledWith('p-taurus',
      { movementType: 'restock', quantity: 156, unit: 'fl_oz' },
      expect.objectContaining({ source: 'amazon_delivery', extraMetadata: { source: 'amazon_delivery', orderNumber: '114-9578837-7732259', emailId: 'email-1', rawTitle: 'Taurus SC Termiticide 78 oz' } }));
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    const saved = dbState.lines['amazon|114-9578837-7732259|ship-1|1'];
    expect(saved).toMatchObject({ status: 'logged', movement_id: 'mv-1', restock_request_id: null, received_qty: 156, received_unit: 'fl_oz' });
  });

  describe('restock request vendor correlation', () => {
    test('a live OPEN request qualifies regardless of vendor — a need, not yet placed with anyone', async () => {
      mockState.match = { matched: true, product: taurus };
      mockState.liveRequests = [{ id: 'req-open', status: 'open', vendor: 'SiteOne', metadata: null }];
      const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
      expect(outcome.viaRequest).toBe(true);
      expect(outcome.leftoverRequest).toBeNull();
      expect(mockUpdateRestockRequest).toHaveBeenCalledWith('req-open',
        { action: 'receive', quantity: 78, unit: 'fl_oz' },
        expect.objectContaining({ source: 'amazon_delivery' }));
      expect(mockAdjustStock).not.toHaveBeenCalled();
      expect(dbState.lines['amazon|114-9578837-7732259|ship-1|1']).toMatchObject({ movement_id: 'mv-2', restock_request_id: 'req-open' });
    });

    test('a live ORDERED request qualifies when it was placed with Amazon (metadata.vendorId)', async () => {
      mockState.match = { matched: true, product: taurus };
      mockState.liveRequests = [{ id: 'req-amz', status: 'ordered', vendor: 'Amazon', metadata: { vendorId: 'vend-amazon' } }];
      const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
      expect(outcome.viaRequest).toBe(true);
      expect(mockUpdateRestockRequest).toHaveBeenCalledWith('req-amz', expect.objectContaining({ action: 'receive' }), expect.anything());
      expect(mockAdjustStock).not.toHaveBeenCalled();
    });

    test('a live ORDERED request qualifies via the plain vendor display text ("Amazon") when metadata carries no vendorId', async () => {
      mockState.match = { matched: true, product: taurus };
      mockState.liveRequests = [{ id: 'req-amz-text', status: 'ordered', vendor: 'Amazon', metadata: null }];
      const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
      expect(outcome.viaRequest).toBe(true);
      expect(mockUpdateRestockRequest).toHaveBeenCalledWith('req-amz-text', expect.objectContaining({ action: 'receive' }), expect.anything());
    });

    test('a live ORDERED request placed with a DIFFERENT vendor (SiteOne) is left untouched — stock is adjusted directly and the leftover is named', async () => {
      mockState.match = { matched: true, product: taurus };
      mockState.liveRequests = [{ id: 'req-site1', status: 'ordered', vendor: 'SiteOne', metadata: { vendorId: 'vend-siteone' } }];
      const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
      expect(outcome.viaRequest).toBe(false);
      expect(outcome.leftoverRequest).toEqual({ vendor: 'SiteOne', status: 'ordered' });
      expect(mockAdjustStock).toHaveBeenCalled();
      expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
      expect(dbState.lines['amazon|114-9578837-7732259|ship-1|1']).toMatchObject({ movement_id: 'mv-1', restock_request_id: null });
    });

    test('two qualifying live requests are ambiguous — none received, stock adjusted, no leftover named', async () => {
      mockState.match = { matched: true, product: taurus };
      mockState.liveRequests = [
        { id: 'req-open-1', status: 'open', vendor: 'SiteOne', metadata: null },
        { id: 'req-open-2', status: 'open', vendor: 'Gemplers', metadata: null },
      ];
      const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
      expect(outcome.viaRequest).toBe(false);
      expect(outcome.leftoverRequest).toBeNull(); // 2+ leftover requests -> nothing specific to name
      expect(mockAdjustStock).toHaveBeenCalled();
      expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    });
  });

  test('idempotency: running the same (order, shipment, line) twice logs once', async () => {
    mockState.match = { matched: true, product: taurus };
    const args = { email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 };
    const first = await processReceiptLine(args);
    const second = await processReceiptLine(args);
    expect(first.status).toBe('logged');
    expect(second).toEqual({ skipped: true, reason: 'already_processed' });
    expect(mockAdjustStock).toHaveBeenCalledTimes(1);
  });

  test('split shipment: SAME order, DIFFERENT shipmentKey -> both shipments log (never dropped as a duplicate)', async () => {
    mockState.match = { matched: true, product: taurus };
    const shipmentOne = await processReceiptLine({ email, orderNumber: '113-3148685-4885834', shipmentKey: 'ship-one', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 4 }, lineNo: 1 });
    const shipmentTwo = await processReceiptLine({ email: { ...email, id: 'email-2' }, orderNumber: '113-3148685-4885834', shipmentKey: 'ship-two', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 3 }, lineNo: 1 });
    expect(shipmentOne.status).toBe('logged');
    expect(shipmentTwo.status).toBe('logged');
    expect(mockAdjustStock).toHaveBeenCalledTimes(2);
    expect(dbState.lines['amazon|113-3148685-4885834|ship-one|1']).toBeDefined();
    expect(dbState.lines['amazon|113-3148685-4885834|ship-two|1']).toBeDefined();
  });

  test('no shipmentKey passed falls back to the email\'s own id when it has no gmail_id', async () => {
    mockState.match = { matched: true, product: taurus };
    const outcome = await processReceiptLine({ email: { id: 'email-9' }, orderNumber: '114-9578837-7732259', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
    expect(outcome.status).toBe('logged');
    expect(dbState.lines['amazon|114-9578837-7732259|email-9|1']).toBeDefined();
  });

  test('no shipmentKey and no email id at all -> skipped, never inserted', async () => {
    const outcome = await processReceiptLine({ email: {}, orderNumber: '114-9578837-7732259', item: { title: 'Anything', quantity: 1 }, lineNo: 1 });
    expect(outcome).toEqual({ skipped: true, reason: 'no_shipment_key' });
  });

  test('the movement (adjustStock) throwing rolls back the WHOLE transaction — no claim row remains, re-run logs once', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.adjustError = new Error('DB unavailable');
    const args = { email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 };
    await expect(processReceiptLine(args)).rejects.toThrow('DB unavailable');
    expect(dbState.lines['amazon|114-9578837-7732259|ship-1|1']).toBeUndefined(); // claim insert itself rolled back, not just left un-updated
    // A clean retry now succeeds and logs exactly once.
    mockState.adjustError = null;
    const retried = await processReceiptLine(args);
    expect(retried.status).toBe('logged');
    expect(mockAdjustStock).toHaveBeenCalledTimes(2); // one failed attempt + one successful retry
  });

  test('the claim\'s own movement_id update throwing rolls back too — no movement/claim persisted, re-run logs cleanly', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.claimUpdateError = new Error('update failed');
    const args = { email, orderNumber: '114-9578837-7732259', shipmentKey: 'ship-3', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 };
    await expect(processReceiptLine(args)).rejects.toThrow('update failed');
    expect(dbState.lines['amazon|114-9578837-7732259|ship-3|1']).toBeUndefined(); // the claim insert is rolled back along with the failed update
    mockState.claimUpdateError = null;
    const retried = await processReceiptLine(args);
    expect(retried.status).toBe('logged');
    expect(mockAdjustStock).toHaveBeenCalledTimes(2); // one attempt whose write never persisted + one clean retry
  });

  test('no Order # on the email -> skipped, never inserted', async () => {
    const outcome = await processReceiptLine({ email, orderNumber: null, shipmentKey: 'ship-1', item: { title: 'Anything', quantity: 1 }, lineNo: 1 });
    expect(outcome).toEqual({ skipped: true, reason: 'no_order_number' });
    expect(Object.keys(dbState.lines)).toHaveLength(0);
  });

  test('size_mismatch and needs_size items are inserted with no inventory-operations call', async () => {
    mockState.match = { matched: true, product: taurus };
    const mismatch = await processReceiptLine({ email, orderNumber: '200-0000000-0000000', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 96 oz', quantity: 1 }, lineNo: 1 });
    expect(mismatch.status).toBe('size_mismatch');

    mockState.match = { matched: true, product: { id: 'p-nosize', name: 'No Size Product', container_size: null } };
    const needsSize = await processReceiptLine({ email, orderNumber: '200-0000000-0000000', shipmentKey: 'ship-1', item: { title: 'No Size Product', quantity: 1 }, lineNo: 2 });
    expect(needsSize.status).toBe('needs_size');

    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
  });

  test('forcedStatus "no_items": one placeholder row, no matching/classification, no inventory-operations call', async () => {
    const outcome = await processReceiptLine({
      email, orderNumber: '300-0000000-0000000', shipmentKey: 'ship-1',
      item: { title: 'Delivered: 1 Lawn & Garden item', quantity: 1 }, lineNo: 1, forcedStatus: 'no_items',
    });
    expect(outcome).toEqual({ status: 'no_items', inserted: true, product: null });
    expect(dbState.lines['amazon|300-0000000-0000000|ship-1|1']).toMatchObject({ status: 'no_items', product_id: null, raw_title: 'Delivered: 1 Lawn & Garden item' });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    // matchAmazonTitleToProduct is never consulted for a forced status.
    expect(matchAmazonTitleToProduct).not.toHaveBeenCalled();
  });
});
