/**
 * inventory-unit-review — pure-alias resolution, the shared fix applier's
 * sweep-mode guards, and the gated nightly autofix sweep.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const { isEnabled } = require('../config/feature-gates');
const { notifyAdmin } = require('../services/notification-service');
const {
  applyInventoryUnitFix,
  resolveInventoryUnitAlias,
  runInventoryUnitAutofixSweep,
} = require('../services/inventory-unit-review');

function makeChain(table, route) {
  const q = { _table: table, _calls: [] };
  const methods = [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'select', 'orderBy',
    'forUpdate', 'update', 'insert', 'count', 'first', 'limit',
  ];
  for (const m of methods) {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  }
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (resolve, reject) => Promise.resolve().then(() => route(q)).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// resolveInventoryUnitAlias — the green bar
// ---------------------------------------------------------------------------

describe('resolveInventoryUnitAlias', () => {
  it('resolves pure alias/case/plural spellings to the canonical unit', () => {
    expect(resolveInventoryUnitAlias('Gallons')).toBe('gal');
    expect(resolveInventoryUnitAlias('FL  OZ')).toBe('fl_oz'); // double space defeats the SQL normalizer, not the JS one
    expect(resolveInventoryUnitAlias('Liters')).toBe('l');
    expect(resolveInventoryUnitAlias('Pounds')).toBe('lb');
    expect(resolveInventoryUnitAlias('Quarts')).toBe('qt');
  });

  it('never touches the ambiguous oz family', () => {
    expect(resolveInventoryUnitAlias('oz')).toBe(null);
    expect(resolveInventoryUnitAlias('OZ')).toBe(null);
    expect(resolveInventoryUnitAlias('Ounces')).toBe(null);
  });

  it('never touches missing or unrecognizable units', () => {
    expect(resolveInventoryUnitAlias('')).toBe(null);
    expect(resolveInventoryUnitAlias(null)).toBe(null);
    expect(resolveInventoryUnitAlias('bottles')).toBe(null);
    expect(resolveInventoryUnitAlias('fl. oz')).toBe(null); // punctuation breaks normalization — human review
    expect(resolveInventoryUnitAlias('cases')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// applyInventoryUnitFix — sweep-mode guards
// ---------------------------------------------------------------------------

function buildDbi({ product }) {
  const state = { updated: null, movements: [] };
  const route = (table, q) => {
    if (table === 'products_catalog') {
      if (q.called('forUpdate')) return product;
      if (q.called('update')) { state.updated = q.args('update')[0]; return 1; }
      if (q.called('first')) return { ...product, ...(state.updated || {}) };
      return [];
    }
    if (table === 'product_inventory_movements') {
      state.movements.push(q.args('insert')[0]);
      return 1;
    }
    return [];
  };
  const dbi = jest.fn((table) => makeChain(table, (q) => route(table, q)));
  dbi.transaction = jest.fn(async (fn) => fn(dbi));
  return { dbi, state };
}

describe('applyInventoryUnitFix (sweep mode)', () => {
  const product = {
    id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: '1',
  };

  it('renames a pure alias with no quantity change and a zero-quantity audit movement', async () => {
    const { dbi, state } = buildDbi({ product });
    const { outcome } = await applyInventoryUnitFix({
      dbi,
      productId: 'p1',
      nextUnit: 'gal',
      convertExistingStock: false,
      movementSource: 'inventory_unit_review_autofix',
      adjustedBy: 'auto:inventory-unit-autofix',
      expectedCurrentUnit: 'Gallons',
      alwaysRecordMovement: true,
    });
    expect(outcome).toBe('applied');
    expect(state.updated.inventory_unit).toBe('gal');
    // NO conversion: the numbers were already gallons.
    expect(state.updated.inventory_on_hand).toBe(2.5);
    expect(state.updated.low_stock_threshold).toBe(1);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].quantity).toBe(0);
    expect(state.movements[0].metadata.source).toBe('inventory_unit_review_autofix');
    expect(state.movements[0].metadata.adjustedBy).toBe('auto:inventory-unit-autofix');
  });

  it("goes stale (no write) when the locked row's unit changed since the caller's read", async () => {
    const { dbi, state } = buildDbi({ product: { ...product, inventory_unit: 'fl_oz' } });
    const { outcome } = await applyInventoryUnitFix({
      dbi,
      productId: 'p1',
      nextUnit: 'gal',
      convertExistingStock: false,
      expectedCurrentUnit: 'Gallons',
      alwaysRecordMovement: true,
    });
    expect(outcome).toBe('stale');
    expect(state.updated).toBe(null);
    expect(state.movements).toHaveLength(0);
  });

  it('refuses an unsupported target unit with a 400', async () => {
    const { dbi } = buildDbi({ product });
    await expect(applyInventoryUnitFix({ dbi, productId: 'p1', nextUnit: 'bottles' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// runInventoryUnitAutofixSweep
// ---------------------------------------------------------------------------

describe('runInventoryUnitAutofixSweep', () => {
  function buildSweepDbi({ candidates, products, remaining = 4 }) {
    const state = { updates: [], movements: [] };
    const route = (table, q) => {
      if (table === 'products_catalog') {
        if (q.called('count')) return { count: remaining };
        if (q.called('limit')) return candidates;
        if (q.called('forUpdate')) return products[q.args('where')[0].id] || null;
        if (q.called('update')) { state.updates.push({ where: q.args('where')[0], payload: q.args('update')[0] }); return 1; }
        if (q.called('first')) return {};
        return [];
      }
      if (table === 'product_inventory_movements') {
        state.movements.push(q.args('insert')[0]);
        return 1;
      }
      return [];
    };
    const dbi = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    dbi.transaction = jest.fn(async (fn) => fn(dbi));
    return { dbi, state };
  }

  it('is a no-op while the gate is off', async () => {
    const { dbi } = buildSweepDbi({ candidates: [], products: {} });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result).toEqual({ skipped: 'gate_off' });
    expect(dbi).not.toHaveBeenCalled();
  });

  it('fixes pure aliases, parks everything else, and sends ONE digest with the remaining count', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const candidates = [
      { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' },
      { id: 'p2', name: 'Bifen Granules', inventory_unit: 'bags' }, // unrecognizable — parked
    ];
    const products = {
      p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates, products, remaining: 4 });
    const result = await runInventoryUnitAutofixSweep({ dbi });

    expect(result.applied).toBe(1);
    expect(result.parked).toBe(1);
    expect(result.errors).toBe(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload.inventory_unit).toBe('gal');
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0].metadata.source).toBe('inventory_unit_review_autofix');

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('system');
    expect(title).toMatch(/1 unit alias auto-fixed/);
    expect(body).toMatch(/4 products still need unit review/);
    expect(opts.link).toBe('/admin/inventory?tab=unit-review');
  });

  it('goes stale instead of overwriting a row an admin fixed mid-sweep', async () => {
    isEnabled.mockImplementation((gate) => gate === 'inventoryUnitAutofix');
    const candidates = [{ id: 'p1', name: 'Talstar P', inventory_unit: 'Gallons' }];
    const products = {
      p1: { id: 'p1', name: 'Talstar P', inventory_unit: 'fl_oz', inventory_on_hand: '2.5', low_stock_threshold: null },
    };
    const { dbi, state } = buildSweepDbi({ candidates, products });
    const result = await runInventoryUnitAutofixSweep({ dbi });
    expect(result.applied).toBe(0);
    expect(result.stale).toBe(1);
    expect(state.updates).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
