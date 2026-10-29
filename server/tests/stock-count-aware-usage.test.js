/**
 * GATE_STOCK_COUNT_AWARE_USAGE — a visit done before a product's latest physical count
 * must not take its usage off stock a second time.
 *
 *   - deductProductInventory (complete-scheduled-service.js)
 *   - consumeCompletionSupplies (supplies-consumption.js)
 *
 * Mocked-db unit tests: gate off = today's behavior; gate on + visit before the count =
 * usage movement written, stock and lockout untouched; gate on + visit after = normal.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  _private: { openToCloser: (q) => q, doneColumns: () => ({}) },
}));

const { deductProductInventory } = require('../services/complete-scheduled-service');
const { consumeCompletionSupplies } = require('../services/supplies-consumption');

const GATE = 'GATE_STOCK_COUNT_AWARE_USAGE';
const COUNT_ROW = {
  id: 'count-1',
  movement_type: 'correction',
  created_at: new Date('2026-10-23T01:00:00Z'),
  metadata: { source: 'admin_manual_adjustment', reason: 'physical_count_2026_10_22', setTotal: 150, countedAt: '2026-10-22T20:00:00Z' },
};

// A trx for both writers. `countRows` answers the newest-first correction read;
// `scheduled` / `record` answer the consumables path's visit lookups.
function fakeTrx({ countRows = [], product = null, scheduled = null, record = null } = {}) {
  const writes = [];
  const reads = [];
  const trx = (table) => {
    const q = {};
    q.where = (w) => { q.w = w; return q; };
    q.forUpdate = () => q;
    q.orderBy = () => q;
    q.limit = () => q;
    q.whereRaw = () => q;
    q.first = async () => {
      reads.push(table);
      if (table === 'products_catalog') return product;
      return null;
    };
    q.select = (...cols) => {
      reads.push(table);
      const rows = table === 'product_inventory_movements' ? countRows : [];
      return Object.assign(Promise.resolve(rows), {
        first: async () => (table === 'scheduled_services' ? scheduled : table === 'service_records' ? record : null),
      });
    };
    q.update = async (row) => { writes.push({ table, update: row }); return 1; };
    q.insert = (row) => {
      writes.push({ table, insert: row });
      const done = { returning: async () => [{ id: 'movement-1', ...row }] };
      done.onConflict = () => ({ ignore: () => done });
      return done;
    };
    return q;
  };
  trx.raw = (s) => s;
  trx.writes = writes;
  trx.reads = reads;
  return trx;
}

const deductArgs = (over = {}) => ({
  product: { id: 'dimension', name: 'Dimension 18-0-10', inventory_on_hand: '150', inventory_unit: 'lb', cost_per_unit: '2', cost_unit: 'lb' },
  productInput: { totalAmount: 16.2, amountUnit: 'lb' },
  serviceProduct: { id: 'sp-1' },
  serviceRecord: { id: 'record-1', service_date: '2026-10-10' },
  scheduledService: { id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1', scheduled_date: '2026-10-10' },
  ...over,
});

afterEach(() => { delete process.env[GATE]; });

describe('deductProductInventory', () => {
  test('gate off: an old visit still deducts, and no count is read', async () => {
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const result = await deductProductInventory(trx, deductArgs());
    expect(result).toMatchObject({ status: 'deducted', stockBefore: 150, stockAfter: 133.8 });
    expect(trx.reads).not.toContain('product_inventory_movements');
    expect(trx.writes.map((w) => w.table)).toEqual(['products_catalog', 'product_inventory_movements']);
  });

  test('gate on + visit before the count: the movement is written, stock is not changed', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const result = await deductProductInventory(trx, deductArgs());
    expect(trx.writes.filter((w) => w.table === 'products_catalog')).toEqual([]);
    expect(trx.writes).toHaveLength(1);
    expect(trx.writes[0].insert).toMatchObject({
      product_id: 'dimension',
      scheduled_service_id: 'visit-1',
      service_record_id: 'record-1',
      movement_type: 'usage',
      quantity: 16.2,
      unit: 'lb',
      unit_cost: 2,
      cost_used: 32.4,
      stock_before: 150,
      stock_after: 150,
      metadata: {
        enteredAmount: 16.2,
        insufficientStock: false,
        stockUnchanged: 'used_before_latest_count',
        countMovementId: 'count-1',
        countedAt: '2026-10-22T20:00:00.000Z',
      },
    });
    expect(result).toMatchObject({
      status: 'not_deducted_counted',
      movementId: 'movement-1',
      deductedAmount: 16.2,
      costUsed: 32.4,
      stockBefore: 150,
      stockAfter: 150,
      remainingStock: 150,
      warning: 'This visit was done before the latest count, which already includes this use; stock was not changed.',
    });
  });

  test('gate on + visit before the count: no lockout even when stock would go negative', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const args = deductArgs({ product: { id: 'dimension', name: 'Dimension 18-0-10', inventory_on_hand: '3', inventory_unit: 'lb' } });
    const result = await deductProductInventory(trx, { ...args, allowNegative: false });
    expect(result).toMatchObject({ status: 'not_deducted_counted', stockBefore: 3, stockAfter: 3 });
    expect(trx.writes.filter((w) => w.table === 'products_catalog')).toEqual([]);
  });

  test('gate on + visit after the count: a normal deduction', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const args = deductArgs({
      serviceRecord: { id: 'record-1', service_date: '2026-10-26' },
      scheduledService: { id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1', scheduled_date: '2026-10-26' },
    });
    const result = await deductProductInventory(trx, args);
    expect(result).toMatchObject({ status: 'deducted', stockBefore: 150, stockAfter: 133.8 });
    expect(trx.writes[0]).toEqual({ table: 'products_catalog', update: expect.objectContaining({ inventory_on_hand: 133.8 }) });
    expect(trx.writes[1].insert.metadata).not.toHaveProperty('stockUnchanged');
  });

  test('gate on + a recorded start time before the count on the count\'s own day: not deducted', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const args = deductArgs({
      serviceRecord: { id: 'record-1', service_date: '2026-10-22' },
      scheduledService: { id: 'visit-1', arrived_at: '2026-10-22T14:00:00Z', scheduled_date: '2026-10-22' },
    });
    expect((await deductProductInventory(trx, args)).status).toBe('not_deducted_counted');
  });

  test('gate on + no start time + the count\'s own Eastern day: a normal deduction', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const args = deductArgs({
      serviceRecord: { id: 'record-1', service_date: '2026-10-22' },
      scheduledService: { id: 'visit-1', scheduled_date: '2026-10-22' },
    });
    expect((await deductProductInventory(trx, args)).status).toBe('deducted');
  });

  test('gate on + the product was never counted: a normal deduction', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [{ id: 'fix', movement_type: 'correction', created_at: new Date('2026-10-23T01:00:00Z'), metadata: { source: 'siteone_invoice', setTotal: 99 } }] });
    expect((await deductProductInventory(trx, deductArgs())).status).toBe('deducted');
  });

  test('gate on: the lockout still applies when there is no count to blame', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [] });
    const args = deductArgs({ product: { id: 'dimension', name: 'Dimension 18-0-10', inventory_on_hand: '3', inventory_unit: 'lb' } });
    await expect(deductProductInventory(trx, args)).rejects.toMatchObject({ code: 'waveguard_inventory_lockout' });
    expect(trx.writes).toEqual([]);
  });

  test('gate on: a missing amount still short-circuits before any count read', async () => {
    process.env[GATE] = 'true';
    const trx = fakeTrx({ countRows: [COUNT_ROW] });
    const result = await deductProductInventory(trx, deductArgs({ productInput: { totalAmount: 0, amountUnit: 'lb' } }));
    expect(result.status).toBe('not_deducted');
    expect(trx.reads).not.toContain('product_inventory_movements');
  });
});

describe('consumeCompletionSupplies', () => {
  const sign = { id: 'prod-sign', name: 'Sign card', per_completion_usage: '1', inventory_on_hand: '640', inventory_unit: 'each' };
  const args = { scheduledServiceId: 'svc-1', serviceRecordId: 'rec-1', customerId: 'cust-1', technicianId: 'tech-1' };

  function dbFor(trx) {
    const db = () => {
      const q = {};
      q.whereNotNull = () => q;
      q.where = () => q;
      q.orWhereRaw = () => q;
      q.whereNull = () => q;
      q.whereRaw = () => q;
      q.select = async () => [sign];
      q.first = async () => null;
      q.update = async () => 1;
      return q;
    };
    db.transaction = async (fn) => fn(trx);
    db.raw = (s) => s;
    return db;
  }
  const consumeTrx = (over) => {
    const trx = fakeTrx({ product: sign, ...over });
    // settledReason's movement / notification probes find nothing.
    return trx;
  };

  beforeEach(() => { process.env.GATE_AUTO_REORDER = 'true'; });
  afterEach(() => { delete process.env.GATE_AUTO_REORDER; });

  test('gate off: an old visit still takes the kit off stock, and no count is read', async () => {
    const trx = consumeTrx({ countRows: [COUNT_ROW], scheduled: { scheduled_date: '2026-10-10' } });
    const res = await consumeCompletionSupplies(dbFor(trx), args);
    expect(res.consumed).toHaveLength(1);
    expect(res.consumed[0]).toMatchObject({ before: 640, after: 639 });
    expect(trx.writes.find((w) => w.table === 'products_catalog')).toEqual({ table: 'products_catalog', update: expect.objectContaining({ inventory_on_hand: 639 }) });
    expect(trx.reads).not.toContain('scheduled_services');
  });

  test('gate on + visit before the count: the movement is written with stock unchanged', async () => {
    process.env[GATE] = 'true';
    const trx = consumeTrx({
      countRows: [COUNT_ROW],
      scheduled: { scheduled_date: '2026-10-10', arrived_at: null },
      record: { service_date: '2026-10-10', started_at: null },
    });
    const res = await consumeCompletionSupplies(dbFor(trx), args);
    expect(res.errors).toEqual([]);
    expect(res.consumed).toEqual([expect.objectContaining({ productId: 'prod-sign', before: 640, after: 640, stockUnchanged: true })]);
    expect(trx.writes.filter((w) => w.table === 'products_catalog')).toEqual([]);
    expect(trx.writes.find((w) => w.table === 'product_inventory_movements').insert).toMatchObject({
      scheduled_service_id: 'svc-1',
      movement_type: 'usage',
      quantity: 1,
      stock_before: 640,
      stock_after: 640,
      metadata: {
        source: 'completion_consumable',
        stockUnchanged: 'used_before_latest_count',
        countMovementId: 'count-1',
        countedAt: '2026-10-22T20:00:00.000Z',
      },
    });
  });

  test('gate on + visit after the count: a normal deduction', async () => {
    process.env[GATE] = 'true';
    const trx = consumeTrx({
      countRows: [COUNT_ROW],
      scheduled: { scheduled_date: '2026-10-27', arrived_at: '2026-10-27T14:00:00Z' },
      record: { service_date: '2026-10-27', started_at: null },
    });
    const res = await consumeCompletionSupplies(dbFor(trx), args);
    expect(res.consumed[0]).toMatchObject({ before: 640, after: 639 });
    expect(res.consumed[0]).not.toHaveProperty('stockUnchanged');
    expect(trx.writes.find((w) => w.table === 'products_catalog').update).toMatchObject({ inventory_on_hand: 639 });
  });

  test('gate on + the product was never counted: a normal deduction and no visit read', async () => {
    process.env[GATE] = 'true';
    const trx = consumeTrx({ countRows: [] });
    const res = await consumeCompletionSupplies(dbFor(trx), args);
    expect(res.consumed[0]).toMatchObject({ before: 640, after: 639 });
    expect(trx.reads).not.toContain('scheduled_services');
  });
});
