/**
 * P&L report builder — pure-function regression tests.
 *
 * Guards the three prod failure modes the 2026-07-20 financial-reporting
 * audit found (all-zero P&L): dead revenue/labor queries are covered by the
 * schema-verified queries in buildPnlReport (validated read-only against prod);
 * these tests pin the PURE math so it can't regress silently:
 *   1. Uncategorized (NULL-category) expenses must appear in opex — the old
 *      whereNotIn dropped ALL 137 prod expenses.
 *   2. Labor cost derives from job minutes × loaded rate (the summary table
 *      has no cost column).
 *   3. Depreciation prorates per-asset and ignores §179/bonus assets
 *      (annual_depreciation NULL).
 */

const {
  assemblePnl,
  prorateDepreciation,
  getPeriodRange,
  missingTableOnly,
  DEFAULT_LOADED_LABOR_RATE,
} = require('../services/pnl-report');

describe('missingTableOnly', () => {
  test('substitutes the fallback only for undefined_table (42P01)', () => {
    const err = new Error('relation "mileage_log" does not exist');
    err.code = '42P01';
    expect(missingTableOnly({ total: '0' })(err)).toEqual({ total: '0' });
  });

  test('rethrows every other error — no silent zeros', () => {
    const err = new Error('column "payment_date" does not exist');
    err.code = '42703';
    expect(() => missingTableOnly({ total: '0' })(err)).toThrow('payment_date');
    expect(() => missingTableOnly([])(new Error('connection refused'))).toThrow('connection refused');
  });
});

describe('assemblePnl', () => {
  test('includes NULL-category expenses as Uncategorized opex', () => {
    const out = assemblePnl({
      serviceRevenue: 1000,
      opexRows: [
        { category: null, irs_line: null, total: '137.50' },
        { category: 'Insurance', irs_line: '15', total: '200.00' },
        { category: null, irs_line: null, total: '62.50' },
      ],
    });
    const uncat = out.operatingExpenses.categories.find(c => c.name === 'Uncategorized');
    expect(uncat).toBeDefined();
    expect(uncat.amount).toBe(200); // 137.50 + 62.50 merged into one bucket
    expect(out.operatingExpenses.total).toBe(400);
    expect(out.netIncome).toBe(600);
  });

  test('labor cost = job minutes / 60 × loaded rate', () => {
    const out = assemblePnl({
      serviceRevenue: 500,
      laborMinutes: 90,
      loadedLaborRate: 40,
    });
    expect(out.cogs.labor).toBe(60); // 1.5h × $40
    expect(out.cogs.total).toBe(60);
    expect(out.grossProfit).toBe(440);
  });

  test('defaults the labor rate when company_financials is empty', () => {
    const out = assemblePnl({ serviceRevenue: 100, laborMinutes: 60 });
    expect(out.cogs.labor).toBe(DEFAULT_LOADED_LABOR_RATE);
  });

  test('empty period yields zeros with zero margins, not NaN', () => {
    const out = assemblePnl({});
    expect(out.revenue.total).toBe(0);
    expect(out.grossMargin).toBe(0);
    expect(out.netMargin).toBe(0);
    expect(out.netIncome).toBe(0);
  });

  test('full stack: revenue − cogs − opex − deductions', () => {
    const out = assemblePnl({
      serviceRevenue: 10000,
      laborMinutes: 600, // 10h
      loadedLaborRate: 35, // $350
      materialsCost: 650,
      opexRows: [{ category: 'Rent', irs_line: '20b', total: '1000' }],
      mileageDeduction: 700,
      depreciationTotal: 300,
    });
    expect(out.cogs.total).toBe(1000);
    expect(out.grossProfit).toBe(9000);
    expect(out.deductions.total).toBe(1000);
    expect(out.netIncome).toBe(7000);
    expect(out.netMargin).toBeCloseTo(0.7, 5);
  });
});

describe('prorateDepreciation', () => {
  const year = { start: '2026-01-01', end: '2026-12-31' };

  test('full-year asset takes its full annual amount', () => {
    const total = prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2025-06-01' }],
      year.start, year.end,
    );
    expect(total).toBe(365);
  });

  test('mid-year in-service date prorates by days', () => {
    const total = prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2026-12-01' }],
      year.start, year.end,
    );
    expect(total).toBe(31); // Dec 1–31 inclusive at $1/day
  });

  test('§179/bonus assets (annual NULL) and future assets contribute nothing', () => {
    const total = prorateDepreciation(
      [
        { annual_depreciation: null, placed_in_service_date: '2026-01-01' },
        { annual_depreciation: '365', placed_in_service_date: '2027-03-01' },
      ],
      year.start, year.end,
    );
    expect(total).toBe(0);
  });
});

describe('getPeriodRange', () => {
  // Noon UTC = morning ET, no DST edge — deterministic ET calendar day.
  const now = new Date('2026-07-20T12:00:00Z');

  test('ytd runs Jan 1 through today (ET)', () => {
    expect(getPeriodRange('ytd', {}, now)).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-07-20',
    });
  });

  test('last_month resolves the full previous ET month', () => {
    expect(getPeriodRange('last_month', {}, now)).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
  });

  test('last_month across the January boundary', () => {
    expect(getPeriodRange('last_month', {}, new Date('2026-01-15T12:00:00Z'))).toEqual({
      startDate: '2025-12-01',
      endDate: '2025-12-31',
    });
  });

  test('custom without both dates is null (route 400s)', () => {
    expect(getPeriodRange('custom', { start_date: '2026-01-01' }, now)).toBeNull();
  });

  test('custom passes explicit dates through', () => {
    expect(getPeriodRange('custom', { start_date: '2026-02-01', end_date: '2026-02-28' }, now)).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
  });
});
