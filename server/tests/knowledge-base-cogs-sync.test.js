jest.mock('../models/db', () => jest.fn());

const { _internals } = require('../services/knowledge-base');

const { cogsLineForUsage, cogsTotalLine } = _internals;

const row = (over) => ({
  product_name: 'Sample SC',
  active_ingredient: 'Fipronil 9.1%',
  best_price: '174.72',
  usage_amount: '1.0000',
  usage_unit: 'bottle',
  usage_per_1000sf: null,
  notes: '',
  ...over,
});

describe('KB COGS sync lines', () => {
  test('flat row keeps the per-application cost', () => {
    const c = cogsLineForUsage(row());
    expect(c).toMatchObject({ fixed: 174.72, per1000: 0 });
    expect(c.line).toBe('- Sample SC (Fipronil 9.1%): 1.0000 bottle @ $174.72 = $174.72');
  });

  test('area row states the per-1,000 sq ft rate instead of the flat fallback', () => {
    const c = cogsLineForUsage(row({ usage_per_1000sf: '1.0300' }));
    expect(c.fixed).toBe(0);
    expect(c.per1000).toBeCloseTo(179.96, 2);
    expect(c.line).toBe('- Sample SC (Fipronil 9.1%): 1.03 bottle per 1,000 sq ft @ $174.72 = $179.96 per 1,000 sq ft');
  });

  test('base-plus row carries both the flat and the area part', () => {
    const c = cogsLineForUsage(row({ usage_amount: '0.5', usage_per_1000sf: '0.25', notes: '[usage:base_plus_per_1000]', best_price: '100' }));
    expect(c).toMatchObject({ fixed: 50, per1000: 25 });
    expect(c.line).toContain('0.5 bottle + 0.25 bottle per 1,000 sq ft');
  });

  test('max row names the flat floor', () => {
    const c = cogsLineForUsage(row({ usage_amount: '0.5', usage_per_1000sf: '0.25', notes: '[usage:max_base_or_per_1000]', best_price: '100' }));
    expect(c).toMatchObject({ fixed: 0, per1000: 25 });
    expect(c.line).toContain('at least 0.5 bottle ($50.00)');
  });

  test('totals', () => {
    expect(cogsTotalLine(174.72, 0)).toBe('Total COGS per application: $174.72');
    expect(cogsTotalLine(0, 179.96)).toBe('Total COGS per application: $179.96 per 1,000 sq ft');
    expect(cogsTotalLine(50, 25)).toBe('Total COGS per application: $50.00 + $25.00 per 1,000 sq ft');
  });
});
