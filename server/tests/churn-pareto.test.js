const { buildChurnPareto } = require('../services/churn-pareto');

describe('buildChurnPareto', () => {
  test('orders by lost MRR descending with a running cumulative %', () => {
    const out = buildChurnPareto([
      { code: 'price', customers: 3, mrr: 210 },
      { code: 'moving', customers: 5, mrr: 400 },
      { code: 'service_quality', customers: 1, mrr: 90 },
    ]);
    expect(out.reasons.map((r) => r.code)).toEqual(['moving', 'price', 'service_quality', 'unclassified']);
    expect(out.totals).toEqual({ customers: 9, mrr: 700 });
    expect(out.reasons[0].mrrShare).toBe(57.1);
    expect(out.reasons[1].cumulativePct).toBe(87.1); // (400+210)/700
    expect(out.reasons[3].cumulativePct).toBe(100);
  });

  test('unclassified is ALWAYS present — injected at zero when absent, and NULL codes coalesce into it', () => {
    const withNulls = buildChurnPareto([
      { code: null, customers: 4, mrr: 300 },
      { code: 'weird_legacy_value', customers: 1, mrr: 50 },
      { code: 'price', customers: 2, mrr: 100 },
    ]);
    const un = withNulls.reasons.find((r) => r.code === 'unclassified');
    expect(un.customers).toBe(5); // null + unknown value both land here
    expect(un.mrr).toBe(350);
    expect(withNulls.unclassifiedShare).toBe(71.4); // 5 of 7 churned accounts unexplained

    const empty = buildChurnPareto([]);
    expect(empty.reasons).toEqual([
      { code: 'unclassified', label: 'Unclassified', customers: 0, mrr: 0, mrrShare: 0, cumulativePct: 0 },
    ]);
    expect(empty.unclassifiedShare).toBe(0);
  });

  test('pg string aggregates coerce; shares never NaN', () => {
    const out = buildChurnPareto([{ code: 'price', customers: '2', mrr: '178.50' }]);
    expect(out.reasons[0].mrr).toBe(178.5);
    expect(out.reasons[0].mrrShare).toBe(100);
    expect(out.unclassifiedShare).toBe(0);
  });
});
