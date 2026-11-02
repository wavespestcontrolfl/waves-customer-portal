// Costing math the inventory metrics audit (2026-11-01) found wrong: a unit
// cost applied to usage in a unit it cannot convert to, and four-decimal
// rounding on every conversion that compounded across small doses.
const { costLineFromUsage } = require('../services/product-costing');
const { convertInventoryQuantity, describeInventoryConversion } = require('../services/inventory-units');
const { calculateInventoryCost } = require('../services/inventory-cost');

const row = (over) => ({ product_name: 'Synthetic product', usage_amount: 2, ...over });

describe('costLineFromUsage prices usage only in a unit its cost converts to', () => {
  test('a count usage against a per-gallon cost is an unknown cost, never 2 x $12', () => {
    const line = costLineFromUsage(row({ usage_unit: 'each', cost_per_unit: 12, cost_unit: 'gal' }));
    expect(line).toMatchObject({ cost: 0, usageAmount: 2 });
    expect(line.source).toBeUndefined();
    expect(line.warning).toBe('Synthetic product: usage in each cannot be priced per gal');
  });

  test('a weight usage against a volume cost is an unknown cost', () => {
    const line = costLineFromUsage(row({ usage_unit: 'lb', cost_per_unit: 40, cost_unit: 'gal' }));
    expect(line.source).toBeUndefined();
    expect(line.warning).toBe('Synthetic product: usage in lb cannot be priced per gal');
  });

  test('a measured usage against a count cost falls back to the package price when it has one', () => {
    const line = costLineFromUsage(row({
      usage_amount: 16, usage_unit: 'fl_oz', cost_per_unit: 50, cost_unit: 'each', best_price: 64, unit_size_oz: 128,
    }));
    expect(line).toMatchObject({ source: 'best_price_unit_size', cost: 8 });
    expect(line.warning).toBeUndefined();
  });

  test('count nouns convert only where the conversion is known', () => {
    expect(costLineFromUsage(row({ usage_unit: 'each', cost_per_unit: 60, cost_unit: 'case' })).warning)
      .toBe('Synthetic product: usage in each cannot be priced per case');
    expect(costLineFromUsage(row({ usage_unit: 'stations', cost_per_unit: 22.5, cost_unit: 'each' })))
      .toMatchObject({ source: 'cost_per_unit', cost: 45 });
    expect(costLineFromUsage(row({ usage_unit: 'ct', cost_per_unit: 3, cost_unit: 'each' })))
      .toMatchObject({ source: 'cost_per_unit', cost: 6 });
    expect(costLineFromUsage(row({ usage_unit: 'traps', cost_per_unit: 2.5, cost_unit: 'trap' })))
      .toMatchObject({ source: 'cost_per_unit', cost: 5 });
    expect(costLineFromUsage(row({ usage_unit: 'bottle', cost_per_unit: 9 })))
      .toMatchObject({ source: 'cost_per_unit', cost: 18 });
  });

  test('compatible measures still convert, and a bare oz stands in for either measure', () => {
    expect(costLineFromUsage(row({ usage_amount: 8, usage_unit: 'oz', cost_per_unit: 4, cost_unit: 'lb' })).cost).toBeCloseTo(2, 10);
    expect(costLineFromUsage(row({ usage_amount: 32, usage_unit: 'fl oz', cost_per_unit: 100, cost_unit: 'gal' })).cost).toBeCloseTo(25, 10);
    expect(costLineFromUsage(row({ usage_amount: 64, usage_unit: 'oz', cost_per_unit: 100, cost_unit: 'gal' })).cost).toBeCloseTo(50, 10);
    expect(costLineFromUsage(row({ usage_amount: 500, usage_unit: 'g', cost_per_unit: 10, cost_unit: 'kg' })).cost).toBeCloseTo(5, 10);
  });
});

describe('unit conversions keep their precision', () => {
  test('1 ml is 0.000264 gal, so 100 doses sum to 0.0264 gal, not 0.03', () => {
    const dose = convertInventoryQuantity(1, 'ml', 'gal');
    expect(dose).toBeCloseTo(0.033814 / 128, 12);
    let total = 0;
    for (let i = 0; i < 100; i += 1) total += dose;
    expect(Number(total.toFixed(4))).toBe(0.0264);
    expect(describeInventoryConversion(1, 'ml', 'gal')).toMatchObject({ convertible: true, amount: dose });
  });

  test('float noise is dropped and exact conversions stay exact', () => {
    expect(convertInventoryQuantity(3, 'ml', 'fl_oz')).toBe(0.101442);
    expect(convertInventoryQuantity(1, 'gal', 'fl_oz')).toBe(128);
    expect(convertInventoryQuantity(1, 'pound', 'lb')).toBe(1);
  });

  test('a 1 ml dose at $100/gal costs $0.0264, so 100 doses cost about $2.64, not $3.00', () => {
    const dose = convertInventoryQuantity(1, 'ml', 'gal');
    const { costUsed } = calculateInventoryCost({
      product: { cost_per_unit: 100, cost_unit: 'gal' }, deductedAmount: dose, inventoryUnit: 'gal', amount: 1, amountUnit: 'ml',
    });
    expect(costUsed).toBe(0.0264);
    expect(costUsed * 100).toBeCloseTo(2.64, 6);
  });
});
