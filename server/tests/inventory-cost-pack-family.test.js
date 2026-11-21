// calculateInventoryCost prices an amount as its share of one best_price package only when the amount and the package
// measure the same thing. unit_size_oz is a bare ounce count; the package label (container_size) says whether those ounces
// are weight or fluid. Half a gallon logged against a 13.5 g packet once booked 133 packets for one visit.
const { calculateInventoryCost } = require('../services/inventory-cost');
const onslaughtLabel = require('../models/migrations/20261120203000_onslaught_fastcap_pack_label');

// A 13.5 g packet (0.48 oz by weight) at $12, the shape of a weighed herbicide packet.
const PACKET = { container_size: '13.5 g', unit_size_oz: 0.48, best_price: 12, cost_per_unit: null };
// A 1 gal jug (128 fl oz) at $64.
const JUG = { container_size: '1 gal', unit_size_oz: 128, best_price: 64, cost_per_unit: null };
const UNCOSTED = { unitCost: null, costUsed: null };

const price = (product, amount, amountUnit, inventoryUnit = amountUnit) => calculateInventoryCost({
  product, amount, amountUnit, inventoryUnit, deductedAmount: amount,
});

describe('calculateInventoryCost prices a package share only in the package\'s own measure', () => {
  test('a volume amount never prices against a weight package', () => {
    expect(price(PACKET, 0.5, 'gal')).toEqual(UNCOSTED);
    expect(price(PACKET, 2, 'fl_oz')).toEqual(UNCOSTED);
    expect(price({ container_size: '2.5 lb', unit_size_oz: 40, best_price: 30, cost_per_unit: null }, 1, 'qt')).toEqual(UNCOSTED);
  });

  test('a weight amount never prices against a fluid package', () => {
    expect(price(JUG, 2, 'lb')).toEqual(UNCOSTED);
    expect(price(JUG, 30, 'g')).toEqual(UNCOSTED);
    expect(price({ container_size: '946 ml', unit_size_oz: 32, best_price: 20, cost_per_unit: null }, 1, 'lb')).toEqual(UNCOSTED);
  });

  test('the same measure still prices its share', () => {
    expect(price(PACKET, 0.9, 'g').costUsed).toBeCloseTo(0.7937, 4);
    expect(price(JUG, 4, 'fl_oz')).toEqual({ unitCost: 0.5, costUsed: 2 });
    expect(price(JUG, 0.5, 'gal')).toEqual({ unitCost: 0.5, costUsed: 32 });
  });

  test('a label with a plain oz or no size leaves the measure to the stock unit', () => {
    // A 1.33 oz jar of a weighed powder, stocked in g.
    const jar = { container_size: '1.33 oz', inventory_unit: 'g', unit_size_oz: 1.33, best_price: 70, cost_per_unit: null };
    expect(price(jar, 0.5, 'gal')).toEqual(UNCOSTED);
    expect(price(jar, 19, 'g').costUsed).toBeCloseTo(35.274, 4); // 19 g = 0.670206 oz of the 1.33 oz jar
    expect(price({ ...JUG, container_size: null, inventory_unit: 'fl_oz' }, 2, 'lb')).toEqual(UNCOSTED);
    expect(price({ ...JUG, container_size: '1 jug', inventory_unit: 'gal' }, 4, 'fl_oz')).toEqual({ unitCost: 0.5, costUsed: 2 });
  });

  test('the importer\'s "16 fl_oz" spelling reads as 16 fl oz, with no stock unit to fall back on', () => {
    const bottle = { container_size: '16 fl_oz', inventory_unit: null, unit_size_oz: 16, best_price: 32, cost_per_unit: null };
    expect(price(bottle, 1, 'lb')).toEqual(UNCOSTED);
    expect(price(bottle, 4, 'fl_oz')).toEqual({ unitCost: 2, costUsed: 8 });
  });

  test('punctuation around the unit is set aside: "30 fl. oz.", "8 fl-oz", "13.5-g packet"; "2.5 lb." keeps its decimal', () => {
    const dotted = { container_size: '30 fl. oz.', inventory_unit: null, unit_size_oz: 30, best_price: 60, cost_per_unit: null };
    expect(price(dotted, 1, 'lb')).toEqual(UNCOSTED);
    expect(price(dotted, 3, 'fl_oz')).toEqual({ unitCost: 2, costUsed: 6 });
    expect(price({ ...dotted, container_size: '8 fl-oz', unit_size_oz: 8 }, 1, 'lb')).toEqual(UNCOSTED);
    expect(price({ ...PACKET, container_size: '13.5-g packet' }, 0.5, 'gal')).toEqual(UNCOSTED);
    expect(price({ ...PACKET, container_size: '13.5-g packet' }, 0.24, 'oz')).toEqual({ unitCost: 25, costUsed: 6 });
    const bag = { container_size: '2.5 lb.', inventory_unit: null, unit_size_oz: 40, best_price: 30, cost_per_unit: null };
    expect(price(bag, 1, 'qt')).toEqual(UNCOSTED);
    expect(price(bag, 8, 'oz')).toEqual({ unitCost: 0.75, costUsed: 6 });
  });

  test('a label that names a measure outranks the stock unit', () => {
    expect(price({ ...JUG, inventory_unit: 'g' }, 4, 'fl_oz')).toEqual({ unitCost: 0.5, costUsed: 2 });
    expect(price({ ...JUG, inventory_unit: 'g' }, 30, 'g')).toEqual(UNCOSTED);
  });

  test('a plain oz amount, or a package nothing measures, still prices', () => {
    expect(price(PACKET, 0.24, 'oz')).toEqual({ unitCost: 25, costUsed: 6 });
    expect(price({ ...JUG, container_size: '128 oz' }, 2, 'lb')).toEqual({ unitCost: 0.5, costUsed: 16 });
    expect(price({ ...JUG, container_size: null }, 4, 'fl_oz')).toEqual({ unitCost: 0.5, costUsed: 2 });
    expect(price({ ...JUG, container_size: '1 jug', inventory_unit: 'oz' }, 2, 'lb')).toEqual({ unitCost: 0.5, costUsed: 16 });
  });

  test('a unit cost prices first, whatever the package label says', () => {
    const product = { ...PACKET, cost_per_unit: 3.95, cost_unit: 'fl_oz' };
    expect(price(product, 2, 'fl_oz')).toEqual({ unitCost: 3.95, costUsed: 7.9 });
  });

  test('Onslaught Fastcap keeps its cost with the label its migration writes, and loses it with the old one', () => {
    // Production's row (read 2026-11-20): a liquid stocked in fl oz, 16 fl oz at the SiteOne gallon's $3.9483 per fl oz.
    const row = { unit_size_oz: onslaughtLabel.UNIT_SIZE_OZ, best_price: 63.17, cost_per_unit: null };
    // 1.78 fl oz is the latest live usage movement, which booked 7.0277.
    expect(price({ ...row, container_size: onslaughtLabel.NEW_LABEL }, 1.78, 'fl_oz')).toEqual({ unitCost: 3.9481, costUsed: 7.0277 });
    expect(price({ ...row, container_size: onslaughtLabel.OLD_LABEL }, 1.78, 'fl_oz')).toEqual(UNCOSTED);
  });
});

// The protocol and estimate costs (pricing setup preview, estimate pricing audit, inventory COGS, knowledge base) price
// a usage row's package share with costLineFromUsage. It applies the same check, so the same half gallon is no line there.
describe('costLineFromUsage prices a package share only in the package\'s own measure', () => {
  const { costLineFromUsage } = require('../services/product-costing');
  const usage = (product, usageAmount, usageUnit) => costLineFromUsage({
    product_name: 'Synthetic product', usage_amount: usageAmount, usage_unit: usageUnit, ...product,
  });

  test('a measure clash is an unknown cost with its reason, never a package share', () => {
    expect(usage(PACKET, 0.5, 'gal')).toEqual({
      cost: 0, usageAmount: 0.5, warning: 'Synthetic product: usage in gal cannot be priced from its weight package',
    });
    expect(usage(JUG, 2, 'lb').warning).toBe('Synthetic product: usage in lb cannot be priced from its volume package');
    const jar = { container_size: '1.33 oz', inventory_unit: 'g', unit_size_oz: 1.33, best_price: 70, cost_per_unit: null };
    expect(usage(jar, 0.5, 'gal').warning).toBe('Synthetic product: usage in gal cannot be priced from its weight package');
    const dotted = { container_size: '30 fl. oz', inventory_unit: null, unit_size_oz: 30, best_price: 60, cost_per_unit: null };
    expect(usage(dotted, 1, 'lb').warning).toBe('Synthetic product: usage in lb cannot be priced from its volume package');
    expect(usage({ ...PACKET, container_size: '13.5-g packet' }, 0.5, 'gal').warning)
      .toBe('Synthetic product: usage in gal cannot be priced from its weight package');
  });

  test('the same measure, or a plain oz, still prices its share', () => {
    expect(usage(PACKET, 0.9, 'g')).toMatchObject({ source: 'best_price_unit_size', usageAmount: 0.9 });
    expect(usage(PACKET, 0.9, 'g').cost).toBeCloseTo(0.7937, 4);
    expect(usage(PACKET, 0.24, 'oz')).toEqual({ cost: 6, source: 'best_price_unit_size', usageAmount: 0.24 });
    expect(usage(JUG, 0.5, 'gal')).toEqual({ cost: 32, source: 'best_price_unit_size', usageAmount: 0.5 });
  });

  test('a unit-cost mismatch keeps its own warning when the package cannot price the usage either', () => {
    const product = { ...PACKET, cost_per_unit: 5, cost_unit: 'each' };
    expect(usage(product, 0.5, 'gal').warning).toBe('Synthetic product: usage in gal cannot be priced per each');
  });
});
