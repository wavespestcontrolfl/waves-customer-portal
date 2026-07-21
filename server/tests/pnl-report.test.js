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
  rateAsOf,
  costLaborByDay,
  dateCellStr,
  DEFAULT_LOADED_LABOR_RATE,
  REFUND_TXN_TYPES,
  DISPUTE_TXN_TYPES,
} = require('../services/pnl-report');

describe('outflow transaction type sets', () => {
  test('refunds net card/bank refunds and bounced-refund reversals, never failed-payment reversals', () => {
    expect(REFUND_TXN_TYPES).toEqual(expect.arrayContaining(['refund', 'payment_refund', 'refund_failure']));
    // payment_failure_refund reverses a PENDING ACH payment whose payments
    // row is status='failed' and was never counted as a receipt — including
    // it would subtract cash the revenue side never added (double
    // subtraction, can drive revenue negative). Regression for the round-3
    // pre-push P0.
    expect(REFUND_TXN_TYPES).not.toContain('payment_failure_refund');
  });

  test('disputes net via adjustment/payment_reversal — open subtracts, won adds back, lost stays', () => {
    // SUM(-amount) semantics over Stripe's dispute carriers: dispute.created
    // posts a NEGATIVE adjustment (subtract), a won dispute posts a POSITIVE
    // one (net back to zero), a lost dispute posts nothing further (stays
    // subtracted). ACH-debit disputes ride payment_reversal. Deposit
    // chargebacks are covered because deposit receipts stay on the received
    // side and the loss shows here in its own period.
    expect(DISPUTE_TXN_TYPES).toEqual(['adjustment', 'payment_reversal']);
    const sumNegated = (rows) => rows.reduce((s, r) => s - r.amount, 0);
    expect(sumNegated([{ amount: -150 }])).toBe(150); // open: revenue down
    expect(sumNegated([{ amount: -150 }, { amount: 150 }])).toBe(0); // won
    expect(sumNegated([{ amount: -150 }])).toBe(150); // lost: no reversal row
  });
});

describe('dateCellStr', () => {
  test('renders node-postgres DATE cells (local-midnight Dates) without a day shift', () => {
    // node-postgres parses DATE '2026-07-01' to local midnight — LOCAL
    // getters must yield the same calendar day in any server zone.
    expect(dateCellStr(new Date(2026, 6, 1))).toBe('2026-07-01');
  });

  test('passes strings through by prefix and empties nulls', () => {
    expect(dateCellStr('2026-07-01T00:00:00.000Z')).toBe('2026-07-01');
    expect(dateCellStr(null)).toBe('');
  });
});

describe('rateAsOf / costLaborByDay', () => {
  const rates = [
    { effective_date: '2026-01-01', loaded_labor_rate: '30' },
    { effective_date: '2026-04-01', loaded_labor_rate: '40' },
  ];

  test('picks the rate in force on each day', () => {
    expect(rateAsOf(rates, '2026-03-31')).toBe(30);
    expect(rateAsOf(rates, '2026-04-01')).toBe(40);
    expect(rateAsOf([], '2026-04-01')).toBe(DEFAULT_LOADED_LABOR_RATE);
    expect(rateAsOf(rates, '2025-12-31')).toBe(DEFAULT_LOADED_LABOR_RATE); // before first row
  });

  test('a mid-period rate change does NOT reprice earlier days', () => {
    const { laborMinutes, laborCost } = costLaborByDay(
      [
        { work_date: '2026-03-15', total_job_minutes: '60' }, // 1h @ $30
        { work_date: '2026-04-15', total_job_minutes: '60' }, // 1h @ $40
      ],
      rates,
    );
    expect(laborMinutes).toBe(120);
    expect(laborCost).toBe(70); // not 80 (all-at-latest) or 60 (all-at-first)
  });
});

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

  test('labor cost flows into COGS', () => {
    const out = assemblePnl({ serviceRevenue: 500, laborCost: 60 });
    expect(out.cogs.labor).toBe(60);
    expect(out.cogs.total).toBe(60);
    expect(out.grossProfit).toBe(440);
  });

  test('synced Stripe fees reduce net income as their own opex category', () => {
    const out = assemblePnl({
      serviceRevenue: 1000,
      opexRows: [{ category: 'Insurance', irs_line: '15', total: '100' }],
      processingFees: 29.32,
    });
    const feeCat = out.operatingExpenses.categories.find(c => c.name === 'Stripe Processing Fees (synced)');
    expect(feeCat?.amount).toBe(29.32);
    expect(out.operatingExpenses.total).toBe(129.32);
    expect(out.netIncome).toBe(870.68);
    // Zero fees add no synthetic category.
    const none = assemblePnl({ serviceRevenue: 100 });
    expect(none.operatingExpenses.categories).toHaveLength(0);
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
      laborCost: 350, // 10h × $35 via costLaborByDay
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

  test('disposal caps proration instead of deleting history', () => {
    // Disposed Jan 31: January's depreciation survives in historical P&Ls.
    const total = prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2025-01-01', disposal_date: '2026-01-31' }],
      year.start, year.end,
    );
    expect(total).toBe(31);
    // A pre-period disposal contributes nothing.
    expect(prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2025-01-01', disposal_date: '2025-06-30' }],
      year.start, year.end,
    )).toBe(0);
  });

  test('a full LEAP year yields exactly the annual amount (not 366/365ths)', () => {
    const total = prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2023-06-01' }],
      '2024-01-01', '2024-12-31',
    );
    expect(total).toBe(365);
  });

  test('leap-year partial windows divide by that year\'s 366 days', () => {
    // Jan 1 – Jun 30 2024 = 182 days of a 366-day year.
    const total = prorateDepreciation(
      [{ annual_depreciation: '366', placed_in_service_date: '2023-01-01' }],
      '2024-01-01', '2024-06-30',
    );
    expect(total).toBe(182);
  });

  test('a 365-day window spanning two calendar years sums per-year slices to one annual', () => {
    const total = prorateDepreciation(
      [{ annual_depreciation: '365', placed_in_service_date: '2024-01-01' }],
      '2025-07-01', '2026-06-30',
    );
    expect(total).toBe(365);
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
