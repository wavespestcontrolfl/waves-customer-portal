// Owner 2026-10-20, "dont block": a pest visit's completion may take a product's stock
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
  deductProductInventory, isPestStockAdvisoryCompletion, isLawnTsStockAdvisoryCompletion, isStockAdvisoryCompletion, notifyOfficeOfStockShortfalls,
} = require('../services/complete-scheduled-service');

afterEach(() => {
  jest.clearAllMocks();
});

describe('which completions may take stock below zero', () => {
  test.each(['Quarterly Pest Control', 'Pest Control Re-Service', 'Pest & Rodent Control'])('%s may', (serviceType) => {
    expect(isPestStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
    expect(isStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
  });

  test.each(['Lawn Care', 'Lawn Care Re-Service', 'Tree & Shrub Care', 'Shrub Fertilization'])('a lawn or tree & shrub visit, any tier: %s may', (serviceType) => {
    expect(isLawnTsStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
    expect(isStockAdvisoryCompletion({ service_type: serviceType })).toBe(true);
    expect(isStockAdvisoryCompletion({ service_type: serviceType, cust_waveguard_tier: 'Commercial' })).toBe(true);
  });

  test('a WaveGuard lawn completion may', () => {
    expect(isStockAdvisoryCompletion({ service_type: 'Lawn Care', cust_waveguard_tier: 'Gold' })).toBe(true);
  });

  test.each(['Palm Injection', 'Mosquito Control', 'Termite Bait Station', 'Rodent Exclusion'])('%s may not', (serviceType) => {
    expect(isPestStockAdvisoryCompletion({ service_type: serviceType })).toBe(false);
    expect(isLawnTsStockAdvisoryCompletion({ service_type: serviceType })).toBe(false);
    expect(isStockAdvisoryCompletion({ service_type: serviceType })).toBe(false);
  });
});

describe('the deduction a pest visit now makes with allowNegative', () => {
  // The row lock finds no row, so the deduction uses the passed-in product; the writes are recorded.
  // Every history-style read the helper makes is recorded in trx.reads (the limit is fixed, so there are none).
  const fakeTrx = (history = []) => {
    const writes = [];
    const reads = [];
    const trx = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => null }),
        update: async (row) => { writes.push({ table, update: row }); return 1; },
        where: (...since) => ({ select: async () => { reads.push({ table, since }); return history; } }),
      }),
      insert: (row) => ({ returning: async () => { writes.push({ table, insert: row }); return [{ id: 'movement-1', ...row }]; } }),
    });
    trx.writes = writes;
    trx.reads = reads;
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

  describe('an amount no visit uses', () => {
    const overdraw = (productInput, product = args.product) => ({ ...args, product, productInput, allowNegative: true });
    const refusedWith = (result, trx) => {
      expect(trx.writes).toEqual([]);
      expect(result).toMatchObject({ status: 'not_deducted_implausible', productId: args.product.id, stockBefore: 1, remainingStock: 1 });
      expect(result.movementId).toBeUndefined();
      expect(result.costUsed).toBeUndefined();
    };

    describe('the fixed limit by unit dimension', () => {
      test.each([
        ['volume', { totalAmount: 641, amountUnit: 'fl_oz' }, 'fl_oz'],
        ['volume, the old flat ceiling', { totalAmount: 2560, amountUnit: 'fl_oz' }, 'fl_oz'],
        ['weight', { totalAmount: 101, amountUnit: 'lb' }, 'lb'],
        ['count', { totalAmount: 51, amountUnit: 'each' }, 'each'],
        ['weight sold in a different unit', { totalAmount: 101, amountUnit: 'lb' }, 'oz'],
        ['a million fl oz', { totalAmount: 1000000, amountUnit: 'fl_oz' }, 'fl_oz'],
      ])('%s over the floor moves no stock and no cost, and the completion goes on', async (_name, productInput, inventoryUnit) => {
        const trx = fakeTrx();
        const result = await deductProductInventory(trx, overdraw(productInput, { ...args.product, inventory_unit: inventoryUnit }));
        refusedWith(result, trx);
        expect(result.warning).toBe(`${productInput.totalAmount} ${productInput.amountUnit.replace('_', ' ')} of ${args.product.name} is too much for one visit, so stock was not changed. Check the amount.`);
      });

      test.each([
        ['volume', { totalAmount: 640, amountUnit: 'fl_oz' }, 'fl_oz', -639],
        ['weight', { totalAmount: 100, amountUnit: 'lb' }, 'lb', -99],
        ['count', { totalAmount: 50, amountUnit: 'each' }, 'each', -49],
        ['a bare oz stock takes the looser floor', { totalAmount: 1600, amountUnit: 'oz' }, 'oz', -1599],
      ])('%s at the floor is an ordinary overdraw', async (_name, productInput, inventoryUnit, stockAfter) => {
        const trx = fakeTrx();
        const result = await deductProductInventory(trx, overdraw(productInput, { ...args.product, inventory_unit: inventoryUnit }));
        expect(result).toMatchObject({ status: 'deducted_insufficient_stock', stockAfter });
        expect(trx.writes).toHaveLength(2);
      });

      test('a unit with no known dimension fails closed on the submitted number: over 50 is refused, 50 is an ordinary overdraw', async () => {
        const bags = { ...args.product, inventory_unit: 'bags' };
        const over = fakeTrx();
        refusedWith(await deductProductInventory(over, overdraw({ totalAmount: 1000000, amountUnit: 'bags' }, bags)), over);
        const at = fakeTrx();
        expect((await deductProductInventory(at, overdraw({ totalAmount: 50, amountUnit: 'bags' }, bags))).status).toBe('deducted_insufficient_stock');
      });

      test('a blank inventory unit in a per-area unit fails closed the same way', async () => {
        const blank = { ...args.product, inventory_unit: null };
        const over = fakeTrx();
        refusedWith(await deductProductInventory(over, overdraw({ totalAmount: 51, amountUnit: 'oz/1000sf' }, blank)), over);
        const at = fakeTrx();
        expect((await deductProductInventory(at, overdraw({ totalAmount: 50, amountUnit: 'oz/1000sf' }, blank))).status).toBe('deducted_insufficient_stock');
      });

      test('no usage history is read, so past usage cannot raise or lower the limit', async () => {
        const trx = fakeTrx();
        refusedWith(await deductProductInventory(trx, overdraw({ totalAmount: 641, amountUnit: 'fl_oz' })), trx);
        expect(trx.reads).toEqual([]);
      });
    });

    test('an amount the stock covers never reads the history', async () => {
      const trx = fakeTrx();
      const result = await deductProductInventory(trx, overdraw({ totalAmount: 3000, amountUnit: 'fl_oz' }, { ...args.product, inventory_on_hand: 9000 }));
      expect(result.status).toBe('deducted');
      expect(trx.reads).toEqual([]);
    });

    test('a visit that may not go negative keeps the hard refusal, whatever the size', async () => {
      const trx = fakeTrx();
      await expect(deductProductInventory(trx, { ...args, productInput: { totalAmount: 1000000, amountUnit: 'fl_oz' } }))
        .rejects.toMatchObject({ statusCode: 400, code: 'waveguard_inventory_lockout' });
      expect(trx.writes).toEqual([]);
      expect(trx.reads).toEqual([]);
    });
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

describe('the office alert for an amount no visit uses', () => {
  const refused = (over = {}) => ({
    productId: 'prod-1', productName: 'Taurus SC', status: 'not_deducted_implausible', amount: 1000000, amountUnit: 'fl_oz', ...over,
  });
  const run = async (svc, deductions) => {
    await notifyOfficeOfStockShortfalls({ svc, record: { id: 'record-1', structured_notes: { inventoryDeductions: deductions } }, database: { transaction: jest.fn() } });
  };

  test('one alert says to check the amount entered; it asks nothing of stock', async () => {
    const database = { transaction: jest.fn() };
    await notifyOfficeOfStockShortfalls({ svc: { id: 'visit-1', customer_id: 'customer-1', service_type: 'Lawn Care' }, record: { id: 'record-1', structured_notes: { inventoryDeductions: [refused()] } }, database });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('inventory');
    expect(spec).toEqual({
      area: 'Inventory',
      action: 'check Taurus SC amount',
      why: 'Taurus SC amount looks too big for a lawn visit, so stock was not changed.',
      severity: 'needs-you',
      who: 'person',
      link: '/admin/customers?customerId=customer-1',
      subject: { type: 'check', id: 'stock-amount-check:record-1:prod-1' },
      doneWhen: 'amount_checked',
    });
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'stock-amount-check:record-1:prod-1', dedupeOpenOnly: true });
    expect(opts.detail).toContain('1000000 fl oz was entered on a lawn visit');
    expect(opts.detail).toContain('Check the amount entered');
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('a name the alert rules refuse falls back to plain words', async () => {
    await run({ id: 'visit-1', service_type: 'Quarterly Pest Control' }, [refused({ productName: 'Bait [old lot]' })]);
    const [, spec] = compose.raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ action: 'check a product amount', why: 'A product amount looks too big for a pest visit, so stock was not changed.' });
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('a failed alert is logged and never fails the visit', async () => {
    compose.raiseAdminAlert.mockRejectedValueOnce(new Error('notifications unavailable'));
    await expect(run({ id: 'visit-1', service_type: 'Quarterly Pest Control' }, [refused()])).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stock amount alert failed (non-blocking)'));
  });
});

describe('the office alert for a lawn or tree & shrub visit', () => {
  const shortfall = { productId: 'prod-1', productName: 'Taurus SC', status: 'deducted_insufficient_stock', stockAfter: -3, deductedAmount: 4, inventoryUnit: 'fl_oz' };
  const record = { id: 'record-1', structured_notes: { inventoryDeductions: [shortfall] } };
  const catalog = (stockById) => {
    const trx = () => ({ where: ({ id }) => ({ forUpdate: () => ({ first: async () => (id in stockById ? { inventory_on_hand: stockById[id] } : undefined) }) }) });
    return { transaction: jest.fn(async (work) => work(trx)) };
  };
  const alertFor = async (svc) => {
    await notifyOfficeOfStockShortfalls({ svc, record, database: catalog({ 'prod-1': '-3' }) });
    return compose.raiseAdminAlert.mock.calls[0];
  };

  test.each([
    ['Lawn Care', 'lawn'],
    ['Tree & Shrub Care', 'tree & shrub'],
    ['Quarterly Pest Control', 'pest'],
  ])('a non-member %s record alerts, and the text names a %s visit, ', async (serviceType, label) => {
    const [, spec, opts] = await alertFor({ id: 'visit-1', service_type: serviceType });
    expect(spec).toMatchObject({ action: 'restock Taurus SC', why: `Taurus SC went below zero in stock after a ${label} visit.` });
    expect(opts).toMatchObject({ dedupeKey: 'stock-shortfall:prod-1', dedupeOpenOnly: true });
    expect(opts.detail).toBe(`Taurus SC went to -3 fl oz on hand after a ${label} visit used 4 fl oz. Restock it, or fix the count if the shelf has more.`);
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('the plain-words fallback names the visit and passes the alert rules', async () => {
    const odd = { ...shortfall, productName: 'Bait [old lot]' };
    await notifyOfficeOfStockShortfalls({ svc: { id: 'visit-1', service_type: 'Tree & Shrub Care' }, record: { id: 'record-1', structured_notes: { inventoryDeductions: [odd] } }, database: catalog({ 'prod-1': '-3' }) });
    const [, spec] = compose.raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ action: 'restock a product', why: 'A product went below zero in stock after a tree & shrub visit.' });
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('a long product name still fits the why limit on the longest visit label', async () => {
    const long = { ...shortfall, productName: 'Extraordinarily Long Product Name Concentrate' };
    await notifyOfficeOfStockShortfalls({ svc: { id: 'visit-1', service_type: 'Tree & Shrub Care' }, record: { id: 'record-1', structured_notes: { inventoryDeductions: [long] } }, database: catalog({ 'prod-1': '-3' }) });
    const [, spec] = compose.raiseAdminAlert.mock.calls[0];
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('a WaveGuard lawn record alerts too', async () => {
    const svc = { id: 'visit-1', service_type: 'Lawn Care', cust_waveguard_tier: 'Gold' };
    await notifyOfficeOfStockShortfalls({ svc, record, database: catalog({ 'prod-1': '-3' }) });
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(compose.raiseAdminAlert.mock.calls[0][1].why).toBe('Taurus SC went below zero in stock after a lawn visit.');
  });

  test.each(['Palm Injection', 'Mosquito Control', 'Termite Bait Station', 'Rodent Exclusion'])('a %s record never alerts', async (serviceType) => {
    const database = catalog({ 'prod-1': '-3' });
    await notifyOfficeOfStockShortfalls({ svc: { id: 'visit-1', service_type: serviceType }, record, database });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });
});
