/**
 * purchase-receipts/receipt-processor.js — classification (match + title
 * sizing against the catalog container) and idempotent writes through the
 * EXISTING adjustStock path (inventory-operations.js).
 *
 * product-costing's parsePackSize and inventory-units' convertInventoryQuantity
 * run for REAL here — only the product match and the DB/inventory-operations
 * boundary are mocked. The duplicate-receipt guard's SQL (time windows,
 * NULL-safe source) runs against Postgres in purchase-receipts-postgres.test.js;
 * here its result is stubbed.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { match: { matched: false, reason: 'unmatched' }, adjustResult: null, adjustError: null, claimUpdateError: null };

jest.mock('../services/purchase-receipts/product-matcher', () => ({
  matchTitleToProduct: jest.fn(async () => mockState.match),
}));
const mockAdjustStock = jest.fn(async () => {
  if (mockState.adjustError) throw mockState.adjustError;
  return mockState.adjustResult;
});
jest.mock('../services/inventory-operations', () => ({
  adjustStock: (...args) => mockAdjustStock(...args),
}));

// lines: purchase_receipt_lines keyed vendor|order|shipment|line.
// duplicateMovement / liveRequest: what the ledger and restock-request
// reads return. Neither of those tables' mocks has a write method, so any
// write to them would throw.
const mockDbState = { lines: {}, duplicateMovement: undefined, liveRequest: undefined, lockedProducts: [] };
jest.mock('../models/db', () => {
  const readOnly = (result) => {
    const q = {};
    q.where = () => q;
    q.whereIn = () => q;
    q.first = async () => result();
    return q;
  };
  const fn = (table) => {
    if (table === 'product_inventory_movements') return readOnly(() => mockDbState.duplicateMovement);
    if (table === 'product_restock_requests') return readOnly(() => mockDbState.liveRequest);
    const q = {};
    q.where = (cond) => { q._cond = cond; return q; };
    if (table === 'products_catalog') {
      q.forUpdate = () => q;
      q.first = async () => { mockDbState.lockedProducts.push(q._cond.id); return { id: q._cond.id }; };
      return q;
    }
    // By full key, or (the hand-off check) by vendor + shipment + a status list.
    q.whereIn = (_column, statuses) => { q._statuses = statuses; return q; };
    q.first = async () => (q._statuses
      ? Object.values(mockDbState.lines).find((l) => l.vendor === q._cond.vendor && l.shipment_key === q._cond.shipment_key && q._statuses.includes(l.status))
      : mockDbState.lines[`${q._cond.vendor}|${q._cond.order_number}|${q._cond.shipment_key}|${q._cond.line_no}`]);
    q.insert = (row) => {
      const res = {
        onConflict: () => res,
        ignore: () => res,
        returning: async () => {
          const key = `${row.vendor}|${row.order_number}|${row.shipment_key}|${row.line_no}`;
          if (mockDbState.lines[key]) return [];
          const saved = { id: `line-${Object.keys(mockDbState.lines).length + 1}`, ...row };
          mockDbState.lines[key] = saved;
          return [saved];
        },
      };
      return res;
    };
    q.update = async (fields) => {
      if (mockState.claimUpdateError && fields.movement_id !== undefined) throw mockState.claimUpdateError;
      const found = Object.values(mockDbState.lines).find((l) => l.id === q._cond?.id);
      if (found) Object.assign(found, fields);
      return found ? 1 : 0;
    };
    return q;
  };
  const mockDb = jest.fn(fn);
  mockDb.raw = jest.fn(async () => ({})); // lockShipment's advisory lock
  // A callback that throws restores purchase_receipt_lines to its
  // pre-transaction state, as a real ROLLBACK would undo the claim insert.
  mockDb.transaction = async (cb) => {
    const snapshot = JSON.parse(JSON.stringify(mockDbState.lines));
    try {
      return await cb(mockDb);
    } catch (err) {
      mockDbState.lines = snapshot;
      throw err;
    }
  };
  return mockDb;
});

const { processReceiptLine, classifyItem } = require('../services/purchase-receipts/receipt-processor');
const { matchTitleToProduct } = require('../services/purchase-receipts/product-matcher');

const taurus = { id: 'p-taurus', name: 'Taurus SC', container_size: '78 fl oz', inventory_unit: 'fl_oz' };
const product = (containerSize) => ({ id: 'p-x', name: 'Product X', container_size: containerSize });

beforeEach(() => {
  mockState.match = { matched: false, reason: 'unmatched' };
  mockState.adjustResult = { movement: { id: 'mv-1' }, product: taurus };
  mockState.adjustError = null;
  mockState.claimUpdateError = null;
  mockDbState.lines = {};
  mockDbState.duplicateMovement = undefined;
  mockDbState.liveRequest = undefined;
  mockDbState.lockedProducts = [];
  mockAdjustStock.mockClear();
  matchTitleToProduct.mockClear();
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

  test('title size disagrees with container_size -> size_mismatch, nothing computed', async () => {
    mockState.match = { matched: true, product: taurus };
    const result = await classifyItem({ title: 'Control Solutions Taurus SC Termiticide 96 oz', quantity: 1 });
    expect(result).toEqual({ status: 'size_mismatch', productId: 'p-taurus', product: taurus });
  });

  test('an ambiguous "oz" title size standing in for the product\'s fl_oz dimension -> logged', async () => {
    mockState.match = { matched: true, product: taurus };
    const result = await classifyItem({ title: 'Control Solutions Taurus SC Termiticide 78 oz', quantity: 2 });
    expect(result).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz' });
  });

  test('no readable size: an exact alias (owner-vetted title) logs from container_size; a name-containment match is held', async () => {
    mockState.match = { matched: true, product: taurus, matchType: 'alias' };
    expect(await classifyItem({ title: 'Taurus SC Termiticide', quantity: 1 }))
      .toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty: 78, receivedUnit: 'fl_oz' });
    mockState.match = { matched: true, product: taurus, matchType: 'containment' };
    expect(await classifyItem({ title: 'Taurus SC Termiticide', quantity: 1 })).toMatchObject({ status: 'size_mismatch' });
  });

  test('a weight container (lb) agrees with an "oz" title amount converted through the product\'s own dimension', async () => {
    const granular = { id: 'p-gran', name: 'Granular Bait', container_size: '1 lb' };
    mockState.match = { matched: true, product: granular };
    const result = await classifyItem({ title: 'Granular Bait 16 oz Bag', quantity: 1 });
    expect(result).toEqual({ status: 'logged', productId: 'p-gran', product: granular, receivedQty: 1, receivedUnit: 'lb' });
  });
});

describe('classifyItem — reading the title\'s own size', () => {
  const logged = async (title, containerSize, quantity = 1) => {
    mockState.match = { matched: true, product: product(containerSize) };
    return classifyItem({ title, quantity });
  };

  test.each([
    'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96 oz) – Indoor and Outdoor Insect Control',
    'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)',
  ])('real Talak title reads 96 oz, never the "7.9 F" formulation: %s', async (title) => {
    expect(await logged(title, '96 fl oz')).toMatchObject({ status: 'logged', receivedQty: 96, receivedUnit: 'fl_oz' });
  });

  test('a fraction mid-title is read as a fraction: "Taurus SC 1/2 gal" is 64 fl oz, never 2 gal', async () => {
    expect(await logged('Taurus SC 1/2 gal', '64 fl oz')).toMatchObject({ status: 'logged', receivedQty: 64 });
    expect(await logged('Taurus SC 1/2 gal', '78 fl oz')).toMatchObject({ status: 'size_mismatch' });
  });

  test('a mixed number: "1 1/2 lb" is 1.5 lb', async () => {
    expect(await logged('Granular Bait 1 1/2 lb', '1.5 lb')).toMatchObject({ status: 'logged', receivedQty: 1.5, receivedUnit: 'lb' });
  });

  test('a bare unit word with no number is not a second size ("16oz - Pint")', async () => {
    expect(await logged('Southern Ag Thuricide BT Caterpillar Control, 16oz - Pint', '16 fl oz')).toMatchObject({ status: 'logged', receivedQty: 16 });
  });

  test('a hyphenated size is still read: "2.5-Gallon" against a 78 fl oz container -> size_mismatch', async () => {
    expect(await logged('Taurus SC 2.5-Gallon', '78 fl oz')).toMatchObject({ status: 'size_mismatch' });
  });

  test('one size given in two units is one size: "1 Gallon (128 fl oz)"', async () => {
    expect(await logged('Bifen I/T 1 Gallon (128 fl oz)', '1 gal')).toMatchObject({ status: 'logged', receivedQty: 1, receivedUnit: 'gal' });
  });

  test('two different sizes -> size_mismatch (never pick one)', async () => {
    expect(await logged('Taurus SC 10 oz and 32 oz', '32 fl oz')).toMatchObject({ status: 'size_mismatch' });
  });

  test('a size the container can\'t be compared with (weight vs volume) -> size_mismatch', async () => {
    expect(await logged('Gentrol IGR 1 lb', '16 fl oz')).toMatchObject({ status: 'size_mismatch' });
  });

  test('model numbers are not sizes: the real Gentrol title, once aliased, logs from the container', async () => {
    mockState.match = { matched: true, product: product('16 fl oz'), matchType: 'alias' };
    expect(await classifyItem({ title: 'ZOECON 10578 Gentrol Complete EC3 Insecticide and Growth Regulator, Orange', quantity: 1 }))
      .toMatchObject({ status: 'logged', receivedQty: 16 });
  });

  test.each([
    ['Taurus SC 32-fl-oz', 'size_mismatch'], // hyphenated two-word unit is read (32 fl oz)
    ['Taurus SC 500 cc', 'size_mismatch'], // cc is read as ml (16.9 fl oz)
    ['Taurus SC 78-fl-oz', 'logged'],
    ['Taurus SC 2307 cc', 'logged'], // 2307 ml is 78 fl oz
    ['Taurus SC 2.3 dm3', 'size_mismatch'], // an unknown unit is never read as "no size"
  ])('%s against a 78 fl oz container -> %s', async (title, status) => {
    expect(await logged(title, '78 fl oz')).toMatchObject({ status });
  });
});

describe('classifyItem — SiteOne invoice descriptions', () => {
  beforeEach(() => { mockState.match = { matched: true, product: taurus }; });

  test.each([
    ['CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY) UOM:EA EPA# - 53883-279'],
    ['CSI-PEST TAURUS SC BROAD SPECTRUM LIQUID CONCENTRATE TERMITICIDE/INSECTICIDE 78 FL OZ. BOTTLE (QGCY)'],
    ['Taurus SC Insecticide 78 oz. (QGCY) EPA# - 53883-279'],
  ])('real description reads 78 fl oz (EPA and item codes are not sizes): %s', async (title) => {
    expect(await classifyItem({ title, quantity: 2 })).toMatchObject({ status: 'logged', receivedQty: 156, receivedUnit: 'fl_oz' });
  });

  test('a unit of measure other than EA (a case) is a pack claim -> size_mismatch', async () => {
    expect(await classifyItem({ title: 'CSI-Pest Taurus SC 78 fl oz. Bottle (QGCY) UOM:CS', quantity: 1 })).toMatchObject({ status: 'size_mismatch' });
  });
});

describe('classifyItem — pack markers', () => {
  beforeEach(() => { mockState.match = { matched: true, product: taurus }; });

  test.each([
    ['Taurus SC 2 x 78 oz', 156],
    ['Taurus SC 2 × 78 oz', 156],
    ['Taurus SC Termiticide 78 oz (Pack of 2)', 156],
    ['Taurus SC Termiticide 78 oz Pack of 2', 156],
    ['Taurus SC Termiticide 78 oz 2-Pack', 156],
    ['Taurus SC Termiticide 78 oz 2 Pack', 156],
    ['Taurus SC Termiticide 78 oz Case of 2', 156],
    ['Taurus SC Termiticide 78 oz Set of 2', 156],
    ['2 x 78 oz Taurus SC', 156], // leading marker: counted once, not twice
  ])('%s -> %d fl oz', async (title, receivedQty) => {
    expect(await classifyItem({ title, quantity: 1 })).toEqual({ status: 'logged', productId: 'p-taurus', product: taurus, receivedQty, receivedUnit: 'fl_oz' });
  });

  test('the order quantity multiplies on top of the pack (3 ordered, each a 2 x 78 oz)', async () => {
    expect((await classifyItem({ title: 'Taurus SC 2 x 78 oz', quantity: 3 })).receivedQty).toBe(468);
    expect((await classifyItem({ title: '2 x 78 oz Taurus SC', quantity: 3 })).receivedQty).toBe(468);
  });

  test.each([
    ['Bifen I/T, 2 x 1 gal bottles'],
    ['Pack of 2, 1 gal bottles'],
  ])('a pack count after the product name is counted: %s -> 2 gal', async (title) => {
    const bifen = product('1 gal');
    mockState.match = { matched: true, product: bifen };
    expect(await classifyItem({ title, quantity: 1 })).toEqual({ status: 'logged', productId: 'p-x', product: bifen, receivedQty: 2, receivedUnit: 'gal' });
  });

  test.each([
    ['Taurus SC 2 x 78 oz'],
    ['Taurus SC 78 oz (Pack of 2)'],
  ])('a container that is already the whole pack is not multiplied again: %s against 156 fl oz', async (title) => {
    const bulk = { ...taurus, container_size: '156 fl oz' };
    mockState.match = { matched: true, product: bulk };
    expect(await classifyItem({ title, quantity: 1 })).toMatchObject({ status: 'logged', receivedQty: 156 });
  });

  test('neither the per-unit size nor the pack total matches the container -> size_mismatch', async () => {
    expect(await classifyItem({ title: 'Taurus SC 2 x 50 oz', quantity: 1 })).toMatchObject({ status: 'size_mismatch' });
  });

  test('a pack marker with no per-unit size -> size_mismatch', async () => {
    expect(await classifyItem({ title: 'Taurus SC Termiticide (Pack of 2)', quantity: 1 })).toMatchObject({ status: 'size_mismatch' });
  });

  // A unit count this lane can't read is held for a person, never logged
  // as a single container.
  test.each([
    ['Taurus SC 78 oz, Twin Pack'],
    ['Taurus SC 78 oz, Pack of Two'],
    ['Taurus SC 78 oz, 2 Count'],
    ['Taurus SC 78 oz 2ct'],
    ['Taurus SC 78 oz 2pk'],
    ['Taurus SC 78 oz x 2'],
    ['Taurus SC 78 oz (2) Bottles'],
    ['Taurus SC 78 oz, 2 Bottles'],
    ['Taurus SC 2 x 78 oz (Pack of 2)'],
    ['Taurus SC 78 oz Bundle'],
  ])('unreadable or doubled pack wording -> size_mismatch: %s', async (title) => {
    expect(await classifyItem({ title, quantity: 1 })).toMatchObject({ status: 'size_mismatch', productId: 'p-taurus' });
  });

  test('"4 tubes / 30 g" against a "4 x 30g tubes" container -> size_mismatch, never 30 g', async () => {
    mockState.match = { matched: true, product: product('4 x 30g tubes') };
    expect(await classifyItem({ title: 'Advion Cockroach Gel Bait 4 tubes / 30 g', quantity: 1 })).toMatchObject({ status: 'size_mismatch' });
  });
});

describe('processReceiptLine', () => {
  const email = { id: 'email-1', received_at: new Date('2026-09-27T15:00:00Z') };
  const taurusLine = (overrides = {}) => ({
    vendor: 'amazon', email, orderNumber: '900-1000001-1000001', shipmentKey: 'ship-1', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 2 }, lineNo: 1, ...overrides,
  });
  const lineId = expect.stringMatching(/^line-/);

  test('unmatched item: inserts a purchase_receipt_lines row, never touches inventory-operations', async () => {
    const outcome = await processReceiptLine({ vendor: 'amazon', email, orderNumber: '900-5000005-5000005', shipmentKey: 'ship-1', item: { title: 'Chromebook', quantity: 1 }, lineNo: 1 });
    expect(outcome).toEqual({ status: 'unmatched', inserted: true, product: null, lineId });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockDbState.lockedProducts).toEqual([]);
    expect(mockDbState.lines['amazon|900-5000005-5000005|ship-1|1']).toMatchObject({ status: 'unmatched', product_id: null, received_qty: null });
  });

  test('logged item: locks the product, calls adjustStock with the amount + provenance, records the movement', async () => {
    mockState.match = { matched: true, product: taurus };
    const outcome = await processReceiptLine(taurusLine());
    expect(outcome).toEqual({ status: 'logged', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz', movement: { id: 'mv-1' }, hasOpenRestockRequest: false, lineId });
    expect(mockDbState.lockedProducts).toEqual(['p-taurus']);
    expect(mockAdjustStock).toHaveBeenCalledWith('p-taurus',
      { movementType: 'restock', quantity: 156, unit: 'fl_oz' },
      expect.objectContaining({ source: 'amazon_delivery', extraMetadata: { orderNumber: '900-1000001-1000001', emailId: 'email-1', rawTitle: 'Taurus SC Termiticide 78 oz' } }));
    expect(mockDbState.lines['amazon|900-1000001-1000001|ship-1|1']).toMatchObject({ status: 'logged', movement_id: 'mv-1', received_qty: 156, received_unit: 'fl_oz' });
  });

  test('the bell is rung once, on the line\'s own transaction, with the recorded line id', async () => {
    mockState.match = { matched: true, product: taurus };
    const ringBell = jest.fn(async () => {});
    const outcome = await processReceiptLine(taurusLine({ ringBell }));
    expect(ringBell).toHaveBeenCalledTimes(1);
    expect(ringBell.mock.calls[0][0]).toMatchObject({ status: 'logged', lineId: outcome.lineId });
    expect(ringBell.mock.calls[0][1]).toBe(require('../models/db')); // the mocked transaction handle
  });

  test('a bell that can\'t be saved rolls the whole line back (claim and movement), so the next sweep retries it', async () => {
    mockState.match = { matched: true, product: taurus };
    const failing = jest.fn(async () => { throw new Error('admin notification insert failed'); });
    await expect(processReceiptLine(taurusLine({ ringBell: failing }))).rejects.toThrow('admin notification insert failed');
    expect(mockDbState.lines['amazon|900-1000001-1000001|ship-1|1']).toBeUndefined();
    expect((await processReceiptLine(taurusLine())).status).toBe('logged');
  });

  test('a container_size edit committed before the lock is what counts: re-read under the lock -> size_mismatch, no movement', async () => {
    matchTitleToProduct
      .mockResolvedValueOnce({ matched: true, product: taurus }) // first read: 78 fl oz
      .mockResolvedValueOnce({ matched: true, product: { ...taurus, container_size: '96 fl oz' } }); // under the lock
    const outcome = await processReceiptLine(taurusLine());
    expect(outcome).toMatchObject({ status: 'size_mismatch', inserted: true });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockDbState.lines['amazon|900-1000001-1000001|ship-1|1']).toMatchObject({ status: 'size_mismatch', received_qty: null });
  });

  test('a different product matching under the lock aborts the line (its row isn\'t locked); nothing is recorded', async () => {
    matchTitleToProduct
      .mockResolvedValueOnce({ matched: true, product: taurus })
      .mockResolvedValueOnce({ matched: true, product: { ...taurus, id: 'p-other' } });
    await expect(processReceiptLine(taurusLine())).rejects.toThrow(/matched product changed/);
    expect(Object.keys(mockDbState.lines)).toHaveLength(0);
    expect(mockAdjustStock).not.toHaveBeenCalled();
  });

  test('a live restock request is reported for the bell and never written', async () => {
    mockState.match = { matched: true, product: taurus };
    mockDbState.liveRequest = { id: 'req-open' };
    const outcome = await processReceiptLine(taurusLine());
    expect(outcome).toMatchObject({ status: 'logged', hasOpenRestockRequest: true });
    expect(mockAdjustStock).toHaveBeenCalledTimes(1);
  });

  test('a possible duplicate on the ledger holds the line: no movement, status possible_duplicate, amount kept', async () => {
    mockState.match = { matched: true, product: taurus };
    mockDbState.duplicateMovement = { id: 'mv-manual' };
    const outcome = await processReceiptLine(taurusLine());
    expect(outcome).toEqual({ status: 'possible_duplicate', product: taurus, receivedQty: 156, receivedUnit: 'fl_oz', lineId });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    const saved = mockDbState.lines['amazon|900-1000001-1000001|ship-1|1'];
    expect(saved).toMatchObject({ status: 'possible_duplicate', received_qty: 156, received_unit: 'fl_oz' });
    expect(saved.movement_id).toBeUndefined();
  });

  test('holdAs: a line that would move stock is held under the caller\'s status; no readable Order # keys as "unknown"', async () => {
    mockState.match = { matched: true, product: taurus };
    const outcome = await processReceiptLine(taurusLine({ orderNumber: null, holdAs: 'no_order_number' }));
    expect(outcome).toEqual({ status: 'no_order_number', inserted: true, product: taurus, lineId });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(mockDbState.lines['amazon|unknown|ship-1|1']).toMatchObject({ status: 'no_order_number', product_id: 'p-taurus' });
    expect(await processReceiptLine(taurusLine({ orderNumber: null, holdAs: 'no_order_number' }))).toEqual({ skipped: true, reason: 'already_processed' });
  });

  test('holdAs never touches an unmatched line (no hold, no bell)', async () => {
    const outcome = await processReceiptLine(taurusLine({ holdAs: 'returned', item: { title: 'Chromebook', quantity: -1 } }));
    expect(outcome).toMatchObject({ status: 'unmatched' });
  });

  test('a SiteOne line keys and writes under its own vendor and movement source', async () => {
    mockState.match = { matched: true, product: taurus };
    const siteOneLine = { vendor: 'siteone', email, orderNumber: '900000001-001', shipmentKey: '900000001-001', lineNo: 1,
      item: { title: 'CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY) UOM:EA EPA# - 53883-279', quantity: 1 } };
    expect(await processReceiptLine(siteOneLine)).toMatchObject({ status: 'logged', receivedQty: 78 });
    expect(mockAdjustStock).toHaveBeenCalledWith('p-taurus', expect.anything(), expect.objectContaining({ source: 'siteone_invoice' }));
    expect(mockDbState.lines['siteone|900000001-001|900000001-001|1']).toMatchObject({ status: 'logged' });
  });

  test('idempotency: the same (order, shipment, line) twice logs once', async () => {
    mockState.match = { matched: true, product: taurus };
    const first = await processReceiptLine(taurusLine());
    const second = await processReceiptLine(taurusLine());
    expect(first.status).toBe('logged');
    expect(second).toEqual({ skipped: true, reason: 'already_processed' });
    expect(mockAdjustStock).toHaveBeenCalledTimes(1);
  });

  test('split shipment: SAME order, DIFFERENT shipmentKey -> both shipments log', async () => {
    mockState.match = { matched: true, product: taurus };
    const one = await processReceiptLine(taurusLine({ orderNumber: '900-4000004-4000004', shipmentKey: 'ship-one', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 4 } }));
    const two = await processReceiptLine(taurusLine({ email: { ...email, id: 'email-2' }, orderNumber: '900-4000004-4000004', shipmentKey: 'ship-two', item: { title: 'Taurus SC Termiticide 78 oz', quantity: 3 } }));
    expect([one.status, two.status]).toEqual(['logged', 'logged']);
    expect(mockAdjustStock).toHaveBeenCalledTimes(2);
  });

  test('every line takes its shipment\'s advisory lock', async () => {
    mockState.match = { matched: true, product: taurus };
    await processReceiptLine(taurusLine());
    expect(require('../models/db').raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['purchase-receipt-shipment:amazon:ship-1']);
  });

  test('an invoice handed to a person as unreadable never auto-logs lines read later', async () => {
    mockState.match = { matched: true, product: taurus };
    mockDbState.lines['siteone|900000001-001|900000001-001|1'] = { id: 'line-unreadable', vendor: 'siteone', shipment_key: '900000001-001', status: 'unreadable' };
    const late = { vendor: 'siteone', email, orderNumber: '900000001-001', shipmentKey: '900000001-001', lineNo: 2, item: { title: 'Taurus SC 78 fl oz. Bottle', quantity: 1 } };
    expect(await processReceiptLine(late)).toEqual({ skipped: true, reason: 'asked_to_log_by_hand' });
    expect(mockAdjustStock).not.toHaveBeenCalled();
  });

  test('a shipment already handed to a person (no_delivery_email) is never auto-logged by its late Delivered email', async () => {
    mockState.match = { matched: true, product: taurus };
    mockDbState.lines['amazon|900-1000001-1000001|ship-1|7'] = { id: 'line-alert', vendor: 'amazon', shipment_key: 'ship-1', status: 'no_delivery_email' };
    expect(await processReceiptLine(taurusLine())).toEqual({ skipped: true, reason: 'asked_to_log_by_hand' });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(Object.keys(mockDbState.lines)).toEqual(['amazon|900-1000001-1000001|ship-1|7']);
  });

  test('no shipment key -> skipped, nothing inserted', async () => {
    expect(await processReceiptLine(taurusLine({ shipmentKey: null }))).toEqual({ skipped: true, reason: 'no_shipment_key' });
    expect(Object.keys(mockDbState.lines)).toHaveLength(0);
  });

  test('adjustStock throwing rolls back the WHOLE transaction — no claim row remains, a re-run logs once', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.adjustError = new Error('DB unavailable');
    await expect(processReceiptLine(taurusLine())).rejects.toThrow('DB unavailable');
    expect(mockDbState.lines['amazon|900-1000001-1000001|ship-1|1']).toBeUndefined();
    mockState.adjustError = null;
    expect((await processReceiptLine(taurusLine())).status).toBe('logged');
    expect(mockAdjustStock).toHaveBeenCalledTimes(2);
  });

  test('the claim\'s movement_id update throwing rolls back too', async () => {
    mockState.match = { matched: true, product: taurus };
    mockState.claimUpdateError = new Error('update failed');
    await expect(processReceiptLine(taurusLine())).rejects.toThrow('update failed');
    expect(mockDbState.lines['amazon|900-1000001-1000001|ship-1|1']).toBeUndefined();
    mockState.claimUpdateError = null;
    expect((await processReceiptLine(taurusLine())).status).toBe('logged');
  });

  test('size_mismatch and needs_size lines are inserted with no inventory-operations call', async () => {
    mockState.match = { matched: true, product: taurus };
    const mismatch = await processReceiptLine(taurusLine({ item: { title: 'Taurus SC Termiticide 96 oz', quantity: 1 } }));
    expect(mismatch).toEqual({ status: 'size_mismatch', inserted: true, product: taurus, lineId });

    const noSize = { id: 'p-nosize', name: 'No Size Product', container_size: null };
    mockState.match = { matched: true, product: noSize };
    const needsSize = await processReceiptLine(taurusLine({ item: { title: 'No Size Product', quantity: 1 }, lineNo: 2 }));
    expect(needsSize).toEqual({ status: 'needs_size', inserted: true, product: noSize, lineId });
    expect(mockAdjustStock).not.toHaveBeenCalled();
  });

  test('forcedStatus "no_items": one placeholder row, no matching, no inventory-operations call', async () => {
    const outcome = await processReceiptLine({
      vendor: 'amazon', email, orderNumber: '900-6000006-6000006', shipmentKey: 'ship-1',
      item: { title: 'Delivered: 1 Lawn & Garden item', quantity: 1 }, lineNo: 1, forcedStatus: 'no_items',
    });
    expect(outcome).toEqual({ status: 'no_items', inserted: true, product: null, lineId });
    expect(mockDbState.lines['amazon|900-6000006-6000006|ship-1|1']).toMatchObject({ status: 'no_items', product_id: null, raw_title: 'Delivered: 1 Lawn & Garden item' });
    expect(mockAdjustStock).not.toHaveBeenCalled();
    expect(matchTitleToProduct).not.toHaveBeenCalled();
  });
});
