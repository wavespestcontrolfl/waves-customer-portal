/**
 * Intelligence Bar stock tools (adjust_stock / create_restock_request /
 * update_restock_request) — behavior beyond the write-gate contract:
 * unit conversion, set_total physical-count seeding, double-receive guard,
 * and the exact mutations a confirmed call commits.
 *
 * Uses the same recording-knex-mock approach as
 * intelligence-bar-write-gate-contract.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Intercept the lazy require in update_restock_request's receive path so the
// test never loads the full admin-inventory route module.
jest.mock('../routes/admin-inventory', () => ({
  syncLawnReadinessAfterRestock: jest.fn(async () => ({ alertStatus: 'resolved' })),
}));

const dbMock = require('../models/db');
const adminInventoryMock = require('../routes/admin-inventory');
const { executeProcurementTool } = require('../services/intelligence-bar/procurement-tools');

function makeRecordingDb(seed = {}) {
  const mutations = [];
  const MUTATING_OPS = new Set(['insert', 'update', 'del', 'delete', 'increment', 'decrement', 'truncate', 'upsert']);
  const firstIndex = {};

  function makeBuilder(table) {
    const rows = seed[table] || [];
    const state = { single: false };
    const builder = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') {
          if (state.single) {
            const i = firstIndex[table] || 0;
            firstIndex[table] = i + 1;
            return (resolve) => resolve(rows.length ? rows[i % rows.length] : undefined);
          }
          return (resolve) => resolve(rows);
        }
        if (prop === 'first') {
          return () => { state.single = true; return builder; };
        }
        if (MUTATING_OPS.has(prop)) {
          return (...args) => { mutations.push({ table, op: String(prop), args }); return builder; };
        }
        return () => builder;
      },
    });
    return builder;
  }

  const db = (table) => makeBuilder(table);
  db.raw = (...args) => ({ __raw: args });
  db.transaction = async (cb) => cb((table) => makeBuilder(table));
  return { db, mutations };
}

function useDb(seed) {
  const { db, mutations } = makeRecordingDb(seed);
  dbMock.mockImplementation(db);
  dbMock.raw.mockImplementation(db.raw);
  dbMock.transaction.mockImplementation(db.transaction);
  return mutations;
}

const TRACKED_PRODUCT = {
  id: 'prod-1', name: 'Bifen XTS', category: 'insecticide',
  inventory_on_hand: 64, inventory_unit: 'fl_oz', low_stock_threshold: 32,
  best_vendor: 'SiteOne',
};
const UNTRACKED_PRODUCT = {
  id: 'prod-2', name: 'Prodiamine 65 WDG', category: 'herbicide',
  inventory_on_hand: null, inventory_unit: null, low_stock_threshold: null,
  best_vendor: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  adminInventoryMock.syncLawnReadinessAfterRestock.mockResolvedValue({ alertStatus: 'resolved' });
});

describe('adjust_stock', () => {
  test('set_total physical count on an UNTRACKED product previews a seed (delta = full amount)', async () => {
    const mutations = useDb({ products_catalog: [UNTRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Prodiamine', movement_type: 'correction', set_total: 5, unit: 'lb',
    });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.was_untracked).toBe(true);
    expect(result.stock_before).toBe(0);
    expect(result.change).toBe(5);
    expect(result.stock_after).toBe(5);
    expect(result.unit).toBe('lb');
    expect(mutations).toEqual([]);
  });

  test('confirmed restock converts entered gallons into the fl_oz inventory unit and commits both writes', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 2, unit: 'gal', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_before).toBe(64);
    expect(result.change).toBe(256); // 2 gal = 256 fl_oz
    expect(result.stock_after).toBe(320);
    expect(result.unit).toBe('fl_oz');

    const update = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(update.args[0]).toMatchObject({ inventory_on_hand: 320, inventory_unit: 'fl_oz' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({
      product_id: 'prod-1', movement_type: 'restock', quantity: 256,
      unit: 'fl_oz', stock_before: 64, stock_after: 320,
    });
    expect(movement.args[0].metadata).toMatchObject({
      source: 'intelligence_bar_adjust_stock', enteredQuantity: 2, enteredUnit: 'gal',
    });
  });

  test('set_total 0 on an UNTRACKED product seeds tracking at zero (Codex P2)', async () => {
    const mutations = useDb({ products_catalog: [UNTRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Prodiamine', movement_type: 'correction', set_total: 0, unit: 'lb', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_after).toBe(0);

    const update = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(update.args[0]).toMatchObject({ inventory_on_hand: 0, inventory_unit: 'lb' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({ movement_type: 'correction', quantity: 0, stock_before: 0, stock_after: 0 });
  });

  test('set_total equal to current stock on a TRACKED product is rejected as a no-op', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'correction', set_total: 64, confirmed: true,
    });
    expect(result.error).toMatch(/nothing to adjust/);
    expect(mutations).toEqual([]);
  });

  test('refuses a weight unit against a volume inventory unit', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 5, unit: 'lb',
    });
    expect(result.error).toMatch(/Cannot convert lb/);
    expect(mutations).toEqual([]);
  });

  test('rejects negative quantity for restock/damaged_lost and set_total outside correction', async () => {
    useDb({ products_catalog: [TRACKED_PRODUCT] });
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: -3,
    })).error).toMatch(/positive/);
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', set_total: 10,
    })).error).toMatch(/set_total is only valid/);
    expect((await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'correction', quantity: 4, set_total: 10,
    })).error).toMatch(/not both/);
  });

  test('ambiguous product name returns candidates without writing', async () => {
    const mutations = useDb({
      products_catalog: [
        TRACKED_PRODUCT,
        { ...TRACKED_PRODUCT, id: 'prod-3', name: 'Bifen IT' },
      ],
    });
    const result = await executeProcurementTool('adjust_stock', {
      product_name: 'Bifen', movement_type: 'restock', quantity: 32, confirmed: true,
    });
    expect(result.error).toMatch(/Multiple products match/);
    expect(result.candidates).toHaveLength(2);
    expect(mutations).toEqual([]);
  });
});

describe('create_restock_request', () => {
  test('confirmed insert carries source intelligence_bar and defaults vendor/unit from the product', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('create_restock_request', {
      product_name: 'Bifen', quantity: 128, priority: 'high', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const insert = mutations.find(m => m.table === 'product_restock_requests' && m.op === 'insert');
    expect(insert.args[0]).toMatchObject({
      product_id: 'prod-1', status: 'open', priority: 'high',
      requested_quantity: 128, unit: 'fl_oz', vendor: 'SiteOne',
      source: 'intelligence_bar', current_stock: 64,
    });
  });

  test('rejects a malformed needed_by date', async () => {
    const mutations = useDb({ products_catalog: [TRACKED_PRODUCT] });
    const result = await executeProcurementTool('create_restock_request', {
      product_name: 'Bifen', quantity: 128, needed_by: 'next tuesday',
    });
    expect(result.error).toMatch(/YYYY-MM-DD/);
    expect(mutations).toEqual([]);
  });
});

describe('update_restock_request', () => {
  const OPEN_REQUEST = {
    id: 'req-1', product_id: 'prod-1', status: 'open', priority: 'normal',
    requested_quantity: 128, unit: 'fl_oz',
  };

  test('refuses to act on an already-received request (double-receive would double-add stock)', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [{ ...OPEN_REQUEST, status: 'received' }],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toMatch(/already received/);
    expect(mutations).toEqual([]);
  });

  test('a concurrent receive landing between pre-check and transaction is caught by the locked re-check (Codex P1)', async () => {
    // The rotating .first() mock serves the OPEN row to the unlocked
    // pre-check and the RECEIVED row to the in-transaction forUpdate
    // re-read — exactly the interleaving of two simultaneous confirms.
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST, { ...OPEN_REQUEST, status: 'received' }],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toMatch(/already received/);
    expect(mutations).toEqual([]);
    expect(adminInventoryMock.syncLawnReadinessAfterRestock).not.toHaveBeenCalled();
  });

  test('confirmed receive adds stock, logs a restock movement, closes the request, and runs the readiness recheck', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'receive', confirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.stock_before).toBe(64);
    expect(result.added).toBe(128);
    expect(result.stock_after).toBe(192);

    const productUpdate = mutations.find(m => m.table === 'products_catalog' && m.op === 'update');
    expect(productUpdate.args[0]).toMatchObject({ inventory_on_hand: 192, inventory_unit: 'fl_oz' });
    const movement = mutations.find(m => m.table === 'product_inventory_movements' && m.op === 'insert');
    expect(movement.args[0]).toMatchObject({
      movement_type: 'restock', quantity: 128, stock_before: 64, stock_after: 192,
    });
    expect(movement.args[0].metadata).toMatchObject({
      source: 'intelligence_bar_restock_receive', restockRequestId: 'req-1',
    });
    const requestUpdate = mutations.find(m => m.table === 'product_restock_requests' && m.op === 'update');
    expect(requestUpdate.args[0]).toMatchObject({ status: 'received' });

    expect(adminInventoryMock.syncLawnReadinessAfterRestock).toHaveBeenCalledTimes(1);
    expect(result.readiness_recheck).toEqual({ alertStatus: 'resolved' });
  });

  test('mark_ordered and cancel only touch the request row', async () => {
    const mutations = useDb({
      products_catalog: [TRACKED_PRODUCT],
      product_restock_requests: [OPEN_REQUEST],
    });
    const result = await executeProcurementTool('update_restock_request', {
      request_id: 'req-1', action: 'mark_ordered', confirmed: true,
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('ordered');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ table: 'product_restock_requests', op: 'update' });
    expect(adminInventoryMock.syncLawnReadinessAfterRestock).not.toHaveBeenCalled();
  });
});
