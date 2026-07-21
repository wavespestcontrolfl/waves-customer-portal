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
  OUTFLOW_REPORTING_CATEGORIES,
  CATEGORYLESS_TXN_TYPES,
} = require('../services/pnl-report');

describe('CATEGORYLESS_TXN_TYPES', () => {
  test('types that legitimately carry no reporting_category never mark a payout stale', () => {
    // Without this set, one synced ACH reversal (null category by design)
    // would flag its payout for re-sync forever and pin the P&L coverage
    // warning on permanently.
    expect(CATEGORYLESS_TXN_TYPES).toEqual(['payment_reversal', 'payment_failure_refund']);
  });
});

describe('OUTFLOW_REPORTING_CATEGORIES', () => {
  test('classifies by canonical reporting_category with the exact allowed set', () => {
    // Never bare `type`: 'adjustment' is an umbrella, and type 'refund' also
    // covers partial-capture reversals whose receipt already reflects only
    // the captured amount (subtracting them would double-count).
    expect(OUTFLOW_REPORTING_CATEGORIES).toEqual([
      'refund', 'refund_failure', 'dispute', 'dispute_reversal',
    ]);
    // payment_reversal (post-settlement ACH bank return) is a TYPE with no
    // canonical reporting_category — matched by its own type branch in
    // outflowTransactionsQuery, never via this category list.
    expect(OUTFLOW_REPORTING_CATEGORIES).not.toContain('payment_reversal');
    // Poison categories stay out: partial-capture reversals and charge
    // failures never net against revenue.
    expect(OUTFLOW_REPORTING_CATEGORIES).not.toContain('partial_capture_reversal');
    expect(OUTFLOW_REPORTING_CATEGORIES).not.toContain('charge_failure');
    expect(OUTFLOW_REPORTING_CATEGORIES).not.toContain('adjustment');
    // (Reversals of FAILED payments — receipts never counted — are excluded
    // by the linked-payment status guard in outflowTransactionsQuery,
    // covered by the query-level DB validation.)
  });

  test('SUM(-amount) sign semantics: open subtracts, reversal adds back, lost stays', () => {
    const sumNegated = (rows) => rows.reduce((s, r) => s - r.amount, 0);
    expect(sumNegated([{ amount: -150 }])).toBe(150); // refund/dispute open
    expect(sumNegated([{ amount: -150 }, { amount: 150 }])).toBe(0); // won / bounced back
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
      // Mileage only reaches `deductions` under an explicit standard-mileage
      // election; unelected fails closed (covered in the line-9 suite below).
      vehicleMethod: 'standard_mileage',
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

  test('§179/bonus assets recognize their WHOLE deduction in the in-service year, never prorated', () => {
    const s179 = {
      annual_depreciation: null,
      depreciation_method: 'section_179',
      section_179_elected: true,
      section_179_amount: '12000',
      placed_in_service_date: '2026-07-01',
    };
    // In-service inside the window: full amount even though only half the
    // year remains (immediate expensing is never day-prorated).
    expect(prorateDepreciation([s179], year.start, year.end)).toBe(12000);
    // The deduction belongs ONLY to the in-service year.
    expect(prorateDepreciation([s179], '2027-01-01', '2027-12-31')).toBe(0);
    // bonus_100 without a section_179_amount falls back to purchase cost.
    expect(prorateDepreciation(
      [{ annual_depreciation: null, depreciation_method: 'bonus_100', purchase_cost: '5000', placed_in_service_date: '2026-03-01' }],
      year.start, year.end,
    )).toBe(5000);
  });

  test('non-179 assets with annual NULL and future assets contribute nothing', () => {
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

describe('assemblePnl — vehicle deduction election (Schedule C line 9)', () => {
  // Both sides of line 9 present, so every branch has something to drop.
  const inputs = {
    serviceRevenue: 10000,
    opexRows: [
      { category: 'Vehicle Expenses', irs_line: '9', total: '2400.00' },
      { category: 'Insurance', irs_line: '15', total: '600.00' },
    ],
    mileageDeduction: 3300,
  };

  test('unelected FAILS CLOSED: keeps actual vehicle expenses, drops mileage', () => {
    const out = assemblePnl(inputs);
    expect(out.vehicleDeduction.elected).toBe(false);
    expect(out.vehicleDeduction.method).toBeNull();
    // Recorded cash stays as opex; the computed deduction does not count.
    expect(out.operatingExpenses.total).toBe(3000);
    expect(out.deductions.mileage).toBe(0);
    expect(out.deductions.total).toBe(0);
    // The dropped amount is disclosed, not silently missing.
    expect(out.vehicleDeduction.excludedMileage).toBe(3300);
    expect(out.vehicleDeduction.excludedVehicleExpenses).toBe(0);
    expect(out.netIncome).toBe(7000);
  });

  test('standard_mileage counts mileage and excludes Vehicle Expenses opex', () => {
    const out = assemblePnl({ ...inputs, vehicleMethod: 'standard_mileage' });
    expect(out.operatingExpenses.categories.find(c => c.name === 'Vehicle Expenses')).toBeUndefined();
    expect(out.operatingExpenses.total).toBe(600); // insurance only
    expect(out.deductions.mileage).toBe(3300);
    expect(out.vehicleDeduction.excludedVehicleExpenses).toBe(2400);
    expect(out.vehicleDeduction.excludedMileage).toBe(0);
    expect(out.netIncome).toBe(6100);
  });

  test('actual_expenses counts Vehicle Expenses opex and excludes mileage', () => {
    const out = assemblePnl({ ...inputs, vehicleMethod: 'actual_expenses' });
    expect(out.operatingExpenses.total).toBe(3000);
    expect(out.deductions.mileage).toBe(0);
    expect(out.vehicleDeduction.excludedMileage).toBe(3300);
    expect(out.netIncome).toBe(7000);
  });

  test('line 9 is never deducted twice under any election', () => {
    for (const vehicleMethod of [null, 'standard_mileage', 'actual_expenses']) {
      const out = assemblePnl({ ...inputs, vehicleMethod });
      const vehOpex = out.operatingExpenses.categories
        .find(c => c.name === 'Vehicle Expenses')?.amount || 0;
      // At most ONE side of line 9 may carry value.
      expect(Math.min(vehOpex, out.deductions.mileage)).toBe(0);
    }
  });

  test('unrecognized method strings fall back to unelected, never to a deduction', () => {
    for (const bad of ['STANDARD_MILEAGE', 'mileage', '', 'actual', 0, true, {}]) {
      const out = assemblePnl({ ...inputs, vehicleMethod: bad });
      expect(out.vehicleDeduction.method).toBeNull();
      expect(out.deductions.mileage).toBe(0);
    }
  });

  test('election is inert when neither side has value', () => {
    const out = assemblePnl({ serviceRevenue: 500, vehicleMethod: 'standard_mileage' });
    expect(out.deductions.total).toBe(0);
    expect(out.vehicleDeduction.excludedVehicleExpenses).toBe(0);
    expect(out.netIncome).toBe(500);
  });

  // The standard mileage rate embeds a depreciation allowance; a vehicle's
  // separate MACRS/§179 depreciation must NOT be deducted beside it.
  describe('vehicle depreciation under standard mileage', () => {
    const withDepr = {
      serviceRevenue: 10000,
      mileageDeduction: 3300,
      depreciationTotal: 11200,     // $8k equipment + $3.2k vehicle, say
      vehicleDepreciation: 3200,
    };

    test('standard_mileage excludes the vehicle depreciation portion', () => {
      const out = assemblePnl({ ...withDepr, vehicleMethod: 'standard_mileage' });
      // Only non-vehicle depreciation survives beside the mileage rate.
      expect(out.deductions.depreciation).toBe(8000);
      expect(out.deductions.mileage).toBe(3300);
      expect(out.deductions.total).toBe(11300);
      expect(out.vehicleDeduction.excludedVehicleDepreciation).toBe(3200);
    });

    test('actual_expenses and unelected keep FULL depreciation', () => {
      for (const vehicleMethod of ['actual_expenses', null]) {
        const out = assemblePnl({ ...withDepr, vehicleMethod });
        expect(out.deductions.depreciation).toBe(11200);
        expect(out.vehicleDeduction.excludedVehicleDepreciation).toBe(0);
      }
    });

    test('vehicle depreciation is never deducted alongside standard mileage', () => {
      const out = assemblePnl({ ...withDepr, vehicleMethod: 'standard_mileage' });
      // counted depreciation + excluded vehicle depreciation == the raw total,
      // and the excluded slice is exactly the vehicle portion.
      expect(out.deductions.depreciation + out.vehicleDeduction.excludedVehicleDepreciation)
        .toBe(11200);
    });
  });

  // A MACRS/§179 vehicle is barred from the standard mileage rate (Pub 463).
  // Electing it anyway must NOT inflate the total — fail closed to actual
  // expenses (mileage excluded, opex + depreciation kept), warning alongside.
  describe('barred standard-mileage election fails closed', () => {
    const barred = {
      serviceRevenue: 10000,
      opexRows: [{ category: 'Vehicle Expenses', irs_line: '9', total: '2400.00' }],
      mileageDeduction: 3300,
      depreciationTotal: 3200,
      vehicleDepreciation: 3200,
      vehicleMethod: 'standard_mileage',
      vehicleMileageBarred: true,
    };

    test('excludes the barred mileage from the total', () => {
      const out = assemblePnl(barred);
      expect(out.deductions.mileage).toBe(0);
      expect(out.vehicleDeduction.excludedMileage).toBe(3300);
      expect(out.vehicleDeduction.barred).toBe(true);
    });

    test('keeps Vehicle Expenses opex and vehicle depreciation (actual basis)', () => {
      const out = assemblePnl(barred);
      // Fell back to actual expenses: opex + depreciation both survive.
      expect(out.operatingExpenses.categories.find(c => c.name === 'Vehicle Expenses')?.amount)
        .toBe(2400);
      expect(out.deductions.depreciation).toBe(3200);
      expect(out.vehicleDeduction.excludedVehicleDepreciation).toBe(0);
    });

    test('an UNBARRED standard-mileage election still counts mileage', () => {
      const out = assemblePnl({ ...barred, vehicleMileageBarred: false });
      expect(out.deductions.mileage).toBe(3300);
      expect(out.vehicleDeduction.barred).toBe(false);
    });

    test('barred flag only bites a standard-mileage election, not actual/unelected', () => {
      for (const vehicleMethod of ['actual_expenses', null]) {
        const out = assemblePnl({ ...barred, vehicleMethod });
        // Not standard mileage, so being "barred" is irrelevant and never true.
        expect(out.vehicleDeduction.barred).toBe(false);
        expect(out.deductions.depreciation).toBe(3200); // full depreciation kept
      }
    });
  });
});
