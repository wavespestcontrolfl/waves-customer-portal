/**
 * The estimate pricing audit reads the service labels the product registry actually uses
 * ("Bora-Care Treatment", "German Roach Cleanout", "Cockroach Treatment"). The registry rows
 * keep their labels because the public product page groups products by them.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => false) };
  return fn;
});
const { inventoryCostFromRows } = require('../services/estimate-pricing-audit');

const row = (serviceType, productName, extra = {}) => ({
  service_type: serviceType,
  product_id: `${serviceType}:${productName}`,
  product_name: productName,
  usage_amount: 1,
  usage_unit: 'oz',
  usage_per_1000sf: null,
  notes: '',
  cost_per_unit: 2,
  cost_unit: 'oz',
  best_price: null,
  unit_size_oz: null,
  ...extra,
});
const boraCare = { usage_unit: 'gal', usage_per_1000sf: 3.64, cost_per_unit: null, cost_unit: null, best_price: 91.98, unit_size_oz: 128 };
const registry = {
  available: true,
  rows: [
    row('Bora-Care Treatment', 'Bora-Care', boraCare),
    row('Termite Wood Treatment', 'Bora-Care', boraCare),
    row('German Roach Cleanout', 'Alpine WSG'),
    row('German Roach Cleanout', 'Gentrol IGR'),
    row('Cockroach Treatment', 'Alpine WSG'),
    row('Cockroach Treatment', 'JT Eaton glue board', { usage_amount: 4, usage_unit: 'boards', cost_per_unit: 0.3936, cost_unit: 'each' }),
  ],
};

describe('estimate pricing audit reads the registry service labels', () => {
  test('Bora-Care costs from "Bora-Care Treatment" only (the wood-treatment copy is not added on top)', () => {
    const cogs = inventoryCostFromRows('bora_care', { homeSqFt: 2000 }, registry);
    expect(cogs.status).toBe('ok');
    expect(cogs.matchedServiceType).toBe('Bora-Care Treatment');
    expect(cogs.lines).toHaveLength(1);
    // 3.64 gal per 1,000 sq ft x 2,000 sq ft = 7.28 gal of a 128 oz / $91.98 gallon.
    expect(cogs.totalPerVisit).toBeCloseTo(669.61, 2);
  });

  test('German roach work costs from "German Roach Cleanout"', () => {
    for (const key of ['german_roach', 'german_roach_initial']) {
      const cogs = inventoryCostFromRows(key, { homeSqFt: 2000 }, registry);
      expect(cogs.matchedServiceType).toBe('German Roach Cleanout');
      expect(cogs.lines.map((l) => l.productName)).toEqual(['Alpine WSG', 'Gentrol IGR']);
      expect(cogs.totalPerVisit).toBe(4);
    }
  });

  test('the cockroach add-on costs from "Cockroach Treatment"', () => {
    const cogs = inventoryCostFromRows('pest_initial_roach', { homeSqFt: 2000 }, registry);
    expect(cogs.matchedServiceType).toBe('Cockroach Treatment');
    expect(cogs.lines.map((l) => l.productName)).toEqual(['Alpine WSG', 'JT Eaton glue board']);
    // $2 of Alpine + 4 boards x $0.3936, rounded to cents.
    expect(cogs.totalPerVisit).toBe(3.57);
  });

  test('a row under the canonical label still wins over the registry label', () => {
    const withCanonical = { ...registry, rows: [...registry.rows, row('German Roach', 'Canonical product')] };
    const cogs = inventoryCostFromRows('german_roach', { homeSqFt: 2000 }, withCanonical);
    expect(cogs.matchedServiceType).toBe('German Roach');
    expect(cogs.lines.map((l) => l.productName)).toEqual(['Canonical product']);
  });
});
