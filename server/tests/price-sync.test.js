jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { syncPricesToEstimator } = require('../services/price-sync');

// Minimal thenable Knex chain stub (mirrors server/tests/payment-lifecycle-email.test.js).
function chain({ result = [] } = {}) {
  const q = {};
  ['where', 'whereNotNull', 'select', 'orderBy'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.update = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// Dispense one chain per db(table) call, in order, from per-table queues.
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  return tableQueues;
}

// 1 product priced at $128 / 64oz => $2.00/oz. Non-128 size on purpose so the
// math differs from the `|| 128` container fallback — a regression to a wrong
// catalog size column (e.g. the non-existent size_oz) would fail these assertions.
const PRODUCTS = [{ id: 'P1', name: 'Prod 1', best_price: 128, unit_size_oz: 64, category: 'lawn' }];

// 1 active mix using 2oz of P1 per tank, currently costed at $0 => recalcs to $4.00/tank.
function mix(overrides = {}) {
  return {
    id: 'M1',
    name: 'Mix A',
    active: true,
    coverage_sqft: 1000,
    cost_per_tank: 0,
    cost_per_1000sf: 0,
    products: JSON.stringify([{ product_id: 'P1', oz_per_tank: 2, cost_in_tank: 0 }]),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'NOW') };
});

describe('syncPricesToEstimator', () => {
  test('dry run computes deltas without writing tank_mixes', async () => {
    const tankRead = chain({ result: [mix()] });
    setDbQueues({
      products_catalog: [chain({ result: PRODUCTS })],
      tank_mixes: [tankRead], // only the read; a write would exhaust the queue and throw
    });

    const result = await syncPricesToEstimator({ dryRun: true });

    expect(result.dry_run).toBe(true);
    expect(result.products_with_pricing).toBe(1);
    expect(result.mixes_updated).toBe(1);
    expect(result.mix_updates).toHaveLength(1);
    expect(result.mix_updates[0]).toMatchObject({
      mix: 'Mix A',
      old_cost_per_tank: 0,
      new_cost_per_tank: 4,
      new_cost_per_1000sf: 4,
    });
    expect(result.price_changes).toHaveLength(1);
    expect(result.price_changes[0].delta).toBe(4);
    expect(result.skipped).toEqual([]);
    expect(tankRead.update).not.toHaveBeenCalled();
  });

  test('apply writes the recalculated cost to tank_mixes', async () => {
    const tankRead = chain({ result: [mix()] });
    const tankWrite = chain({ result: [] });
    setDbQueues({
      products_catalog: [chain({ result: PRODUCTS })],
      tank_mixes: [tankRead, tankWrite],
    });

    const result = await syncPricesToEstimator({ dryRun: false });

    expect(result.dry_run).toBe(false);
    expect(result.mixes_updated).toBe(1);
    expect(tankWrite.update).toHaveBeenCalledTimes(1);
    expect(tankWrite.update).toHaveBeenCalledWith(
      expect.objectContaining({ cost_per_tank: 4, cost_per_1000sf: 4 }),
    );
  });

  test('defaults to applying when called with no options (backward compatible)', async () => {
    const tankRead = chain({ result: [mix()] });
    const tankWrite = chain({ result: [] });
    setDbQueues({
      products_catalog: [chain({ result: PRODUCTS })],
      tank_mixes: [tankRead, tankWrite],
    });

    const result = await syncPricesToEstimator();

    expect(result.dry_run).toBe(false);
    expect(tankWrite.update).toHaveBeenCalledTimes(1);
  });

  test('skips (never writes) a mix with an unpriced product, reporting the blocker', async () => {
    // Mix uses P1 (priced) + P2 (no catalog best_price → filtered out of the query).
    const tankRead = chain({ result: [mix({
      products: JSON.stringify([
        { product_id: 'P1', oz_per_tank: 2, cost_in_tank: 0 },
        { product_id: 'P2', oz_per_tank: 1, cost_in_tank: 5 },
      ]),
    })] });
    setDbQueues({
      products_catalog: [chain({ result: PRODUCTS })],
      tank_mixes: [tankRead], // a write would exhaust the queue and throw
    });

    const result = await syncPricesToEstimator({ dryRun: false });

    expect(result.mixes_updated).toBe(0);
    expect(result.mix_updates).toEqual([]);
    expect(result.skipped).toEqual([
      { mix: 'Mix A', blockers: [{ product_id: 'P2', reason: 'no_best_price' }] },
    ]);
    expect(tankRead.update).not.toHaveBeenCalled();
  });

  test('skips a mix whose priced product is missing unit_size_oz (no size guessing)', async () => {
    // P3 is priced but has no normalized package size → must not default to 128oz.
    const products = [
      ...PRODUCTS,
      { id: 'P3', name: 'Prodiamine-like', best_price: 100, unit_size_oz: null, category: 'lawn' },
    ];
    const tankRead = chain({ result: [mix({
      products: JSON.stringify([{ product_id: 'P3', oz_per_tank: 2, cost_in_tank: 0 }]),
    })] });
    setDbQueues({
      products_catalog: [chain({ result: products })],
      tank_mixes: [tankRead],
    });

    const result = await syncPricesToEstimator({ dryRun: false });

    expect(result.mixes_updated).toBe(0);
    expect(result.skipped).toEqual([
      { mix: 'Mix A', blockers: [{ product_id: 'P3', reason: 'missing_unit_size_oz' }] },
    ]);
    expect(tankRead.update).not.toHaveBeenCalled();
  });
});
