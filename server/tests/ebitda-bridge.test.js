const { buildEbitdaBridge } = require('../services/ebitda-bridge');

describe('buildEbitdaBridge', () => {
  const FULL = {
    revenue: 20000,
    grossProfit: 11000, // 55% fully-burdened
    marketing: { adSpend: 1500, fixedCosts: 500, referralRewards: 100 },
    overhead: { vehicleMonthly: 850, insuranceMonthly: 400, softwareMonthly: 350, adminMonthly: 1000 },
    monthFraction: 1,
  };

  test('full waterfall: revenue → GP → contribution → adjusted EBITDA', () => {
    const b = buildEbitdaBridge(FULL);
    expect(b.cogs).toBe(9000);
    expect(b.grossProfit).toBe(11000);
    expect(b.grossMarginPct).toBe(55);
    expect(b.marketing.total).toBe(2100);
    expect(b.contribution).toBe(8900);
    expect(b.overhead.total).toBe(2600);
    expect(b.overheadEntered).toBe(true);
    expect(b.ebitda).toBe(6300);
    expect(b.ebitdaMarginPct).toBe(31.5);
    expect(b.rows.map((r) => r.key)).toEqual([
      'revenue', 'cogs', 'gross_profit', 'marketing', 'contribution', 'overhead', 'ebitda',
    ]);
    // Deduction rows carry negative amounts; the result row is the EBITDA.
    expect(b.rows.find((r) => r.key === 'cogs').amount).toBe(-9000);
    expect(b.rows.find((r) => r.key === 'ebitda').kind).toBe('result');
  });

  test('EBITDA is never mixed into gross margin — GP and margins are computed before opex', () => {
    const b = buildEbitdaBridge(FULL);
    // Gross margin stays the job-level 55% no matter what opex does…
    expect(b.grossMarginPct).toBe(55);
    // …while the company-level EBITDA margin sits below it.
    expect(b.ebitdaMarginPct).toBeLessThan(b.grossMarginPct);
  });

  test('unentered overhead stops the waterfall at Contribution (never a fake EBITDA)', () => {
    for (const overhead of [null, undefined, {}, { vehicleMonthly: 0, insuranceMonthly: 0 }]) {
      const b = buildEbitdaBridge({ ...FULL, overhead });
      expect(b.overheadEntered).toBe(false);
      expect(b.overhead).toBeNull();
      expect(b.ebitda).toBeNull();
      expect(b.ebitdaMarginPct).toBeNull();
      const last = b.rows[b.rows.length - 1];
      expect(last.key).toBe('contribution');
      expect(last.kind).toBe('result');
    }
  });

  test('monthFraction prorates ONLY the monthly overhead, never the marketing actuals', () => {
    const b = buildEbitdaBridge({ ...FULL, monthFraction: 0.5 });
    expect(b.overhead.total).toBe(1300); // 2600 × 0.5
    expect(b.marketing.total).toBe(2100); // untouched — already window actuals
    expect(b.ebitda).toBe(7600);
    expect(b.monthFraction).toBe(0.5);
  });

  test('monthFraction is clamped to (0, 1] and garbage falls back to 1', () => {
    expect(buildEbitdaBridge({ ...FULL, monthFraction: 1.7 }).overhead.total).toBe(2600);
    expect(buildEbitdaBridge({ ...FULL, monthFraction: 0 }).overhead.total).toBe(2600);
    expect(buildEbitdaBridge({ ...FULL, monthFraction: NaN }).overhead.total).toBe(2600);
  });

  test('negative adjusted EBITDA is reported, not clamped', () => {
    const b = buildEbitdaBridge({ ...FULL, revenue: 5000, grossProfit: 2000 });
    expect(b.contribution).toBe(-100);
    expect(b.ebitda).toBe(-2700);
    expect(b.ebitdaMarginPct).toBe(-54);
  });

  test('zero revenue: margins are null (not 0% or Infinity), amounts still bridge', () => {
    const b = buildEbitdaBridge({
      revenue: 0, grossProfit: 0,
      marketing: { adSpend: 200 },
      overhead: { vehicleMonthly: 850 },
    });
    expect(b.grossMarginPct).toBeNull();
    expect(b.contributionMarginPct).toBeNull();
    expect(b.ebitdaMarginPct).toBeNull();
    expect(b.contribution).toBe(-200);
    expect(b.ebitda).toBe(-1050);
  });

  test('missing inputs coerce to zero instead of NaN', () => {
    const b = buildEbitdaBridge({});
    expect(b.revenue).toBe(0);
    expect(b.marketing.total).toBe(0);
    expect(b.contribution).toBe(0);
    expect(b.ebitda).toBeNull(); // no overhead entered
    expect(b.rows.every((r) => Number.isFinite(r.amount))).toBe(true);
  });
});
