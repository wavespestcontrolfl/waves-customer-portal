/**
 * Buyer view (services/buyer-view.js), no database: the six metrics from stored monthly rows (sums, not averages of
 * ratios; a NULL month left out and counted; growth blank unless both 12-month runs are complete), the plan-revenue-kept
 * windows, and that one failing live query is one tile's { error }, never a failed payload. The real SQL runs in
 * buyer-view-postgres.test.js. Synthetic numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const view = require('../services/buyer-view');

// A stored row; months are 'YYYY-MM-01'. Month 1 = 2025-01 ... month 24 = 2026-12 for compactness.
const monthKey = (n) => `${2025 + Math.floor((n - 1) / 12)}-${String(((n - 1) % 12) + 1).padStart(2, '0')}-01`;
const row = (n, fields = {}) => ({
  month: monthKey(n), cash_revenue: 1000, completed_job_revenue: 1200, gross_margin_pct: 50, job_gross_profit: 600, book_gross_margin_pct: 40, book_gross_profit: 400, eligible_job_revenue: 1200,
  office_cost: 100, paid_stops: 10, owner_allowance: 0, owner_field_allowance: 0, owner_paid_profit: 200, sde: 300,
  recurring_revenue: 600, recurring_mature_revenue: 300, ...fields,
});
const run = (from, to, fields) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i, typeof fields === 'function' ? fields(from + i) : fields));

describe('splitWindows', () => {
  test('the newest 12 stored months and the 12 before them, picked by month number and returned oldest first', () => {
    const { window, prior } = view.splitWindows(run(1, 24).reverse());
    expect(window.map((r) => r.month)).toEqual(Array.from({ length: 12 }, (_, i) => monthKey(13 + i)));
    expect(prior.map((r) => r.month)).toEqual(Array.from({ length: 12 }, (_, i) => monthKey(1 + i)));
  });

  test('a gap in the stored months is a short window, not a stretched one', () => {
    const rows = run(13, 24).filter((r) => r.month !== monthKey(18));
    expect(view.splitWindows(rows).window).toHaveLength(11);
    expect(view.splitWindows([])).toEqual({ window: [], prior: [] });
  });
});

describe('revenue and growth', () => {
  test('growth compares two complete runs of 12 months', () => {
    const rows = [...run(1, 12, { cash_revenue: 800 }), ...run(13, 24, { cash_revenue: 900 })];
    expect(view.revenueMetric(view.splitWindows(rows))).toMatchObject({ value: 10800, priorValue: 9600, growthPct: 12.5, monthsCounted: 12, priorMonthsCounted: 12 });
  });

  test('growth is blank when the earlier run is short or the current one is, and the sum says how many months it holds', () => {
    const short = view.revenueMetric(view.splitWindows([...run(2, 12, { cash_revenue: 800 }), ...run(13, 24)]));
    expect(short).toMatchObject({ growthPct: null, priorMonthsCounted: 11, value: 12000 });
    const young = view.revenueMetric(view.splitWindows(run(19, 24)));
    expect(young).toMatchObject({ growthPct: null, value: 6000, monthsCounted: 6, priorMonthsCounted: 0 });
  });

  test('no earlier revenue gives no growth, never infinity', () => {
    const rows = [...run(1, 12, { cash_revenue: 0 }), ...run(13, 24)];
    expect(view.revenueMetric(view.splitWindows(rows)).growthPct).toBeNull();
  });
});

describe('the other tiles', () => {
  test('recurring share is plan revenue over completed-visit revenue; the mature part is shown against both', () => {
    expect(view.recurringMetric(view.splitWindows(run(1, 12)))).toMatchObject({ share: 50, matureShareOfRecurring: 50, matureShareOfRevenue: 25, monthsCounted: 12 });
  });

  test('a month stored before the column existed is left out of the sums and of the revenue it is divided by', () => {
    const rows = run(1, 12, (n) => (n <= 6 ? { recurring_revenue: null, recurring_mature_revenue: null } : {}));
    expect(view.recurringMetric(view.splitWindows(rows))).toMatchObject({ share: 50, monthsCounted: 6 });
  });

  test('the share is divided by the eligible revenue stored in the same month (test accounts left out), not completed-visit revenue that includes them', () => {
    const rows = run(1, 12, { completed_job_revenue: 5000, eligible_job_revenue: 800 }); // the stored total carries a big test-account month
    expect(view.recurringMetric(view.splitWindows(rows))).toMatchObject({ share: 75 }); // 600 / 800, not 600 / 5000
  });

  test('a month without the stored eligible revenue is left out of both sides, so numerator and denominator always match', () => {
    const rows = run(1, 12, (n) => (n <= 4 ? { eligible_job_revenue: null } : {}));
    expect(view.recurringMetric(view.splitWindows(rows))).toMatchObject({ share: 50, monthsCounted: 8, recurringRevenue: 4800 });
    expect(view.recurringMetric(view.splitWindows(run(1, 12, { eligible_job_revenue: 0 })))).toMatchObject({ share: null });
  });

  test('gross margin: book margin is total book profit over total revenue; per-job margin is weighted by completed-visit revenue', () => {
    const rows = run(1, 12, (n) => (n === 1 ? { cash_revenue: 3000, book_gross_profit: 600, completed_job_revenue: 2000, job_gross_profit: 1200 } : {}));
    // book: (600 + 11 x 400) / (3000 + 11 x 1000) = 35.7 ; per job: (1200 + 11 x 600) / 15200 = 51.3
    expect(view.grossMarginMetric(view.splitWindows(rows))).toMatchObject({ bookPct: 35.7, bookGrossProfit: 5000, perJobAtStandardPct: 51.3, bookMonthsCounted: 12 });
  });

  test('a month with no revenue (no percent that month) or a loss still counts in the year, so the margin is not flattered', () => {
    const rows = run(1, 12, (n) => {
      if (n === 1) return { cash_revenue: 0, book_gross_margin_pct: null, book_gross_profit: -300 }; // costs, no revenue
      if (n === 2) return { cash_revenue: -50, book_gross_margin_pct: null, book_gross_profit: -50 }; // a refund month
      return {};
    });
    // (-300 - 50 + 10 x 400) / (0 - 50 + 10 x 1000) = 36.7 ; dropping the two months would read 40
    expect(view.grossMarginMetric(view.splitWindows(rows))).toMatchObject({ bookPct: 36.7, bookGrossProfit: 3650, bookMonthsCounted: 12 });
  });

  test('per-job margin is total job profit over total job revenue: $1,000 revenue at $200 cost plus a callback-only $100-loss month is 70%', () => {
    const rows = run(1, 12, (n) => {
      if (n === 1) return { completed_job_revenue: 1000, job_gross_profit: 800, gross_margin_pct: 80 };
      if (n === 2) return { completed_job_revenue: 0, job_gross_profit: -100, gross_margin_pct: null }; // callback only: cost, no revenue
      return { completed_job_revenue: 0, job_gross_profit: 0, gross_margin_pct: null };
    });
    expect(view.grossMarginMetric(view.splitWindows(rows))).toMatchObject({ perJobAtStandardPct: 70, perJobMonthsCounted: 12 }); // dropping the loss month would read 80
  });

  test('a month stored before job profit existed is left out of both sums and counted', () => {
    const rows = run(1, 12, (n) => (n <= 5 ? { job_gross_profit: null } : {}));
    expect(view.grossMarginMetric(view.splitWindows(rows))).toMatchObject({ perJobAtStandardPct: 50, perJobMonthsCounted: 7 });
  });

  test('a month stored before book profit existed is left out and counted', () => {
    const rows = run(1, 12, (n) => (n <= 3 ? { book_gross_profit: null, book_gross_margin_pct: null } : {}));
    expect(view.grossMarginMetric(view.splitWindows(rows))).toMatchObject({ bookPct: 40, bookMonthsCounted: 9 });
  });

  test('owner-paid profit margin and SDE; months without a figure drop out and the owner-pay months are counted', () => {
    const rows = run(1, 12, (n) => (n === 1 ? { owner_paid_profit: null, owner_field_allowance: null } : { owner_field_allowance: 50, owner_allowance: n > 9 ? 40 : 0 }));
    const metric = view.ownerProfitMetric(view.splitWindows(rows));
    expect(metric).toMatchObject({ marginPct: 20, ownerPaidProfit: 2200, sde: 3600, monthsCounted: 11, sdeMonthsCounted: 12 });
    expect(metric.ownerPay).toEqual({ officeMonths: 3, fieldMonths: 11, months: 12 });
  });

  test('office cost per stop is sum over sum, not an average of monthly ratios; a year with no stops has none', () => {
    const rows = run(1, 12, (n) => (n === 1 ? { office_cost: 1000, paid_stops: 1 } : { office_cost: 100, paid_stops: 100 }));
    // sum/sum: 2100 / 1101 = 1.91 ; the mean of the monthly ratios would be (1000 + 11 x 1) / 12 = 84.25
    expect(view.officeCostMetric(view.splitWindows(rows))).toMatchObject({ perStop: 1.91, pctOfRevenue: 17.5, paidStops: 1101 });
    expect(view.officeCostMetric(view.splitWindows(run(1, 12, { paid_stops: 0 }))).perStop).toBeNull();
  });
});

describe('plan revenue kept windows', () => {
  test('the latest 12 closed months and the 12 before, in Eastern calendar dates', () => {
    expect(view.keptWindows(new Date('2026-11-26T15:00:00Z'))).toEqual({
      current: { start: '2025-11-01', end: '2026-10-31' },
      then: { start: '2024-11-01', end: '2025-10-31' },
    });
  });
});

describe('getBuyerView', () => {
  // Only the snapshot table answers; every other table throws, like a failed live query.
  const dbWith = (rows, financials = { owner_office_hourly_rate: '25.00', owner_field_hourly_rate: '25.00' }) => {
    const db = (table) => {
      if (table === 'company_financials') return { orderBy: () => ({ first: async () => financials }) };
      if (table !== 'monthly_financial_snapshots') throw new Error(`no ${table} here`);
      const q = { orderBy: () => q, limit: () => q, then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
      return q;
    };
    return db;
  };
  const logger = { error: jest.fn() };

  test('one failed live query is that tile\'s { error }; the stored tiles still arrive', async () => {
    const payload = await view.getBuyerView({ db: dbWith(run(13, 24).reverse()), now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(payload.planRevenueKept).toEqual({ error: 'unavailable' });
    expect(payload.ownerFieldHoursPerWeek).toEqual({ error: 'unavailable' });
    expect(payload.revenue.value).toBe(12000);
    expect(payload.months).toEqual({ count: 12, from: '2026-01-01', to: '2026-12-01' });
    expect(payload.recurring).toMatchObject({ share: 50, recurringRevenue: 7200 }); // stored together: no live read to fail
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  test('no stored months is an empty, honest payload: dashes, zero months, no growth', async () => {
    const payload = await view.getBuyerView({ db: dbWith([]), now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(payload.months).toEqual({ count: 0, from: null, to: null });
    expect(payload.revenue).toMatchObject({ value: 0, growthPct: null, monthsCounted: 0 });
    expect(payload.recurring.share).toBeNull();
    expect(payload.ownerProfit.marginPct).toBeNull();
    expect(payload.officeCost.perStop).toBeNull();
    expect(payload.prepaidOwed).toBeNull();
  });

  test('the owner-time basis states what the stored months counted, and the current Settings rate on its own line, worded from the stored rate', async () => {
    const rows = run(1, 24, { owner_allowance: 100, owner_field_allowance: 50 });
    const stored = await view.getBuyerView({ db: dbWith(rows, { owner_office_hourly_rate: '31.50', owner_field_hourly_rate: '28.00' }), now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(stored.ownerProfit.basis).toContain('Owner office time was counted in 12 of 12 stored months.');
    expect(stored.ownerProfit.basis).toContain('Owner field time was counted in 12 of 12 stored months.');
    expect(stored.ownerProfit.basis).toContain('Current owner office rate: $31.5 an hour, a placeholder, not a final rate.');
    expect(stored.ownerProfit.basis).toContain('Current owner field wage: $28 an hour, a placeholder, not a final rate.');
    expect(stored.grossMargin.basis).toContain('Current owner field wage: $28 an hour, a placeholder, not a final rate.');
    expect(stored.officeCost.basis).toContain('Current owner office rate: $31.5 an hour, a placeholder, not a final rate.');
    expect(stored.ownerRates).toEqual({ available: true, officeHourly: '31.50', fieldHourly: '28.00' });
    expect(JSON.stringify(stored)).not.toContain('$25 an hour');
  });

  test('rates cleared today do not rewrite history: 12 months with allowances still say they were counted, and now says none set', async () => {
    const rows = run(1, 24, { owner_allowance: 100, owner_field_allowance: 50 });
    const none = await view.getBuyerView({ db: dbWith(rows, { owner_office_hourly_rate: null, owner_field_hourly_rate: '0.00' }), now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(none.ownerProfit.basis).toContain('Owner office time was counted in 12 of 12 stored months.');
    expect(none.ownerProfit.basis).toContain('Current owner office rate: none set now.');
    expect(none.grossMargin.basis).toContain('Owner field time was counted in 12 of 12 stored months.');
    expect(none.grossMargin.basis).toContain('Current owner field wage: none set now.');
    expect(none.officeCost.basis).not.toContain('placeholder');
    expect(JSON.stringify(none)).not.toContain('not counted');
  });

  test('months that did not count owner time say so from the stored allowances', async () => {
    const rows = run(1, 24, (n) => (n > 20 ? { owner_allowance: 100, owner_field_allowance: 0 } : { owner_allowance: 0, owner_field_allowance: 0 }));
    const payload = await view.getBuyerView({ db: dbWith(rows), now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(payload.ownerProfit.basis).toContain('Owner office time was counted in 4 of 12 stored months.');
    expect(payload.ownerProfit.basis).toContain('Owner field time was counted in 0 of 12 stored months.');
  });

  test('a failed settings read says the current rate is unavailable, never that owner time was excluded', async () => {
    const rows = run(1, 24, { owner_allowance: 100, owner_field_allowance: 50 });
    const db = dbWith(rows);
    const failing = (table) => {
      if (table === 'company_financials') return { orderBy: () => ({ first: async () => { throw new Error('settings read failed'); } }) };
      return db(table);
    };
    const payload = await view.getBuyerView({ db: failing, now: new Date('2026-11-26T15:00:00Z'), logger });
    expect(payload.ownerProfit.basis).toContain('Current owner office rate: unavailable.');
    expect(payload.ownerProfit.basis).toContain('Owner office time was counted in 12 of 12 stored months.');
    expect(payload.officeCost.basis).toContain('Current owner office rate: unavailable.');
    expect(payload.ownerRates.available).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/not counted|none set now/);
  });

  test('every metric carries its basis in words', async () => {
    const payload = await view.getBuyerView({ db: dbWith(run(1, 24)), now: new Date('2026-11-26T15:00:00Z'), logger });
    for (const key of ['revenue', 'recurring', 'grossMargin', 'ownerProfit', 'officeCost']) {
      expect(typeof payload[key].basis).toBe('string');
      expect(payload[key].basis.length).toBeGreaterThan(40);
    }
  });
});
