jest.mock('../models/db', () => jest.fn());

const { _internals } = require('../services/knowledge-base');

const { cogsLineForUsage, cogsTotalLine } = _internals;

const row = (over) => ({
  product_name: 'Sample SC',
  active_ingredient: 'Fipronil 9.1%',
  best_price: '174.72',
  unit_size_oz: '78.00',
  cost_per_unit: null,
  cost_unit: null,
  usage_amount: '1.0000',
  usage_unit: 'bottle',
  usage_per_1000sf: null,
  notes: '',
  ...over,
});

describe('KB COGS sync lines', () => {
  test('whole-container usage prices at the package', () => {
    const c = cogsLineForUsage(row());
    expect(c.term).toEqual({ fixed: 174.72, per1000: 0 });
    expect(c.line).toBe('- Sample SC (Fipronil 9.1%): 1.0000 bottle @ $174.72/bottle = $174.72');
  });

  test('area row states the per-1,000 sq ft rate instead of the flat fallback', () => {
    const c = cogsLineForUsage(row({ usage_per_1000sf: '1.0300' }));
    expect(c.term.fixed).toBe(0);
    expect(c.term.per1000).toBeCloseTo(179.96, 2);
    expect(c.line).toBe('- Sample SC (Fipronil 9.1%): 1.03 bottle per 1,000 sq ft @ $174.72/bottle = $179.96 per 1,000 sq ft');
  });

  test('ounce usage is priced per ounce of the package, not the whole package', () => {
    // 32 oz jug at $161.30 → $5.04/oz; 0.125 oz per 1,000 sq ft ≈ $0.63
    const c = cogsLineForUsage(row({ best_price: '161.30', unit_size_oz: '32', usage_amount: null, usage_unit: 'oz', usage_per_1000sf: '0.125' }));
    expect(c.term.per1000).toBeCloseTo(0.63, 2);
    expect(c.line).toContain('@ $5.04/oz = $0.63 per 1,000 sq ft');
  });

  test('cost_per_unit wins when set', () => {
    const c = cogsLineForUsage(row({ cost_per_unit: '2', cost_unit: 'oz', usage_amount: '3', usage_unit: 'oz' }));
    expect(c.term.fixed).toBe(6);
  });

  test('base-plus row carries both the flat and the area part', () => {
    const c = cogsLineForUsage(row({ usage_amount: '0.5', usage_per_1000sf: '0.25', notes: '[usage:base_plus_per_1000]', best_price: '100' }));
    expect(c.term).toEqual({ fixed: 50, per1000: 25 });
    expect(c.line).toContain('0.5 bottle + 0.25 bottle per 1,000 sq ft');
  });

  test('max row keeps its floor as its own term', () => {
    const c = cogsLineForUsage(row({ usage_amount: '3', usage_unit: 'oz', unit_size_oz: '100', best_price: '100', usage_per_1000sf: '0.5', notes: '[usage:max_base_or_per_1000]' }));
    expect(c.term).toEqual({ floor: 3, per1000: 0.5 });
    expect(c.line).toContain('greater of 3 oz or 0.5 oz per 1,000 sq ft');
    expect(cogsTotalLine([{ fixed: 10, per1000: 2 }, c.term]))
      .toBe('Total COGS per application: $10.00 + $2.00 per 1,000 sq ft + the greater of $3.00 or $0.50 per 1,000 sq ft');
  });

  test('unpriceable sub-package usage is called out, not guessed', () => {
    const c = cogsLineForUsage(row({ unit_size_oz: null, usage_unit: 'oz' }));
    expect(c.term).toBeNull();
    expect(c.line).toContain('cost unavailable');
    expect(cogsTotalLine([{ fixed: 5, per1000: 0 }, null])).toBe('Total COGS per application: $5.00 (excludes 1 product with no normalized price)');
  });

  test('counted usage prices one piece of a counted pack', () => {
    const tube = cogsLineForUsage(row({ best_price: '28.94', container_size: '4 x 30g tubes', unit_size_oz: '4.23', usage_unit: 'tube' }));
    expect(tube.line).toContain('@ $7.24/tube = $7.24');
    const traps = cogsLineForUsage(row({ best_price: '8.52', container_size: '1 trap', unit_size_oz: null, usage_amount: '6', usage_unit: 'traps' }));
    expect(traps.term.fixed).toBeCloseTo(51.12, 2);
    const packets = cogsLineForUsage(row({ best_price: '163.56', container_size: '500 g', unit_size_oz: '17.64', usage_amount: '0.5', usage_unit: 'packets' }));
    expect(packets.term).toBeNull();
  });

  test('a generic counted pack resolves before the whole-package fallback', () => {
    const each = cogsLineForUsage(row({ best_price: '100', container_size: '20 count', unit_size_oz: null, usage_unit: 'each' }));
    expect(each.term.fixed).toBe(5);
  });

  test('totals', () => {
    expect(cogsTotalLine([{ fixed: 174.72, per1000: 0 }])).toBe('Total COGS per application: $174.72');
    expect(cogsTotalLine([{ fixed: 0, per1000: 179.96 }])).toBe('Total COGS per application: $179.96 per 1,000 sq ft');
    expect(cogsTotalLine([])).toBe('Total COGS per application: $0.00');
  });
});
