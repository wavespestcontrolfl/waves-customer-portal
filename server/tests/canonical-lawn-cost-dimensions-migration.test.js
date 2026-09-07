jest.mock('../models/db', () => jest.fn());
jest.mock('../services/inventory-unit-review', () => ({ applyInventoryUnitFix: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
const migration = require('../models/migrations/20260907000100_canonical_lawn_cost_dimensions');
const { applyInventoryUnitFix } = require('../services/inventory-unit-review');
const { recordAuditEvent } = require('../services/audit-log');

function fixture({ canonical = true } = {}) {
  const specs = [
    ['Prodiamine 65 WDG', 'Prodiamine 65 WDG', '5 lb', 80, 68.43],
    ['Armada 50 WDG', 'Armada 50 WDG', '2 lb', 32, 134.95],
    ['SpeedZone Southern', 'SpeedZone Southern', '2.5 gal', 320, 192.51],
    ['LESCO 12-0-0 Chelated Iron Plus', 'LESCO Chelated Iron Plus', '2.5 gal', 320, 34.78],
    ['LESCO K-Flow 0-0-25', 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', '2.5 gal', 320, 38.02],
    ['Primo Maxx', 'Primo Maxx Plant Growth Regulator for Turf', '1 gal', 128, 320],
  ];
  const rows = specs.flatMap(([legacy, keeper, container, ounces, price], index) => {
    const row = { id: `product-${index}`, name: canonical ? keeper : legacy, active: true,
      container_size: container, unit_size_oz: ounces, best_price: price,
      cost_per_unit: null, cost_unit: null, inventory_unit: null,
      inventory_on_hand: null, low_stock_threshold: null };
    return canonical && legacy !== keeper
      ? [row, { ...row, id: `inactive-${index}`, name: legacy, active: false }] : [row];
  });
  const db = jest.fn((table) => {
    expect(table).toBe('products_catalog');
    let matches = rows;
    const query = {
      whereIn: (field, values) => { matches = matches.filter(row => values.includes(row[field])); return query; },
      whereRaw: (sql) => { expect(sql).toBe('active IS NOT FALSE'); matches = matches.filter(row => row.active !== false); return query; },
      forUpdate: async () => matches,
    };
    return query;
  });
  applyInventoryUnitFix.mockImplementation(async ({ productId, nextUnit }) => {
    rows.find(row => row.id === productId).inventory_unit = nextUnit;
  });
  return { db, rows };
}
beforeEach(() => jest.clearAllMocks());

test('fills active deduped keepers and never writes inactive predecessors', async () => {
  const { db, rows } = fixture();
  await migration.up(db);
  expect(applyInventoryUnitFix).toHaveBeenCalledTimes(6);
  expect(rows.filter(row => !row.active).every(row => row.inventory_unit === null)).toBe(true);
  expect(rows.filter(row => row.active).every(row => row.inventory_unit)).toBe(true);
  await migration.up(db);
  expect(recordAuditEvent).toHaveBeenCalledTimes(6);
});
test('supports a fresh catalog without imported dedupe keepers', async () => {
  const { db } = fixture({ canonical: false });
  await migration.up(db);
  expect(applyInventoryUnitFix).toHaveBeenCalledTimes(6);
});
test('refuses two active identities', async () => {
  const { db, rows } = fixture();
  rows.push({ ...rows[0], id: 'duplicate' });
  await expect(migration.up(db)).rejects.toThrow('Expected one active catalog product');
  expect(applyInventoryUnitFix).not.toHaveBeenCalled();
});
test.each(['Prodiamine 65 WDG', 'Armada 50 WDG'])('rejects stale dry COGS after a prior unit fill: %s', async (name) => {
  const { db, rows } = fixture();
  Object.assign(rows.find(row => row.name === name), { inventory_unit: 'lb', cost_unit: 'oz', cost_per_unit: 99 });
  await expect(migration.up(db)).rejects.toThrow(`Cost basis needs review: ${name}`);
});
test.each([['oz', 0.8554], ['lb', 13.686]])('preserves a consistent dry cost per %s', async (unit, price) => {
  const { db, rows } = fixture();
  Object.assign(rows[0], { cost_unit: unit, cost_per_unit: price });
  await migration.up(db);
  expect(rows[0]).toMatchObject({ cost_unit: unit, cost_per_unit: price, inventory_unit: 'lb' });
});
test('rejects a fluid cost unit on a dry package even when the numbers match', async () => {
  const { db, rows } = fixture();
  Object.assign(rows[0], { cost_unit: 'fl_oz', cost_per_unit: 0.8554 });
  await expect(migration.up(db)).rejects.toThrow('Cost unit conflicts');
});
test('refuses unknown stock basis', async () => {
  const { db, rows } = fixture();
  rows[0].inventory_on_hand = 1;
  await expect(migration.up(db)).rejects.toThrow('Stock basis missing');
  expect(applyInventoryUnitFix).not.toHaveBeenCalled();
});
