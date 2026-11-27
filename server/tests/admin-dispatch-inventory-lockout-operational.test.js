const { deductProductInventory } = require('../services/complete-scheduled-service');

// Fake knex trx whose forUpdate lock finds no row, so deductProductInventory
// falls back to the passed-in product snapshot (no DB needed for the guard).
// The product has never been counted, so the count read answers no rows.
const fakeTrx = () => ({
  where: () => ({
    forUpdate: () => ({ first: async () => null }),
    orderBy: () => ({ limit: () => ({ select: async () => [] }) }),
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

// Owner 2026-11-26 ("EVERYTHING SHOULD ONLY BE WARNED, NEVER BLOCKED FROM USING, FOR NOW"): stock below zero no longer stops a
// completion on ANY visit type (palm, mosquito, termite and rodent used to get a 400 waveguard_inventory_lockout). The deduction
// records the shortfall and the office is alerted (pest-stock-advisory.test.js).
describe('stock below zero never throws', () => {
  test('insufficient stock is deducted into the negative and recorded, with no thrown lockout', async () => {
    const writes = [];
    const trx = (table) => ({
      where: () => ({
        forUpdate: () => ({ first: async () => null }),
        orderBy: () => ({ limit: () => ({ select: async () => [] }) }),
        update: async (row) => { writes.push({ table, update: row }); return 1; },
      }),
      insert: (row) => ({ returning: async () => { writes.push({ table, insert: row }); return [{ id: 'movement-1', ...row }]; } }),
    });
    const result = await deductProductInventory(trx, args);
    expect(result).toMatchObject({ status: 'deducted_insufficient_stock', stockBefore: 1, stockAfter: -1, deductedAmount: 2 });
    expect(writes.find((w) => w.table === 'products_catalog').update).toMatchObject({ inventory_on_hand: -1 });
  });
});
