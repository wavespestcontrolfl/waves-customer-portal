// GATE_PEST_STOCK_ADVISORY (owner 2026-10-20, "dont block"): a pest visit's completion may take a product's stock
// below zero instead of refusing it, and the office gets one alert per product while it stays below zero. The
// PostgreSQL proofs (a real pest packet; a restock closing the alert) are in visit-completion-packets-postgres.test.js
// and purchase-receipts-postgres.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'alert-1' })),
}));

const compose = require('../services/admin-alert-compose');
const logger = require('../services/logger');
const {
  deductProductInventory, isPestStockAdvisoryCompletion, isStockAdvisoryCompletion, notifyOfficeOfStockShortfalls,
} = require('../services/complete-scheduled-service');

const GATE = 'GATE_PEST_STOCK_ADVISORY';
const savedGate = process.env[GATE];
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  jest.clearAllMocks();
});

describe('which completions may take stock below zero', () => {
  test.each(['Quarterly Pest Control', 'Pest Control Re-Service', 'Pest & Rodent Control'])('gate on: %s may', (serviceType) => {
    process.env[GATE] = 'true';
    expect(isPestStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
    expect(isStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
  });

  test.each(['Lawn Care', 'Tree & Shrub Care', 'Mosquito Control', 'Termite Bait Station'])('gate on: %s may not', (serviceType) => {
    process.env[GATE] = 'true';
    expect(isPestStockAdvisoryCompletion({ service_type: serviceType })).toBe(false);
    expect(isStockAdvisoryCompletion({ service_type: serviceType })).toBe(false);
  });

  test.each([[undefined], ['TRUE'], ['1']])('gate %s: a pest visit may not', (value) => {
    if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
    expect(isStockAdvisoryCompletion({ service_type: 'Quarterly Pest Control' })).toBe(false);
  });

  test('a WaveGuard lawn completion stays advisory with the gate off', () => {
    delete process.env[GATE];
    expect(isStockAdvisoryCompletion({ service_type: 'Lawn Care', cust_waveguard_tier: 'Gold' })).toBe(true);
  });
});

describe('the deduction a pest visit now makes with allowNegative', () => {
  // The row lock finds no row, so the deduction uses the passed-in product; the writes are recorded.
  const fakeTrx = () => {
    const writes = [];
    const trx = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => null }),
        update: async (row) => { writes.push({ table, update: row }); return 1; },
      }),
      insert: (row) => ({ returning: async () => { writes.push({ table, insert: row }); return [{ id: 'movement-1', ...row }]; } }),
    });
    trx.writes = writes;
    return trx;
  };
  const args = {
    product: { id: 'product-1', name: 'Taurus SC', inventory_on_hand: '1', inventory_unit: 'fl_oz' },
    productInput: { totalAmount: 4, amountUnit: 'fl_oz' },
    serviceProduct: { id: 'service-product-1' },
    serviceRecord: { id: 'record-1' },
    scheduledService: { id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1' },
  };

  test('goes below zero and records the shortfall instead of refusing', async () => {
    const trx = fakeTrx();
    const result = await deductProductInventory(trx, { ...args, allowNegative: true });
    expect(result).toMatchObject({ status: 'deducted_insufficient_stock', stockBefore: 1, stockAfter: -3, deductedAmount: 4, inventoryUnit: 'fl_oz' });
    expect(trx.writes).toEqual([
      { table: 'products_catalog', update: expect.objectContaining({ inventory_on_hand: -3 }) },
      { table: 'product_inventory_movements', insert: expect.objectContaining({ stock_before: 1, stock_after: -3, metadata: expect.objectContaining({ insufficientStock: true }) }) },
    ]);
  });

  test('without it the same deduction is still refused, and nothing is written', async () => {
    const trx = fakeTrx();
    await expect(deductProductInventory(trx, args)).rejects.toMatchObject({ statusCode: 400, code: 'waveguard_inventory_lockout' });
    expect(trx.writes).toEqual([]);
  });
});

describe('the office alert for a product a pest visit took below zero', () => {
  const svc = { id: 'visit-1', customer_id: 'customer-1', service_type: 'Quarterly Pest Control' };
  const shortfall = (productId, productName, stockAfter = -3) => ({
    productId, productName, status: 'deducted_insufficient_stock', stockAfter, deductedAmount: 4, inventoryUnit: 'fl_oz',
  });
  const record = (deductions) => ({ id: 'record-1', structured_notes: { inventoryDeductions: deductions } });
  // Each product's live count, read under its row lock inside the alert's own transaction: the counts it returns,
  // the locked reads it was asked for, and the transaction the alert must ride.
  const catalog = (stockById) => {
    const reads = [];
    const trx = (table) => ({
      where: ({ id }) => ({
        forUpdate: () => ({ first: async () => { reads.push({ table, id, locked: true }); return id in stockById ? { inventory_on_hand: stockById[id] } : undefined; } }),
      }),
    });
    const database = { transaction: jest.fn(async (work) => work(trx)), reads, trx };
    return database;
  };

  test('one alert for each product still below zero, keyed by the product, deduped on an open row only', async () => {
    const database = catalog({ taurus: '-3.0000' });
    await notifyOfficeOfStockShortfalls({ svc, record: record([shortfall('taurus', 'Taurus SC')]), database });
    expect(database.reads).toEqual([{ table: 'products_catalog', id: 'taurus', locked: true }]);
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('inventory');
    expect(spec).toEqual({
      area: 'Inventory',
      action: 'restock Taurus SC',
      why: 'Taurus SC went below zero in stock after a pest visit.',
      severity: 'needs-you',
      who: 'person',
      link: '/admin/inventory?tab=products&search=Taurus%20SC&productId=taurus',
      subject: { type: 'check', id: 'stock-shortfall:taurus' },
      doneWhen: 'stock_restocked',
    });
    // The insert rides the transaction that holds the product's row lock, so a restock cannot land in between.
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'stock-shortfall:taurus', dedupeOpenOnly: true });
    expect(opts.trx).toBe(database.trx);
    expect(opts.metadata).toMatchObject({ productId: 'taurus', scheduledServiceId: 'visit-1', serviceRecordId: 'record-1', stockAfter: -3 });
    expect(opts.detail).toBe('Taurus SC went to -3 fl oz on hand after a pest visit used 4 fl oz. Restock it, or fix the count if the shelf has more.');
    // The alert rules accept it as composed (raiseAdminAlert is stood in here).
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('a product back to zero or above, and a row that did not go short, get none', async () => {
    const database = catalog({ taurus: '0.0000' });
    const deductions = [shortfall('taurus', 'Taurus SC'), { productId: 'talak', productName: 'Talak', status: 'deducted', stockAfter: 12 }];
    await notifyOfficeOfStockShortfalls({ svc, record: record(deductions), database });
    expect(database.reads).toEqual([{ table: 'products_catalog', id: 'taurus', locked: true }]);
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('saved notes stored as text are read the same way', async () => {
    const database = catalog({ taurus: '-3' });
    const textNotes = { id: 'record-1', structured_notes: JSON.stringify({ inventoryDeductions: [shortfall('taurus', 'Taurus SC')] }) };
    await notifyOfficeOfStockShortfalls({ svc, record: textNotes, database });
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a name the alert rules refuse falls back to plain words; the detail keeps it whole', async () => {
    const database = catalog({ odd: '-1' });
    await notifyOfficeOfStockShortfalls({ svc, record: record([shortfall('odd', 'Bait [old lot]', -1)]), database });
    const [, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ action: 'restock a product', why: 'A product went below zero in stock after a pest visit.' });
    expect(opts.detail).toContain('Bait [old lot] went to -1 fl oz on hand');
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('no shortfall: no transaction, nothing read, nothing raised', async () => {
    const database = catalog({});
    await notifyOfficeOfStockShortfalls({ svc, record: record([]), database });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.reads).toEqual([]);
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a failed alert is logged and never fails the visit', async () => {
    compose.raiseAdminAlert.mockRejectedValueOnce(new Error('notifications unavailable'));
    const database = catalog({ taurus: '-3' });
    await expect(notifyOfficeOfStockShortfalls({ svc, record: record([shortfall('taurus', 'Taurus SC')]), database })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stock shortfall alert failed (non-blocking)'));
  });
});
