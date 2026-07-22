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
  macrsYearAmount,
  annotateMidQuarter,
  isDepreciationUncomputed,
  getPeriodRange,
  missingTableOnly,
  rateAsOf,
  costLaborByDay,
  dateCellStr,
  DEFAULT_LOADED_LABOR_RATE,
  OUTFLOW_REPORTING_CATEGORIES,
} = require('../services/pnl-report');


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
    });
    expect(out.cogs.total).toBe(1000);
    expect(out.grossProfit).toBe(9000);
    // Deductions = depreciation only. Mileage is never auto-counted (actual-
    // expenses basis); it's disclosed in vehicleDeduction for manual use.
    expect(out.deductions.total).toBe(300);
    expect(out.vehicleDeduction.standardMileageComputed).toBe(700);
    expect(out.netIncome).toBe(7700); // 9000 gross − 1000 opex − 300 depreciation
    expect(out.netMargin).toBeCloseTo(0.77, 5);
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

  // MACRS 5-year vehicle (the Ford Transit case): $35k, in service 2025-01-01.
  // annual_depreciation is NULL — before this it showed $0; now the year-
  // varying half-year schedule computes it (20/32/19.2/11.52/11.52/5.76%).
  describe('MACRS year-varying depreciation', () => {
    const van = (over = {}) => ({
      depreciation_method: 'MACRS', irs_class: '5-year',
      purchase_cost: '35000', annual_depreciation: null,
      placed_in_service_date: '2025-01-01', asset_category: 'vehicle',
      business_use_confirmed: true, // owner-confirmed 100% business use
      ...over,
    });

    test('macrsYearAmount follows the 5-year half-year table', () => {
      expect(macrsYearAmount('5-year', 35000, 2025, 2025)).toBeCloseTo(7000, 4);   // 20%
      expect(macrsYearAmount('5-year', 35000, 2025, 2026)).toBeCloseTo(11200, 4);  // 32%
      expect(macrsYearAmount('5-year', 35000, 2025, 2027)).toBeCloseTo(6720, 4);   // 19.2%
      expect(macrsYearAmount('5-year', 35000, 2025, 2030)).toBeCloseTo(2016, 4);   // 5.76%
      expect(macrsYearAmount('5-year', 35000, 2025, 2031)).toBe(0);                // past recovery
      expect(macrsYearAmount('5-year', 35000, 2025, 2024)).toBe(0);                // before in-service
    });

    test('2026 P&L shows the year-2 amount ($11,200), not $0', () => {
      expect(prorateDepreciation([van()], '2026-01-01', '2026-12-31')).toBeCloseTo(11200, 2);
    });

    test('in-service year takes the FULL year-1 % regardless of in-service date (half-year)', () => {
      // Placed in service mid-year: still the full 20% ($7,000), never day-prorated.
      expect(prorateDepreciation(
        [van({ placed_in_service_date: '2025-07-01' })],
        '2025-01-01', '2025-12-31',
      )).toBeCloseTo(7000, 2);
    });

    test('business_use_pct scales the deduction (listed property)', () => {
      // 80% business use → 80% of the $11,200 year-2 amount.
      expect(prorateDepreciation([van({ business_use_pct: '80' })], '2026-01-01', '2026-12-31'))
        .toBeCloseTo(8960, 2);
      // Unset defaults to 100%.
      expect(prorateDepreciation([van({ business_use_pct: null })], '2026-01-01', '2026-12-31'))
        .toBeCloseTo(11200, 2);
    });

    test('a partial REPORT window prorates the year amount by window days', () => {
      // Q1 2026 = 90 days of 365 → 11200 × 90/365.
      expect(prorateDepreciation([van()], '2026-01-01', '2026-03-31'))
        .toBeCloseTo(11200 * 90 / 365, 2);
    });

    test('unknown recovery class contributes nothing (fail closed)', () => {
      expect(prorateDepreciation([van({ irs_class: '20-year' })], '2026-01-01', '2026-12-31')).toBe(0);
    });

    test('an UNCONFIRMED vehicle fails closed and is flagged (never deducts the 100% default)', () => {
      const unconfirmed = van({ business_use_confirmed: false });
      expect(prorateDepreciation([unconfirmed], '2026-01-01', '2026-12-31')).toBe(0);
      expect(isDepreciationUncomputed(unconfirmed, '2026-01-01', '2026-12-31')).toBe(true);
      // Confirming it computes normally.
      expect(prorateDepreciation([van({ business_use_confirmed: true })], '2026-01-01', '2026-12-31')).toBeCloseTo(11200, 2);
    });

    test('isDepreciationUncomputed flags ALL fail-closed reasons, only in-window', () => {
      const win = ['2026-01-01', '2026-12-31'];
      // Computable half-year van → NOT uncomputed.
      expect(isDepreciationUncomputed(van(), ...win)).toBe(false);
      // Unknown class → uncomputed.
      expect(isDepreciationUncomputed(van({ irs_class: '20-year' }), ...win)).toBe(true);
      // ≤50% vehicle → uncomputed.
      expect(isDepreciationUncomputed(van({ business_use_pct: '40' }), ...win)).toBe(true);
      // Mid-quarter (marked) → uncomputed.
      expect(isDepreciationUncomputed(van({ depreciation_convention: 'mid_quarter' }), ...win)).toBe(true);
      // Out of window: placed in service AFTER the window → not flagged.
      expect(isDepreciationUncomputed(van({ irs_class: '20-year', placed_in_service_date: '2027-01-01' }), ...win)).toBe(false);
      // Past its recovery period (5-year van in service 2018, but mid-quarter) → computes 0 legitimately.
      expect(isDepreciationUncomputed(van({ depreciation_convention: 'mid_quarter', placed_in_service_date: '2018-01-01' }), ...win)).toBe(false);
    });

    test('completeness covers §179/bonus fail-closed too, not just MACRS', () => {
      const win = ['2026-01-01', '2026-12-31'];
      // An unconfirmed vehicle on §179 (in-service this year) fails closed AND
      // is flagged uncomputed.
      const s179Van = {
        depreciation_method: 'section_179', section_179_elected: true,
        section_179_amount: '20000', asset_category: 'vehicle',
        business_use_confirmed: false, placed_in_service_date: '2026-03-01',
      };
      expect(prorateDepreciation([s179Van], ...win)).toBe(0);
      expect(isDepreciationUncomputed(s179Van, ...win)).toBe(true);
      // Confirmed → computes and is NOT flagged.
      const confirmed = { ...s179Van, business_use_confirmed: true, business_use_pct: '100' };
      expect(prorateDepreciation([confirmed], ...win)).toBeCloseTo(20000, 2);
      expect(isDepreciationUncomputed(confirmed, ...win)).toBe(false);
    });

    test('an ineligible MACRS asset NEVER falls through to a stale annual_depreciation', () => {
      // A MACRS row carrying a leftover annual_depreciation must fail closed,
      // not claim that straight-line amount — MACRS is handled entirely.
      expect(prorateDepreciation(
        [van({ irs_class: '20-year', annual_depreciation: '9999' })], '2026-01-01', '2026-12-31',
      )).toBe(0);
      expect(prorateDepreciation(
        [van({ business_use_pct: '40', annual_depreciation: '9999' })], '2026-01-01', '2026-12-31',
      )).toBe(0);
    });

    test('§179 + MACRS depreciates only the REMAINING basis (no double-count)', () => {
      // $35k, $10k §179, 100% business use. 2025: $10k immediate + 20%×($35k−
      // $10k)=$5,000 → $15,000. 2026: 32%×$25k=$8,000.
      const hybrid = van({
        placed_in_service_date: '2025-01-01',
        section_179_elected: true, section_179_amount: '10000',
      });
      expect(prorateDepreciation([hybrid], '2025-01-01', '2025-12-31')).toBeCloseTo(15000, 2);
      expect(prorateDepreciation([hybrid], '2026-01-01', '2026-12-31')).toBeCloseTo(8000, 2);
    });

    test('§179/bonus immediate expensing is capped at the business basis', () => {
      // Full-cost §179 fallback on an 80%-business-use $35k vehicle: the §179
      // deduction is capped at $35k×80% = $28,000, not $35,000.
      const s179Vehicle = {
        depreciation_method: 'section_179', section_179_elected: true,
        section_179_amount: null, purchase_cost: '35000',
        placed_in_service_date: '2026-01-01', business_use_pct: '80',
      };
      expect(prorateDepreciation([s179Vehicle], '2026-01-01', '2026-12-31')).toBeCloseTo(28000, 2);
      // ≤50% use disqualifies §179 entirely.
      expect(prorateDepreciation(
        [{ ...s179Vehicle, business_use_pct: '45' }], '2026-01-01', '2026-12-31',
      )).toBe(0);
    });

    test('hybrid §179/MACRS applies business use to the BASIS, not the schedule', () => {
      const hybrid80 = van({
        placed_in_service_date: '2025-01-01', business_use_pct: '80',
        section_179_elected: true, section_179_amount: '10000',
      });
      // Business basis = $35k×80% = $28k; §179 $10k immediate; MACRS on $18k.
      // 2025: $10k + 20%×$18k=$3,600 → $13,600 (NOT $14,000).
      expect(prorateDepreciation([hybrid80], '2025-01-01', '2025-12-31')).toBeCloseTo(13600, 2);
      // At 40% business use the whole asset fails closed — §179 does NOT survive.
      const hybrid40 = van({
        placed_in_service_date: '2025-01-01', business_use_pct: '40',
        section_179_elected: true, section_179_amount: '10000',
      });
      expect(prorateDepreciation([hybrid40], '2025-01-01', '2025-12-31')).toBe(0);
    });

    test('disposed MACRS asset takes HALF the disposal-year amount (half-year disposition)', () => {
      const disposedVan = van({ disposal_date: '2027-12-31', disposed: true });
      // 2026 (before disposal): full year-2 $11,200.
      expect(prorateDepreciation([disposedVan], '2026-01-01', '2026-12-31')).toBeCloseTo(11200, 2);
      // 2027 (disposal year): HALF the year-3 amount = 0.5 × 19.2% × $35k =
      // $3,360 (half-year disposition convention, not a day fraction).
      expect(prorateDepreciation([disposedVan], '2027-01-01', '2027-12-31')).toBeCloseTo(3360, 2);
      // After the disposal year: nothing.
      expect(prorateDepreciation([disposedVan], '2028-01-01', '2028-12-31')).toBe(0);
    });

    test('disposal-year amount does NOT leak into post-disposal windows', () => {
      // Disposed mid-year: the $3,360 half-year amount is earned Jan 1–Jun 30.
      const midDisposal = van({ disposal_date: '2027-06-30', disposed: true });
      // Full 2027 window still totals the whole $3,360 (window covers all coverage).
      expect(prorateDepreciation([midDisposal], '2027-01-01', '2027-12-31')).toBeCloseTo(3360, 2);
      // Q1 (Jan–Mar) = 90 of the 181 coverage days.
      expect(prorateDepreciation([midDisposal], '2027-01-01', '2027-03-31'))
        .toBeCloseTo(3360 * 90 / 181, 2);
      // Q3 (Jul–Sep), entirely AFTER the June 30 disposal → $0, no leak.
      expect(prorateDepreciation([midDisposal], '2027-07-01', '2027-09-30')).toBe(0);
    });

    test('same-year in-service + disposal is NOT MACRS-depreciable ($0)', () => {
      const sameYear = van({ placed_in_service_date: '2026-03-01', disposal_date: '2026-11-01', disposed: true });
      expect(prorateDepreciation([sameYear], '2026-01-01', '2026-12-31')).toBe(0);
      // And it's excluded from the mid-quarter basis test, so it can't skew it:
      // a genuine Q1 asset alongside a same-year-disposed Q4 asset stays half-year.
      const q1 = van({ placed_in_service_date: '2026-02-01', purchase_cost: '35000' });
      const sameYearQ4 = van({ placed_in_service_date: '2026-11-01', purchase_cost: '90000', disposal_date: '2026-12-15', disposed: true });
      // Without the exclusion the $90k Q4 asset would be >40% of basis → spurious
      // mid-quarter → both $0. Excluded, q1 keeps its year-1 half-year amount:
      // 20% × $35k = $7,000.
      expect(prorateDepreciation(annotateMidQuarter([q1, sameYearQ4]), '2026-01-01', '2026-12-31'))
        .toBeCloseTo(7000, 2);
    });

    test('the ≤50% guard gates ONLY GDS/§179 — a CPA-entered straight-line amount flows through', () => {
      const adsVehicle = {
        depreciation_method: 'straight_line', annual_depreciation: '2100',
        placed_in_service_date: '2025-01-01', business_use_pct: '30',
      };
      expect(prorateDepreciation([adsVehicle], '2026-01-01', '2026-12-31')).toBeCloseTo(2100, 2);
    });

    test('mid-quarter year (>40% of basis in Q4) fails MACRS closed for CPA', () => {
      const q1 = van({ placed_in_service_date: '2026-02-01', purchase_cost: '10000' });
      const q4 = van({ placed_in_service_date: '2026-11-01', purchase_cost: '40000' });
      // 40k of 50k (80%) in Q4 → mid-quarter year → both fail closed.
      expect(prorateDepreciation(annotateMidQuarter([q1, q4]), '2026-01-01', '2026-12-31')).toBe(0);
      // A half-year year (all Q1) computes normally.
      expect(prorateDepreciation(annotateMidQuarter([van()]), '2026-01-01', '2026-12-31')).toBeCloseTo(11200, 2);
      // annotateMidQuarter marks the affected MACRS assets so the disclosure fires.
      const marked = annotateMidQuarter([q1, q4]);
      expect(marked.every((a) => a.depreciation_convention === 'mid_quarter')).toBe(true);
    });

    test('bonus (100%) on a non-listed asset at ≤50% use still expenses its business share', () => {
      // Non-vehicle 100%-bonus at 40% business use: immediate = cost × 40% =
      // $2,000 (bonus's >50% rule is listed-property only, unlike §179).
      const bonusEquip = {
        depreciation_method: 'bonus_100', asset_category: 'equipment',
        purchase_cost: '5000', business_use_pct: '40',
        placed_in_service_date: '2026-03-01',
      };
      expect(prorateDepreciation([bonusEquip], '2026-01-01', '2026-12-31')).toBeCloseTo(2000, 2);
      // A §179 non-vehicle at 40% still fails closed (§179 needs >50% broadly).
      expect(prorateDepreciation(
        [{ ...bonusEquip, depreciation_method: 'section_179', section_179_elected: true }],
        '2026-01-01', '2026-12-31',
      )).toBe(0);
    });

    test('the ≤50% ADS gate is LISTED-property only — a non-vehicle MACRS asset still depreciates', () => {
      // Non-vehicle (asset_category !== 'vehicle') at 40% use uses GDS on its
      // 40% basis: 32% × ($35k×0.40) = $4,480, not $0.
      const equip = van({ asset_category: 'equipment', business_use_pct: '40' });
      expect(prorateDepreciation([equip], '2026-01-01', '2026-12-31')).toBeCloseTo(4480, 2);
    });

    test('business use ≤50% FAILS CLOSED for a VEHICLE (ADS/CPA territory, not GDS)', () => {
      expect(prorateDepreciation([van({ business_use_pct: '50' })], '2026-01-01', '2026-12-31')).toBe(0);
      expect(prorateDepreciation([van({ business_use_pct: '40' })], '2026-01-01', '2026-12-31')).toBe(0);
      // Just above the threshold still computes (GDS × use).
      expect(prorateDepreciation([van({ business_use_pct: '51' })], '2026-01-01', '2026-12-31'))
        .toBeCloseTo(11200 * 0.51, 2);
    });

    test('a report window ending BEFORE in-service gets nothing', () => {
      const julyAsset = van({ placed_in_service_date: '2026-07-01' });
      // Jan–Mar 2026 P&L: asset not yet in service → $0.
      expect(prorateDepreciation([julyAsset], '2026-01-01', '2026-03-31')).toBe(0);
      // Full 2026: in-service year takes the FULL year-1 20% = $7,000 (half-year
      // convention — not day-prorated from July).
      expect(prorateDepreciation([julyAsset], '2026-01-01', '2026-12-31')).toBeCloseTo(7000, 2);
    });
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

describe('assemblePnl — vehicle deduction (actual-expenses basis only)', () => {
  // The P&L can only cleanly compute the actual-expenses basis: it deducts
  // every recorded cost and NEVER the standard mileage rate (actual vehicle
  // costs can't be isolated from shared categories to compute a clean
  // standard-mileage figure). The mileage is always disclosed, never counted.
  const inputs = {
    serviceRevenue: 10000,
    opexRows: [
      { category: 'Vehicle Expenses', irs_line: '9', total: '2400.00' },
      { category: 'Insurance', irs_line: '15', total: '600.00' },
    ],
    mileageDeduction: 3300,
    depreciationTotal: 3200,
  };

  test('mileage is NEVER counted, under ANY election', () => {
    for (const vehicleMethod of [null, 'standard_mileage', 'actual_expenses']) {
      const out = assemblePnl({ ...inputs, vehicleMethod });
      expect(out.deductions.mileage).toBe(0);
      expect(out.vehicleDeduction.countedMileage).toBe(0);
      // ...but it's always disclosed for manual/CPA use.
      expect(out.vehicleDeduction.standardMileageComputed).toBe(3300);
      expect(out.vehicleDeduction.basis).toBe('actual_expenses');
    }
  });

  test('all recorded costs (vehicle expenses + depreciation) always flow', () => {
    for (const vehicleMethod of [null, 'standard_mileage', 'actual_expenses']) {
      const out = assemblePnl({ ...inputs, vehicleMethod });
      // Vehicle Expenses opex is kept (never excluded) — actual basis.
      expect(out.operatingExpenses.categories.find(c => c.name === 'Vehicle Expenses')?.amount).toBe(2400);
      expect(out.operatingExpenses.total).toBe(3000);
      expect(out.deductions.depreciation).toBe(3200); // full depreciation always kept
      expect(out.netIncome).toBe(3800); // 10000 - 3000 opex - 3200 depreciation
    }
  });

  test('never overstates: the rate is never added beside actual costs', () => {
    // The dangerous direction (mileage + actual vehicle costs) is structurally
    // impossible — mileage never enters the total.
    const out = assemblePnl({ ...inputs, vehicleMethod: 'standard_mileage' });
    expect(out.deductions.total).toBe(3200); // depreciation only; no mileage
  });

  test('election metadata is reported; barred flag surfaced', () => {
    const elected = assemblePnl({ ...inputs, vehicleMethod: 'standard_mileage', vehicleMileageBarred: true });
    expect(elected.vehicleDeduction.method).toBe('standard_mileage');
    expect(elected.vehicleDeduction.elected).toBe(true);
    expect(elected.vehicleDeduction.barred).toBe(true);

    const unelected = assemblePnl({ ...inputs });
    expect(unelected.vehicleDeduction.method).toBeNull();
    expect(unelected.vehicleDeduction.elected).toBe(false);
    expect(unelected.vehicleDeduction.barred).toBe(false);
  });

  test('unrecognized method strings fall back to unelected', () => {
    for (const bad of ['STANDARD_MILEAGE', 'mileage', '', 'actual', 0, true, {}]) {
      const out = assemblePnl({ ...inputs, vehicleMethod: bad });
      expect(out.vehicleDeduction.method).toBeNull();
      expect(out.deductions.mileage).toBe(0);
    }
  });

  test('no mileage → nothing to disclose', () => {
    const out = assemblePnl({ serviceRevenue: 500, vehicleMethod: 'standard_mileage' });
    expect(out.vehicleDeduction.standardMileageComputed).toBe(0);
    expect(out.deductions.total).toBe(0);
    expect(out.netIncome).toBe(500);
  });
});
