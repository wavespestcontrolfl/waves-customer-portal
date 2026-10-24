/**
 * services/tax-return-engine (GATE_TAX_RETURN_ENGINE): computeReturn is pure,
 * so the money rules are pinned against hand-computed figures with synthetic
 * numbers. gatherInputs runs against a mocked database.
 *
 * Locked-down behaviors:
 *  1. Brackets: every year and status, checked at the top bracket against the
 *     IRS "tax is" formula, which also proves every lower boundary.
 *  2. Schedule SE: nothing under $400 of net earnings; the Social Security
 *     part stops at the wage base; Additional Medicare above its threshold.
 *  3. Section 179 is capped by gross receipts less every other expense (the
 *     home office is NOT subtracted) and the carryover is the rest. The home
 *     office comes after it, capped at what section 179 leaves: simplified
 *     has no carryover, actual carries the excess.
 *  4. The NOL takes at most 80% of taxable income; QBI takes a QBI loss
 *     carryforward first and is capped at 20% of taxable income.
 *  5. A zero-tax year needs no estimates; an unloaded year is a 400.
 *  6. The layered cross-check mirrors the structure of the owner's 2025
 *     working script (section 179 pool with a carry-in, actual home office
 *     with a carry-in, an NOL) with synthetic figures and hand arithmetic.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { rows: {}, pnl: null, detail: null };
function chain(table) {
  const b = new Proxy(function chainable() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(state.rows[table] ?? []).then(res, rej);
      if (prop === 'first') return () => Promise.resolve(state.rows[table] ?? null);
      return () => b;
    },
    apply() { return b; },
  });
  return b;
}
const mockDb = jest.fn((table) => chain(table));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);
jest.mock('../services/pnl-report', () => ({
  ...jest.requireActual('../services/pnl-report'),
  buildPnlReport: jest.fn(() => Promise.resolve(state.pnl)),
}));
jest.mock('../services/tax-years', () => ({
  ...jest.requireActual('../services/tax-years'),
  getYearDetail: jest.fn(() => Promise.resolve(state.detail)),
  ensureRow: jest.fn(() => Promise.resolve()),
  markFiled: jest.fn(),
}));

const engine = require('../services/tax-return-engine');
const taxYears = require('../services/tax-years');
const pnlReport = require('../services/pnl-report');
const { getYearConstants, YEARS } = require('../services/tax-year-constants');

const { computeReturn, bracketTax, incomeTaxFor, taxTableRow, dueDate, reserve, splitDepreciation } = engine;
const TODAY = '2026-10-24';

// a year that is over, nothing else going on
function inputs(over = {}) {
  return {
    year: 2025, filing_status: 'single', other_income: 0, estimates_paid: 0, gross_receipts: 0,
    carry_in: {}, expense_lines: [], depreciation: { regular: 0, sec179_elected: 0 }, home_office: null,
    today: '2027-01-15', ...over,
  };
}
const codes = (r) => r.warnings.map((w) => w.code);

describe('tax constants', () => {
  test.each([
    // [year, status, taxable, hand-computed tax at the top bracket]
    // IRS "the tax is" base for the top bracket + 37% of the excess
    [2024, 'single', 700000, 217187.75], // 183,647.25 + 0.37 x (700,000 - 609,350)
    [2024, 'mfj', 800000, 222125.5], //     196,669.50 + 0.37 x (800,000 - 731,200)
    [2024, 'hoh', 700000, 215495], //       181,954.50 + 0.37 x (700,000 - 609,350)
    [2025, 'single', 700000, 216020.25], // 188,769.75 + 0.37 x (700,000 - 626,350)
    [2025, 'mfj', 800000, 220062.5], //     202,154.50 + 0.37 x (800,000 - 751,600)
    [2025, 'hoh', 700000, 214282], //       187,031.50 + 0.37 x (700,000 - 626,350)
    [2026, 'single', 700000, 214957.25], // 192,979.25 + 0.37 x (700,000 - 640,600)
    [2026, 'mfj', 800000, 218164.5], //     206,583.50 + 0.37 x (800,000 - 768,700)
    [2026, 'hoh', 700000, 213149], //       191,171 + 0.37 x (700,000 - 640,600)
  ])('%i %s: tax on %i is %f', (year, status, taxable, expected) => {
    expect(bracketTax(taxable, getYearConstants(year).brackets[status])).toBe(expected);
  });

  test.each([
    [2024, 'single', 60000, 8253], //  1,160 + 4,266 + 22% of 12,850
    [2025, 'single', 60000, 8114], //  1,192.50 + 4,386 + 22% of 11,525
    [2026, 'single', 60000, 7912], //  1,240 + 4,560 + 22% of 9,600
    [2024, 'mfj', 120000, 16506],
    [2025, 'mfj', 120000, 16228],
    [2026, 'mfj', 120000, 15824],
    [2024, 'hoh', 80000, 10959],
    [2025, 'hoh', 80000, 10775],
    [2026, 'hoh', 80000, 10501],
  ])('%i %s: tax on %i is %f (middle brackets)', (year, status, taxable, expected) => {
    expect(bracketTax(taxable, getYearConstants(year).brackets[status])).toBe(expected);
  });

  test('standard deduction, wage base and section 179 limit per year', () => {
    expect(YEARS[2024]).toMatchObject({ standard_deduction: { single: 14600, mfj: 29200, hoh: 21900 }, ss_wage_base: 168600, sec179_limit: 1220000 });
    expect(YEARS[2025]).toMatchObject({ standard_deduction: { single: 15750, mfj: 31500, hoh: 23625 }, ss_wage_base: 176100, sec179_limit: 2500000 });
    expect(YEARS[2026]).toMatchObject({ standard_deduction: { single: 16100, mfj: 32200, hoh: 24150 }, ss_wage_base: 184500, sec179_limit: 2560000 });
    expect(YEARS[2025].qbi_threshold).toEqual({ single: 197300, mfj: 394600, hoh: 197300 });
  });

  test('a year that is not loaded is a 400 with the year named', () => {
    expect(() => getYearConstants(2023)).toThrow('tax constants for 2023 are not loaded');
    try { computeReturn(inputs({ year: 2027 })); } catch (e) { expect(e.status).toBe(400); expect(e.message).toBe('tax constants for 2027 are not loaded'); }
    expect.assertions(3);
  });
});

describe('the IRS Tax Table (taxable income under $100,000)', () => {
  const tax = (year, status, taxable) => incomeTaxFor(taxable, getYearConstants(year).brackets[status]);
  // Published values: Tax Table in the Form 1040 instructions, the "Your tax is"
  // columns Single / Married filing jointly / Head of household.
  //   2024: https://www.irs.gov/pub/irs-prior/i1040tt--2024.pdf
  //   2025: https://www.irs.gov/pub/irs-pdf/i1040tt.pdf
  test.each([
    // [year, taxable (inside the row), row, single, mfj, hoh]
    [2025, 14926.31, '14,900-14,950', 1553, 1493, 1493],
    [2025, 60010, '60,000-60,050', 8120, 6726, 6863],
    [2025, 2980.5, '2,975-3,000 (a $25 row)', 299, 299, 299],
    [2025, 99975.5, '99,950-100,000', 16909, 11823, 15170],
    [2024, 14926.31, '14,900-14,950', 1559, 1493, 1493],
    [2024, 60010, '60,000-60,050', 8259, 6739, 6872],
    [2024, 2980.5, '2,975-3,000 (a $25 row)', 299, 299, 299],
    [2024, 99975.5, '99,950-100,000', 17048, 12101, 15354],
  ])('%i taxable %f, row %s: single %i, MFJ %i, HOH %i', (year, taxable, _row, single, mfj, hoh) => {
    expect(tax(year, 'single', taxable)).toBe(single);
    expect(tax(year, 'mfj', taxable)).toBe(mfj);
    expect(tax(year, 'hoh', taxable)).toBe(hoh);
  });
  test('rows that straddle a bracket boundary use the midpoint, as published', () => {
    expect(tax(2024, 'single', 47120)).toBe(5423); // row 47,100-47,150, wholly in the 12% bracket
    expect(tax(2024, 'single', 47160)).toBe(5432); // row 47,150-47,200, midpoint 47,175: 5,426 + 22% x 25 = 5,431.50 -> 5,432
    expect(tax(2025, 'mfj', 25320)).toBe(2562); // the IRS's own example: $25,300-25,350, married filing jointly
  });
  test('the smallest rows: $0-5, $5-15, $15-25, then $25 wide', () => {
    expect([0, 4.99, 5, 14.99, 15, 24.99, 25, 49.99, 50, 74.99].map((t) => tax(2025, 'single', t)))
      .toEqual([0, 0, 1, 1, 2, 2, 4, 4, 6, 6]); // published: 0, 1, 2, 4, 6
    expect(taxTableRow(25)).toEqual([25, 50]);
    expect(taxTableRow(2999.99)).toEqual([2975, 3000]);
    expect(taxTableRow(3000)).toEqual([3000, 3050]);
    expect(taxTableRow(99999.99)).toEqual([99950, 100000]);
  });
  test('a row edge belongs to the row above it, and $100,000 up is bracket arithmetic', () => {
    expect(taxTableRow(14950)).toEqual([14950, 15000]);
    expect(tax(2025, 'single', 14950)).toBe(1559); // published row 14,950-15,000
    // from $100,000 the Tax Computation Worksheet is the bracket formula, and cents stay
    expect(tax(2025, 'single', 100000)).toBe(16914); // 1,192.50 + 12% x 36,550 + 22% x 51,525
    expect(tax(2025, 'single', 100000.5)).toBe(16914.11); // + 22% x 0.50
  });
  test('2026: no table is published yet; the same rule on the Rev. Proc. 2025-32 rates', () => {
    // row 60,000-60,050 midpoint 60,025: 5,800 + 22% x (60,025 - 50,400) = 7,917.50 -> 7,918
    expect(tax(2026, 'single', 60010)).toBe(7918);
    // row 14,900-14,950 midpoint 14,925: 1,240 + 12% x (14,925 - 12,400) = 1,543
    expect(tax(2026, 'single', 14926.31)).toBe(1543);
  });
});

describe('the fingerprint (what Mark filed is bound to)', () => {
  const base = { gross_receipts: 60000, other_income: 1000 };
  test('the same return gives the same fingerprint; any changed figure gives another', () => {
    const a = computeReturn(inputs(base));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(computeReturn(inputs(base)).fingerprint).toBe(a.fingerprint);
    expect(computeReturn(inputs({ ...base, gross_receipts: 60000.01 })).fingerprint).not.toBe(a.fingerprint);
    expect(computeReturn(inputs({ ...base, carry_in: { nol: 1 } })).fingerprint).not.toBe(a.fingerprint);
  });
  test('today, the warnings and the status do not change it', () => {
    const a = computeReturn(inputs({ ...base, today: '2026-01-15' }));
    const b = computeReturn(inputs({ ...base, today: '2026-04-01', warnings: [{ code: 'x', message: 'y' }], status: 'filed' }));
    expect(b.reserve).not.toEqual(a.reserve);
    expect(b.fingerprint).toBe(a.fingerprint);
  });
});

describe('Schedule SE', () => {
  const se = (profit, year = 2025) => computeReturn(inputs({ year, gross_receipts: profit }));
  test('nothing when net earnings are under $400', () => {
    expect(se(433).se_tax).toBe(0); //   433 x 0.9235 = 399.88
    expect(se(400).se_tax).toBe(0);
    expect(se(434).se_tax).toBe(61.32); // 434 x 0.9235 = 400.80 x 15.3% = 61.32
  });
  test('the Social Security part stops at the wage base', () => {
    // 200,000 x 0.9235 = 184,700: 176,100 x 12.4% = 21,836.40 + 184,700 x 2.9% = 5,356.30
    expect(se(200000).se_tax).toBe(27192.7);
    expect(se(200000, 2024).se_tax).toBe(26262.7); // 168,600 x 12.4% = 20,906.40 + 5,356.30
  });
  test('Additional Medicare Tax counts SE earnings above the threshold, outside the half-SE deduction', () => {
    const r = se(240000); // base 221,640: 21,836.40 + 6,427.56 = 28,263.96; 0.9% x 21,640 = 194.76
    expect(r.se_tax).toBe(28263.96);
    expect(r.additional_medicare_tax).toBe(194.76);
    expect(r.half_se_deduction).toBe(14131.98);
    expect(r.total_tax).toBe(Math.round((r.income_tax + 28263.96 + 194.76) * 100) / 100);
  });
  test('wages in other income can use up the wage base: a warning, no number changes', () => {
    // base 40,000 x 0.9235 = 36,940; with 150,000 of other income that is over the 176,100 wage base
    const r = computeReturn(inputs({ gross_receipts: 40000, other_income: 150000 }));
    expect(r.warnings.find((w) => w.code === 'ss_wage_base_wages').message).toBe('Wages use up the Social Security wage base before self-employment earnings do. This engine does not subtract wages in Other income, so the SE tax can be too high. Check Schedule SE lines 8a to 10 by hand.');
    expect(r.se_tax).toBe(se(40000).se_tax);
    // 36,940 + 139,160 = 176,100: at the wage base, not over it
    expect(codes(computeReturn(inputs({ gross_receipts: 40000, other_income: 139160 })))).not.toContain('ss_wage_base_wages');
    expect(codes(se(40000))).not.toContain('ss_wage_base_wages');
  });
});

describe('home office', () => {
  const base = { year: 2025, gross_receipts: 50000, expense_lines: [{ line: '22', amount: 10000 }] };
  test('actual: this year plus the carry-in, inside the cap, no carryover', () => {
    const r = computeReturn(inputs({ ...base, home_office: { method: 'actual', deduction: 3000 }, carry_in: { home_office: 2000 } }));
    expect(r.lines.home_office_deduction).toBe(5000);
    expect(r.carry_out.home_office).toBe(0);
    expect(r.net_profit).toBe(35000);
  });
  test('actual: gross less other expenses is the cap, the excess carries out', () => {
    const r = computeReturn(inputs({ ...base, home_office: { method: 'actual', deduction: 30000 }, carry_in: { home_office: 15000 } }));
    expect(r.lines.home_office_deduction).toBe(40000); // 50,000 - 10,000
    expect(r.carry_out.home_office).toBe(5000);
    expect(r.net_profit).toBe(0);
  });
  test('simplified: capped the same way and never carried', () => {
    const r = computeReturn(inputs({ year: 2025, gross_receipts: 11000, expense_lines: [{ line: '22', amount: 10000 }], home_office: { method: 'simplified', deduction: 1500 } }));
    expect(r.lines.home_office_deduction).toBe(1000);
    expect(r.carry_out.home_office).toBe(0);
  });
  test('simplified does not use an old carryover: it stays, with a warning', () => {
    const r = computeReturn(inputs({ ...base, home_office: { method: 'simplified', deduction: 1500 }, carry_in: { home_office: 700 } }));
    expect(r.lines.home_office_deduction).toBe(1500);
    expect(r.carry_out.home_office).toBe(700);
    expect(codes(r)).toContain('home_office_carry_idle');
  });
  test('no home office entered: the carryover waits', () => {
    const r = computeReturn(inputs({ ...base, carry_in: { home_office: 700 } }));
    expect(r.carry_out.home_office).toBe(700);
    expect(r.lines.home_office_deduction).toBe(0);
  });
});

describe('section 179', () => {
  const base = { year: 2025, gross_receipts: 100000, expense_lines: [{ line: '22', amount: 20000 }] };
  test('limited to gross receipts less other expenses, the rest carries out', () => {
    const r = computeReturn(inputs({ ...base, depreciation: { regular: 0, sec179_elected: 90000 } }));
    expect(r.lines.sec179_allowed).toBe(80000);
    expect(r.carry_out.sec179).toBe(10000);
    expect(r.net_profit).toBe(0);
  });
  test('the carry-in joins the pool', () => {
    const r = computeReturn(inputs({ ...base, depreciation: { regular: 0, sec179_elected: 90000 }, carry_in: { sec179: 5000 } }));
    expect(r.sec179).toMatchObject({ pool: 95000, allowed: 80000 });
    expect(r.carry_out.sec179).toBe(15000);
  });
  test('inside the limit it is allowed in full and nothing carries', () => {
    const r = computeReturn(inputs({ ...base, depreciation: { regular: 5000, sec179_elected: 30000 } }));
    expect(r.lines.sec179_allowed).toBe(30000);
    expect(r.carry_out.sec179).toBe(0);
    expect(r.net_profit).toBe(45000); // 100,000 - 20,000 - 5,000 - 30,000
  });
  test('the year dollar limit also caps it, and the election over the limit is not carried forward', () => {
    const K = { ...getYearConstants(2025), sec179_limit: 50000 };
    const r = computeReturn(inputs({ ...base, constants: K, depreciation: { regular: 0, sec179_elected: 70000 } }));
    expect(r.lines.sec179_allowed).toBe(50000);
    expect(r.carry_out.sec179).toBe(0); // the 20,000 over the dollar limit is not a carryover (Form 4562 line 9)
    expect(r.sec179.pool).toBe(50000);
    expect(r.warnings.find((w) => w.code === 'sec179_over_limit').message).toMatch(/the rest is not carried forward/);
  });
  test('a carry-in is used up to what the dollar limit leaves; the rest stays carried', () => {
    // Treas. Reg. 1.179-3(d) example: limit 10,000, business income 100,000,
    // 8,000 elected, 3,000 carried in: 2,000 of the carry-in is deducted, 1,000 carries on
    const K = { ...getYearConstants(2025), sec179_limit: 10000 };
    const r = computeReturn(inputs({ gross_receipts: 100000, constants: K, carry_in: { sec179: 3000 }, depreciation: { regular: 0, sec179_elected: 8000 } }));
    expect(r.lines.sec179_allowed).toBe(10000);
    expect(r.carry_out.sec179).toBe(1000);
    // an election over the limit with a carry-in: only the carry-in carries on
    const over = computeReturn(inputs({ gross_receipts: 100000, constants: K, carry_in: { sec179: 3000 }, depreciation: { regular: 0, sec179_elected: 12000 } }));
    expect(over.lines.sec179_allowed).toBe(10000);
    expect(over.carry_out.sec179).toBe(3000);
  });
  test('the home office comes after it: section 179 uses the whole business income, the home office gets what is left', async () => {
    // income before both 80,000 (100,000 - 20,000); pool 90,000; actual home office 10,000
    const r = computeReturn(inputs({ ...base, home_office: { method: 'actual', deduction: 10000 }, depreciation: { regular: 0, sec179_elected: 90000 } }));
    expect(r.lines.sec179_allowed).toBe(80000);
    expect(r.carry_out.sec179).toBe(10000);
    expect(r.lines.home_office_deduction).toBe(0);
    expect(r.carry_out.home_office).toBe(10000);
    expect(r.net_profit).toBe(0);
  });
  test('the home office gets what section 179 leaves, and the rest carries out (actual) or expires (simplified)', () => {
    const o = { ...base, depreciation: { regular: 0, sec179_elected: 75000 } }; // leaves 80,000 - 75,000 = 5,000
    const actual = computeReturn(inputs({ ...o, home_office: { method: 'actual', deduction: 4000 }, carry_in: { home_office: 3000 } }));
    expect(actual.lines.home_office_deduction).toBe(5000);
    expect(actual.carry_out.home_office).toBe(2000); // 7,000 - 5,000
    const simplified = computeReturn(inputs({ ...o, home_office: { method: 'simplified', deduction: 6000 } }));
    expect(simplified.lines.home_office_deduction).toBe(5000);
    expect(simplified.carry_out.home_office).toBe(0);
  });
  test('the section 179 limit is the same with or without a home office', () => {
    const d = { regular: 0, sec179_elected: 60000 };
    const without = computeReturn(inputs({ ...base, depreciation: d }));
    const withHo = computeReturn(inputs({ ...base, depreciation: d, home_office: { method: 'actual', deduction: 15000 } }));
    expect(withHo.sec179.income_limit).toBe(without.sec179.income_limit);
    expect(withHo.lines.sec179_allowed).toBe(60000);
    expect(withHo.lines.home_office_deduction).toBe(15000); // 80,000 - 60,000 leaves 20,000
  });
});

describe('section 179 and wages', () => {
  test('other income with a section 179 pool warns that wages can raise the limit; no number changes', () => {
    const d = { regular: 0, sec179_elected: 5000 };
    const base = { gross_receipts: 20000, depreciation: d };
    const withWages = computeReturn(inputs({ ...base, other_income: 40000 }));
    const without = computeReturn(inputs(base));
    const w = withWages.warnings.find((x) => x.code === 'sec179_wages');
    expect(w.message).toBe("Section 179's income limit can include wages; this engine counts business income only. Check Form 4562 line 11 by hand.");
    expect(codes(without)).not.toContain('sec179_wages');
    expect(withWages.lines.sec179_allowed).toBe(without.lines.sec179_allowed);
    expect(withWages.sec179.income_limit).toBe(20000);
  });
  test('no section 179 pool, no warning', () => {
    expect(codes(computeReturn(inputs({ gross_receipts: 20000, other_income: 40000 })))).not.toContain('sec179_wages');
  });
});

describe('the 2026 minimum QBI deduction', () => {
  // profit 1,500 + other income 30,000 (the auditor's case): SE base 1,385.25 x 15.3% = 211.94,
  // half 105.97; QBI 1,394.03; 20% = 278.81, under the 400 minimum
  test('a warning when it could apply; no number changes', () => {
    const r = computeReturn(inputs({ year: 2026, gross_receipts: 1500, other_income: 30000 }));
    expect(r.qbi_deduction).toBe(278.81);
    expect(r.warnings.find((w) => w.code === 'qbi_minimum').message).toBe('The $400.00 minimum QBI deduction (IRC 199A(i)) may apply to an active business with at least $1,000.00 of QBI. This engine does not add it: check Form 8995 with a tax preparer.');
  });
  test('no warning before 2026, under $1,000 of QBI, at a deduction of $400 or more, or with no taxable income left', () => {
    expect(codes(computeReturn(inputs({ year: 2025, gross_receipts: 1500, other_income: 30000 })))).not.toContain('qbi_minimum');
    expect(codes(computeReturn(inputs({ year: 2026, gross_receipts: 1000, other_income: 30000 })))).not.toContain('qbi_minimum'); // QBI 929.35
    expect(codes(computeReturn(inputs({ year: 2026, gross_receipts: 2500, other_income: 30000 })))).not.toContain('qbi_minimum'); // 20% of 2,323.38 = 464.68
    expect(codes(computeReturn(inputs({ year: 2026, gross_receipts: 1500 })))).not.toContain('qbi_minimum'); // under the standard deduction
  });
});

describe('NOL and QBI', () => {
  test('the NOL takes at most 80% of taxable income, the rest carries out', () => {
    // profit 60,000: SE 55,410 x 15.3% = 8,477.73; half 4,238.87 (half cent up)
    // AGI 55,761.13; less standard 15,750 = 40,011.13; 80% = 32,008.90
    const r = computeReturn(inputs({ gross_receipts: 60000, carry_in: { nol: 50000 } }));
    expect(r.se_tax).toBe(8477.73);
    expect(r.half_se_deduction).toBe(4238.87);
    expect(r.agi_before_nol).toBe(55761.13);
    expect(r.nol_used).toBe(32008.9);
    expect(r.agi).toBe(23752.23); // AGI is after the NOL deduction (Schedule 1 line 8a): 55,761.13 - 32,008.90
    expect(r.carry_out.nol).toBe(17991.1);
    // taxable after NOL 8,002.23; QBI 20% of 55,761.13 = 11,152.23 vs 20% of 8,002.23 = 1,600.45
    expect(r.qbi_deduction).toBe(1600.45);
    expect(r.taxable_income).toBe(6401.78);
    expect(r.income_tax).toBe(643); // Tax Table row 6,400-6,450: 10% of the midpoint 6,425 = 642.50, a half rounds up
  });
  test('a small NOL is used in full', () => {
    const r = computeReturn(inputs({ gross_receipts: 60000, carry_in: { nol: 10000 } }));
    expect(r.nol_used).toBe(10000);
    expect(r.carry_out.nol).toBe(0);
  });
  test('a loss year adds its loss, less other income, to the NOL; and a QBI loss', () => {
    const r = computeReturn(inputs({ gross_receipts: 10000, expense_lines: [{ line: '22', amount: 30000 }], other_income: 3000, carry_in: { nol: 4000, qbi_loss: 500 } }));
    expect(r.net_profit).toBe(-20000);
    expect(r.se_tax).toBe(0);
    expect(r.carry_out.nol).toBe(21000); // 4,000 in + (20,000 - 3,000)
    expect(r.carry_out.qbi_loss).toBe(20500); // 500 in + 20,000
    expect(r.total_tax).toBe(0);
  });
  test('QBI: a loss carryforward comes off first', () => {
    // profit 100,000: SE 92,350 x 15.3% = 14,129.55, half 7,064.78, AGI 92,935.22, taxable 77,185.22
    const r = computeReturn(inputs({ gross_receipts: 100000, carry_in: { qbi_loss: 30000 } }));
    expect(r.agi).toBe(92935.22);
    expect(r.qbi_deduction).toBe(12587.04); // 20% x (92,935.22 - 30,000)
  });
  test('QBI: capped at 20% of taxable income', () => {
    const r = computeReturn(inputs({ gross_receipts: 100000 }));
    expect(r.qbi_deduction).toBe(15437.04); // 20% x 77,185.22, under 20% x 92,935.22 = 18,587.04
    expect(r.taxable_income).toBe(61748.18);
  });
  test('QBI: a loss carryforward bigger than the QBI carries on', () => {
    const r = computeReturn(inputs({ gross_receipts: 100000, carry_in: { qbi_loss: 100000 } }));
    expect(r.qbi_deduction).toBe(0);
    expect(r.carry_out.qbi_loss).toBe(7064.78); // 100,000 - 92,935.22
  });
  test('QBI over its threshold warns', () => {
    expect(codes(computeReturn(inputs({ gross_receipts: 300000 })))).toContain('qbi_threshold');
    expect(codes(computeReturn(inputs({ gross_receipts: 100000 })))).not.toContain('qbi_threshold');
  });
});

describe('estimates, reserve and due dates', () => {
  test('a zero-tax year needs no estimates', () => {
    const r = computeReturn(inputs({ gross_receipts: 20000, expense_lines: [{ line: '22', amount: 20000 }] }));
    expect(r.total_tax).toBe(0);
    expect(r.estimates.no_estimates_required).toBe(true);
    expect(r.estimates.next_year_safe_harbor).toBe(0);
    expect(r.estimates.note).toContain('6654(e)(2)');
  });
  test('safe harbor is 100% of this year, 110% when AGI is over $150,000', () => {
    const low = computeReturn(inputs({ gross_receipts: 100000 }));
    expect(low.estimates.safe_harbor_pct).toBe(1);
    expect(low.estimates.next_year_safe_harbor).toBe(low.total_tax);
    const high = computeReturn(inputs({ gross_receipts: 200000 }));
    expect(high.estimates.safe_harbor_pct).toBe(1.1);
    expect(high.estimates.next_year_safe_harbor).toBe(Math.round(high.total_tax * 1.1 * 100) / 100);
    expect(high.estimates.quarterly).toBe(Math.round(high.estimates.next_year_safe_harbor / 4 * 100) / 100);
  });
  test('the 110% switch tests AGI after the NOL, at the boundary', () => {
    // profit 0 so there is no SE tax: AGI is the other income less the NOL
    const run = (otherIncome, nol) => computeReturn(inputs({ other_income: otherIncome, carry_in: { nol } }));
    expect(run(150000, 0)).toMatchObject({ agi: 150000, estimates: { safe_harbor_pct: 1 } }); // not over
    expect(run(150000.01, 0)).toMatchObject({ agi: 150000.01, estimates: { safe_harbor_pct: 1.1 } });
    // 160,000 less a 10,000 NOL is exactly 150,000 after the NOL: still 100%
    const after = run(160000, 10000);
    expect(after).toMatchObject({ agi_before_nol: 160000, nol_used: 10000, agi: 150000, estimates: { safe_harbor_pct: 1 } });
    // one cent less NOL leaves 150,000.01: 110%
    expect(run(160000, 9999.99)).toMatchObject({ agi: 150000.01, estimates: { safe_harbor_pct: 1.1 } });
  });
  test('the due date is April 15, moved off a weekend', () => {
    expect(dueDate(2024)).toBe('2025-04-15');
    expect(dueDate(2025)).toBe('2026-04-15');
    expect(dueDate(2027)).toBe('2028-04-17'); // a Saturday
    expect(dueDate(2028)).toBe('2029-04-16'); // a Sunday
  });
  test('reserve: the months left in a running year, then the months to the due date, then now', () => {
    expect(reserve({ year: 2026, today: '2026-10-24', balance: 3000 })).toMatchObject({ months_left: 3, monthly: 1000 });
    expect(reserve({ year: 2025, today: '2026-03-10', balance: 500 })).toMatchObject({ months_left: 1, monthly: 500 });
    expect(reserve({ year: 2025, today: '2026-01-10', balance: 900 })).toMatchObject({ months_left: 3, monthly: 300 });
    expect(reserve({ year: 2025, today: '2026-10-24', balance: 900 })).toMatchObject({ months_left: 1, basis: 'due now' });
    expect(reserve({ year: 2025, today: '2026-10-24', balance: -50 })).toMatchObject({ amount: 0, monthly: 0 });
  });
});

describe('warnings', () => {
  test('a year that is still running is to date', () => {
    expect(codes(computeReturn(inputs({ year: 2026, today: TODAY })))).toContain('year_in_progress');
    expect(codes(computeReturn(inputs({ year: 2025, today: TODAY })))).not.toContain('year_in_progress');
  });
  test('the simplified home office on a late return', () => {
    const ho = { method: 'simplified', deduction: 1500 };
    const late = (extra) => computeReturn(inputs({ year: 2024, gross_receipts: 20000, home_office: ho, today: TODAY, ...extra }));
    expect(codes(late({}))).toContain('simplified_late'); // not filed, due 2025-04-15
    expect(codes(late({ status: 'filed', filed_on: '2025-04-10', filed_snapshot: null }))).not.toContain('simplified_late');
    expect(codes(late({ status: 'filed', filed_on: '2025-05-01', filed_snapshot: null }))).toContain('simplified_late');
    expect(codes(computeReturn(inputs({ year: 2024, gross_receipts: 20000, home_office: { method: 'actual', deduction: 1500 }, today: TODAY })))).not.toContain('simplified_late');
    expect(codes(computeReturn(inputs({ year: 2025, gross_receipts: 20000, home_office: ho, today: '2026-03-01' })))).not.toContain('simplified_late');
  });
  test('a filed year the books now disagree with', () => {
    const snap = { result: { net_profit: 1000, total_tax: 100, carry_out: { nol: 0, qbi_loss: 0, sec179: 0, home_office: 0 } } };
    const r = computeReturn(inputs({ gross_receipts: 2000, status: 'filed', filed_on: '2026-04-01', filed_snapshot: snap }));
    const w = r.warnings.find((x) => x.code === 'filed_differs');
    expect(w.message).toContain('net profit was $1,000.00 when filed, now $2,000.00');
    // the snapshot as fileYear freezes it: the result without its warnings
    const frozen = (over) => { const { warnings: _w, ...result } = computeReturn(inputs(over)); return { result }; };
    const same = computeReturn(inputs({ gross_receipts: 1000, status: 'filed', filed_on: '2026-04-01', filed_snapshot: frozen({ gross_receipts: 1000 }) }));
    expect(codes(same)).not.toContain('filed_differs');
  });
  test('a filed year whose expenses moved between Schedule C lines (same profit, same tax) warns too', () => {
    const books = (lines) => ({ gross_receipts: 20000, expense_lines: lines });
    const filed = (() => { const { warnings: _w, ...result } = computeReturn(inputs(books([{ line: '8', amount: 3000 }]))); return { result }; })();
    const r = computeReturn(inputs({ ...books([{ line: '8', amount: 2000 }, { line: '22', amount: 1000 }]), status: 'filed', filed_on: '2026-04-01', filed_snapshot: filed }));
    expect(r.net_profit).toBe(filed.result.net_profit);
    expect(r.warnings.find((x) => x.code === 'filed_differs').message).toBe('This year is marked filed, but the books now give a different answer: Schedule C line 8 (Advertising) was $3,000.00 when filed, now $2,000.00; Schedule C line 22 (Supplies) was $0.00 when filed, now $1,000.00.');
  });
  test('a line the engine does not know lands on 27a with a warning; lines 13 and 30 rows are not summed', () => {
    const r = computeReturn(inputs({ gross_receipts: 5000, expense_lines: [{ line: '99', amount: 100 }, { line: '27a', amount: 50 }, { line: '13', amount: 700 }, { line: '30', amount: 800 }] }));
    expect(r.schedule_c.find((l) => l.line === '27a').amount).toBe(150);
    expect(r.net_profit).toBe(4850);
    expect(codes(r)).toContain('unknown_line');
  });
  test('an unknown filing status is a 400', () => {
    expect(() => computeReturn(inputs({ filing_status: 'mfs' }))).toThrow(/filing_status/);
  });
});

describe('Schedule C output', () => {
  test('lines print in form order, with gross first and net profit last', () => {
    const r = computeReturn(inputs({
      gross_receipts: 10000,
      expense_lines: [{ line: '27a', amount: 100 }, { line: '8', amount: 200 }, { line: '16a', amount: 300 }, { line: '10', amount: 50 }],
      depreciation: { regular: 400, sec179_elected: 500 },
      home_office: { method: 'actual', deduction: 600 },
    }));
    expect(r.schedule_c.map((l) => l.line)).toEqual(['1', '8', '10', '13', '13', '16a', '27a', '30', '31']);
    expect(r.schedule_c.at(-1)).toMatchObject({ line: '31', amount: 7850 });
    expect(r.lines.total_expenses).toBe(2150);
  });
});

describe('cross-check against the structure of the 2025 working script', () => {
  // Synthetic inputs, same ordering as the script:
  //   gross 150,000; line 8 3,000 + line 22 9,000 + line 25 2,000 + line 27a 1,000
  //   = 15,000, regular depreciation 2,000 -> other expenses 17,000
  //   section 179 pool 41,000 elected + 20,000 carry-in = 61,000
  //     limit = 150,000 - 17,000 = 133,000 (the home office is not subtracted): allowed in full, carry 0
  //   actual home office 5,850 + carry-in 1,150 = 7,000, capped at 133,000 - 61,000 = 72,000: allowed
  //   profit = 150,000 - 17,000 - 7,000 - 61,000 = 65,000
  //   SE base 65,000 x 0.9235 = 60,027.50; SE tax x 15.3% = 9,184.21 (9,184.2075)
  //   half 4,592.11; income before the NOL 65,000 - 4,592.11 = 60,407.89; standard (2025 single) 15,750
  //   taxable before NOL 44,657.89; 80% = 35,726.31; NOL 26,000 used in full -> 18,657.89
  //   AGI on the return is after the NOL: 60,407.89 - 26,000 = 34,407.89
  //   QBI: (60,407.89 - 3,000 loss) = 57,407.89 x 20% = 11,481.58 vs 20% x 18,657.89 = 3,731.58 -> 3,731.58
  //   taxable 18,657.89 - 3,731.58 = 14,926.31
  //   income tax from the Tax Table (under $100,000): taxable 14,926.31 is in the
  //     14,900-14,950 row, midpoint 14,925: 1,192.50 + 12% x 3,000 = 1,552.50 -> 1,553
  //     (the published 2025 table shows 1,553 for single on that row)
  //   total 1,553 + 9,184.21 = 10,737.21; less 2,000 estimates = 8,737.21
  // (the script itself, with bracket arithmetic unrounded, gives 10,736.87: the
  // 34 cents is the table's whole-dollar rounding)
  const cross = {
    year: 2025, filing_status: 'single', other_income: 0, estimates_paid: 2000, gross_receipts: 150000,
    carry_in: { nol: 26000, qbi_loss: 3000, sec179: 20000, home_office: 1150 },
    expense_lines: [{ line: '8', amount: 3000 }, { line: '22', amount: 9000 }, { line: '25', amount: 2000 }, { line: '27a', amount: 1000 }],
    depreciation: { regular: 2000, sec179_elected: 41000 },
    home_office: { method: 'actual', deduction: 5850 },
    today: '2026-10-24',
  };
  test('a year with tax', () => {
    const r = computeReturn(cross);
    expect(r).toMatchObject({
      net_profit: 65000, se_tax: 9184.21, half_se_deduction: 4592.11, agi_before_nol: 60407.89, agi: 34407.89, nol_used: 26000,
      qbi_deduction: 3731.58, taxable_income: 14926.31, income_tax: 1553, total_tax: 10737.21, owed: 8737.21,
    });
    expect(r.lines).toMatchObject({ home_office_deduction: 7000, sec179_allowed: 61000, total_expenses: 85000 });
    expect(r.carry_out).toEqual({ nol: 0, qbi_loss: 0, sec179: 0, home_office: 0 });
  });
  test('the same books on a smaller year: the caps bite and the carryovers move on', () => {
    // The 2025 script took the home office first (so its 7,000 came off the
    // section 179 limit and 1,000 of the pool carried). Form 8829 line 8 starts
    // from Schedule C line 29, after line 13, so the engine takes section 179
    // first: gross 84,000, room 84,000 - 17,000 = 67,000, the whole 61,000 pool
    // is allowed (nothing carries), and the home office gets 67,000 - 61,000 =
    // 6,000 of its 7,000 (1,000 carries out). Profit 0: no SE tax, no taxable
    // income, nothing used of the NOL or QBI loss.
    const r = computeReturn({ ...cross, gross_receipts: 84000 });
    expect(r.net_profit).toBe(0);
    expect(r.lines.sec179_allowed).toBe(61000);
    expect(r.lines.home_office_deduction).toBe(6000);
    expect(r.total_tax).toBe(0);
    expect(r.nol_used).toBe(0);
    expect(r.carry_out).toEqual({ nol: 26000, qbi_loss: 3000, sec179: 0, home_office: 1000 });
    expect(r.estimates.no_estimates_required).toBe(true);
    expect(r.owed).toBe(-2000); // the estimates paid come back
  });
});

describe('splitDepreciation (the register, through the P&L proration)', () => {
  const base = { asset_category: 'equipment', business_use_pct: 100, depreciation_convention: 'half_year' };
  test('section 179 is separated from regular depreciation, including a MACRS asset with a 179 election', () => {
    const assets = [
      { ...base, depreciation_method: 'section_179', purchase_cost: 10000, section_179_amount: 10000, placed_in_service_date: '2025-05-01' },
      { ...base, depreciation_method: 'MACRS', irs_class: '5-year', purchase_cost: 5000, placed_in_service_date: '2024-06-01' }, // year 2: 32%
      { ...base, depreciation_method: 'straight_line', annual_depreciation: 1200, purchase_cost: 6000, placed_in_service_date: '2023-01-01' },
      { ...base, depreciation_method: 'MACRS', irs_class: '5-year', section_179_elected: true, section_179_amount: 2000, purchase_cost: 7000, placed_in_service_date: '2025-03-01' }, // 5,000 x 20%
    ];
    expect(splitDepreciation(assets, '2025-01-01', '2025-12-31')).toEqual({ regular: 3800, sec179_elected: 12000 });
    // 2026: 19.2% of 5,000 + 1,200 + 32% of the 5,000 left on the fourth asset; no new 179
    expect(splitDepreciation(assets, '2026-01-01', '2026-12-31')).toEqual({ regular: 3760, sec179_elected: 0 });
  });
});

describe('gatherInputs and fileYear (database mocked)', () => {
  beforeEach(() => {
    state.rows = {
      expenses: [
        { line: '8', n: 2, total: '300.50' },
        { line: '13', n: 1, total: '900' },
        { line: '30', n: 1, total: '400' },
        { line: null, n: 3, total: '75' },
        { line: '99', n: 1, total: '10' },
      ],
      equipment_register: [],
      tax_home_office: { tax_year: 2025, method: 'actual', sq_ft: 100, months: 12, home_sq_ft: 1000, rent: '12000.00', utilities: '0.00', insurance: '0.00', other: '0.00' },
    };
    state.pnl = {
      revenue: { total: 12345.67 },
      operatingExpenses: { categories: [{ name: 'Stripe Processing Fees (synced)', amount: 321.09 }, { name: 'Supplies', amount: 5 }] },
      coverage: { complete: false, note: 'sync is behind' },
    };
    state.detail = {
      year: 2025, exists: true,
      row: { filing_status: 'mfj', other_income: 1000, estimates_paid: 200, status: 'draft', filed_on: null, filed_snapshot: null, version: 'v1' },
      carry_in: { nol: { value: 5 }, qbi_loss: { value: 6 }, sec179: { value: 7 }, home_office: { value: 8 } },
      prior_version: 'p1',
    };
  });

  test('revenue is the P&L figure; fees join line 10; lines 13 and 30 are left out; uncategorized goes to 27a', async () => {
    const g = await engine.gatherInputs(2025);
    expect(g).toMatchObject({ year: 2025, filing_status: 'mfj', other_income: 1000, estimates_paid: 200, gross_receipts: 12345.67 });
    expect(g.carry_in).toEqual({ nol: 5, qbi_loss: 6, sec179: 7, home_office: 8 });
    expect(g.expense_lines).toEqual([
      { line: '8', amount: 300.5 }, { line: '27a', amount: 75 }, { line: '99', amount: 10 }, { line: '10', amount: 321.09 },
    ]);
    expect(g.home_office).toEqual({ method: 'actual', deduction: 1200 });
    expect(g.warnings.map((w) => w.code).sort()).toEqual(['computed_line_expenses', 'computed_line_expenses', 'pnl_coverage', 'uncategorized']);
  });

  test('computeYear feeds it to the pure engine', async () => {
    const r = await engine.computeYear(2025);
    expect(r.filing_status).toBe('mfj');
    expect(r.lines.gross_receipts).toBe(12345.67);
    expect(r.schedule_c.find((l) => l.line === '10').amount).toBe(321.09);
    expect(r.carry_in).toEqual({ nol: 5, qbi_loss: 6, sec179: 7, home_office: 8 });
    expect(codes(r)).toContain('unknown_line');
  });

  test('an unloaded year fails before any query', async () => {
    mockDb.mockClear();
    await expect(engine.gatherInputs(2023)).rejects.toMatchObject({ status: 400, message: 'tax constants for 2023 are not loaded' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  describe('fileYear: calculating and filing are one optimistic step', () => {
    beforeEach(() => {
      taxYears.ensureRow.mockClear();
      taxYears.markFiled.mockReset();
      taxYears.getYearDetail.mockClear();
    });

    test('the row exists first, the return is computed from the rows as read, and both versions go to the filing', async () => {
      const { fingerprint } = await engine.computeYear(2025); // the return on screen
      taxYears.getYearDetail.mockClear();
      taxYears.markFiled.mockResolvedValue({ status: 'filed' });
      await engine.fileYear(2025, { filed_on: '2026-04-10', fingerprint });
      expect(taxYears.ensureRow).toHaveBeenCalledWith(2025);
      expect(taxYears.ensureRow.mock.invocationCallOrder[0]).toBeLessThan(taxYears.getYearDetail.mock.invocationCallOrder[0]);
      const [y, date, snapshot, version, priorVersion] = taxYears.markFiled.mock.calls[0];
      expect([y, date, version, priorVersion]).toEqual([2025, '2026-04-10', 'v1', 'p1']);
      expect(snapshot.result.lines.gross_receipts).toBe(12345.67);
      expect(snapshot.result.fingerprint).toBe(fingerprint);
      expect(snapshot.result.warnings).toBeUndefined();
    });

    test('the books moved after the return was shown: 409, nothing filed', async () => {
      const { fingerprint } = await engine.computeYear(2025);
      state.pnl = { ...state.pnl, revenue: { total: 12400 } }; // a payment landed after the screen loaded
      await expect(engine.fileYear(2025, { fingerprint })).rejects.toMatchObject({
        status: 409, message: 'the return changed since it was shown; reload it and check it again before marking it filed',
      });
      expect(taxYears.markFiled).not.toHaveBeenCalled();
    });

    test('the prior year moved after the return was shown (its carry-out feeds a carry-in): 409, nothing filed', async () => {
      const { fingerprint } = await engine.computeYear(2025);
      state.detail = { ...state.detail, carry_in: { ...state.detail.carry_in, nol: { value: 500 } }, prior_version: 'p2' };
      await expect(engine.fileYear(2025, { fingerprint })).rejects.toMatchObject({ status: 409 });
      expect(taxYears.markFiled).not.toHaveBeenCalled();
    });

    test('no fingerprint is a 400 before the row is touched', async () => {
      await expect(engine.fileYear(2025, { filed_on: '2026-04-10' })).rejects.toMatchObject({ status: 400, message: /fingerprint/ });
      expect(taxYears.ensureRow).not.toHaveBeenCalled();
      expect(taxYears.markFiled).not.toHaveBeenCalled();
    });

    test('a PUT that lands while the return is computed is a 409 and nothing is frozen', async () => {
      // the year row as the PUT leaves it; the filing was computed from v1
      const store = { version: 'v1', frozen: null };
      const httpErr = (status, message) => Object.assign(new Error(message), { status });
      const { fingerprint } = await engine.computeYear(2025);
      pnlReport.buildPnlReport.mockImplementationOnce(async () => { store.version = 'v2'; return state.pnl; }); // the PUT commits mid-compute
      taxYears.markFiled.mockImplementation(async (_y, _d, snapshot, version) => {
        if (version !== store.version) throw httpErr(409, 'the year changed while it was being filed; reload and try again');
        store.frozen = snapshot;
        return { status: 'filed' };
      });
      await expect(engine.fileYear(2025, { fingerprint })).rejects.toMatchObject({ status: 409, message: /changed while it was being filed/ });
      expect(store.frozen).toBeNull();
      expect(taxYears.markFiled.mock.calls[0][3]).toBe('v1'); // the version read before computing, not after
    });

    test('a failed read while gathering (the prior year, say) persists nothing', async () => {
      taxYears.getYearDetail.mockRejectedValueOnce(new Error('db down'));
      await expect(engine.fileYear(2025, { fingerprint: 'fp' })).rejects.toThrow('db down');
      expect(taxYears.markFiled).not.toHaveBeenCalled();
    });

    test('a year with no constants is refused before the row is touched', async () => {
      await expect(engine.fileYear(2023)).rejects.toMatchObject({ status: 400 });
      expect(taxYears.ensureRow).not.toHaveBeenCalled();
      expect(taxYears.markFiled).not.toHaveBeenCalled();
    });
  });
});
