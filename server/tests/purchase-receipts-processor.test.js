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

const mockState = { match: { matched: false, reason: 'unmatched' }, liveRequest: null, adjustResult: null, adjustError: null, updateResult: null, updateError: null };

jest.mock('../services/purchase-receipts/product-matcher', () => ({
  matchAmazonTitleToProduct: jest.fn(async () => mockState.match),
}));
jest.mock('../services/procurement/live-restock-request', () => ({
  findLiveRestockRequest: jest.fn(async () => mockState.liveRequest),
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
  const fn = () => {
    const q = {};
    q.where = (cond) => { q._cond = cond; return q; };
    q.first = async () => {
      if (!q._cond?.vendor) return undefined;
      return dbState.lines[`${q._cond.vendor}|${q._cond.order_number}|${q._cond.line_no}`];
    };
    q.insert = (row) => {
      const res = {
        onConflict: () => res,
        ignore: () => res,
        returning: async () => {
          const key = `${row.vendor}|${row.order_number}|${row.line_no}`;
          if (dbState.lines[key]) return [];
          const saved = { id: `line-${Object.keys(dbState.lines).length + 1}`, ...row };
          dbState.lines[key] = saved;
          return [saved];
        },
      };
      return res;
    };
    q.update = async (fields) => {
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
  return jest.fn(fn);
});

const { processReceiptLine, classifyItem } = require('../services/purchase-receipts/receipt-processor');

const taurus = { id: 'p-taurus', name: 'Taurus SC', container_size: '78 fl oz', inventory_unit: 'fl_oz' };

beforeEach(() => {
  mockState.match = { matched: false, reason: 'unmatched' };
  mockState.liveRequest = null;
  mockState.adjustResult = { movement: { id: 'mv-1' }, product: taurus };
  mockState.adjustError = null;
  mockState.updateResult = { movement: { id: 'mv-2' }, request: { id: 'req-1' } };
  mockState.updateError = null;
  for (const k of Object.keys(dbState.lines)) delete dbState.lines[k];
  mockAdjustStock.mockClear();
  mockUpdateRestockRequest.mockClear();
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

describe('processReceiptLine', () => {
  const email = { id: 'email-1', received_at: new Date() };

  test('unmatched item: inserts a purchase_receipt_lines row, never touches inventory-operations', async () => {
    const outcome = await processReceiptLine({ email, orderNumber: '111-1111111-1111111', item: { title: 'Chromebook', quantity: 1 }, lineNo: 1 });
    expect(outcome).toMatchObject({ status: 'unmatched', inserted: true });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    expect(dbState.lines['amazon|111-1111111-1111111|1']).toMatchObject({ status: 'unmatched', product_id: null });
  });

  test('logged item with no live restock request calls adjustStock with the computed amount + amazon_delivery provenance', async () => {
    mockState.match = { matched: true, product: taurus };
    const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 });
    expect(outcome.status).toBe('logged');
    expect(outcome.viaRequest).toBe(false);
    expect(mockAdjustStock).toHaveBeenCalledWith('p-taurus',
      { movementType: 'restock', quantity: 156, unit: 'fl_oz' },
      expect.objectContaining({ source: 'amazon_delivery', extraMetadata: { source: 'amazon_delivery', orderNumber: '114-9578837-7732259', emailId: 'email-1', rawTitle: 'Taurus SC Termiticide 78 oz' } }));
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
    const saved = dbState.lines['amazon|114-9578837-7732259|1'];
    expect(saved).toMatchObject({ status: 'logged', movement_id: 'mv-1', restock_request_id: null, received_qty: 156, received_unit: 'fl_oz' });
  });

  test('an open/ordered restock request for the matched product is RECEIVED instead of a second restock', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.liveRequest = { id: 'req-open', status: 'open' };
    const outcome = await processReceiptLine({ email, orderNumber: '114-9578837-7732259', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 }, lineNo: 1 });
    expect(outcome.viaRequest).toBe(true);
    expect(mockUpdateRestockRequest).toHaveBeenCalledWith('req-open',
      { action: 'receive', quantity: 78, unit: 'fl_oz' },
      expect.objectContaining({ source: 'amazon_delivery' }));
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(dbState.lines['amazon|114-9578837-7732259|1']).toMatchObject({ movement_id: 'mv-2', restock_request_id: 'req-open' });
  });

  test('idempotency: running the same (order, line) twice logs once', async () => {
    mockState.match = { matched: true, product: taurus };
    const args = { email, orderNumber: '114-9578837-7732259', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 };
    const first = await processReceiptLine(args);
    const second = await processReceiptLine(args);
    expect(first.status).toBe('logged');
    expect(second).toEqual({ skipped: true, reason: 'already_processed' });
    expect(mockAdjustStock).toHaveBeenCalledTimes(1);
  });

  test('a restock/adjust failure rolls back the claim so the next run retries the line', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.adjustError = new Error('DB unavailable');
    const args = { email, orderNumber: '114-9578837-7732259', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1 };
    await expect(processReceiptLine(args)).rejects.toThrow('DB unavailable');
    expect(dbState.lines['amazon|114-9578837-7732259|1']).toBeUndefined();
    // A clean retry now succeeds and logs exactly once.
    mockState.adjustError = null;
    const retried = await processReceiptLine(args);
    expect(retried.status).toBe('logged');
    expect(mockAdjustStock).toHaveBeenCalledTimes(2); // one failed attempt + one successful retry
  });

  test('no Order # on the email -> skipped, never inserted', async () => {
    const outcome = await processReceiptLine({ email, orderNumber: null, item: { title: 'Anything', quantity: 1 }, lineNo: 1 });
    expect(outcome).toEqual({ skipped: true, reason: 'no_order_number' });
    expect(Object.keys(dbState.lines)).toHaveLength(0);
  });

  test('size_mismatch and needs_size items are inserted with no inventory-operations call', async () => {
    mockState.match = { matched: true, product: taurus };
    const mismatch = await processReceiptLine({ email, orderNumber: '200-0000000-0000000', item: { title: 'Taurus SC Termiticide 96 oz', quantity: 1 }, lineNo: 1 });
    expect(mismatch.status).toBe('size_mismatch');

    mockState.match = { matched: true, product: { id: 'p-nosize', name: 'No Size Product', container_size: null } };
    const needsSize = await processReceiptLine({ email, orderNumber: '200-0000000-0000000', item: { title: 'No Size Product', quantity: 1 }, lineNo: 2 });
    expect(needsSize.status).toBe('needs_size');

    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockUpdateRestockRequest).not.toHaveBeenCalled();
  });
});
