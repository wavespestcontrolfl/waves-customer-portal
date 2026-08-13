const { deductProductInventory } = require('../routes/admin-dispatch')._test;
const { errorHandler } = require('../middleware/errors');

// Fake knex trx whose forUpdate lock finds no row, so deductProductInventory
// falls back to the passed-in product snapshot (no DB needed for the guard).
const fakeTrx = () => ({
  where: () => ({
    forUpdate: () => ({ first: async () => null }),
  }),
});

const product = {
  id: 'prod-1',
  name: 'Onslaught Fastcap',
  inventory_on_hand: 1,
  inventory_unit: 'fl_oz',
};

const args = {
  product,
  productInput: { totalAmount: 2, amountUnit: 'fl_oz' },
  serviceProduct: { id: 'sp-1' },
  serviceRecord: { id: 'sr-1' },
  scheduledService: { id: 'svc-1' },
};

describe('inventory lockout error is operational', () => {
  test('insufficient stock throws a 400 flagged operational', async () => {
    let thrown;
    try {
      await deductProductInventory(fakeTrx, args);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.statusCode).toBe(400);
    expect(thrown.isOperational).toBe(true);
    expect(thrown.code).toBe('waveguard_inventory_lockout');
    expect(thrown.message).toContain('is on hand');
  });

  test('error middleware surfaces the real message as 400, not a masked 500', async () => {
    let thrown;
    try {
      await deductProductInventory(fakeTrx, args);
    } catch (err) {
      thrown = err;
    }
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    errorHandler(thrown, { method: 'POST', originalUrl: '/api/admin/dispatch/x/complete', body: {} }, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('is on hand');
    expect(res.body.code).toBe('waveguard_inventory_lockout');
  });
});
