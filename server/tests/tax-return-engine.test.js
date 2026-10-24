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
 *  3. Section 179 is capped by gross receipts less every other deduction and
 *     the carryover is the rest. The home office is capped first: simplified
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
}));

const engine = require('../services/tax-return-engine');
const { getYearConstants, YEARS } = require('../services/tax-year-constants');

const { computeReturn, bracketTax, dueDate, reserve, splitDepreciation } = engine;
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
  test('the year dollar limit also caps it', () => {
    const K = { ...getYearConstants(2025), sec179_limit: 50000 };
    const r = computeReturn(inputs({ ...base, constants: K, depreciation: { regular: 0, sec179_elected: 70000 } }));
    expect(r.lines.sec179_allowed).toBe(50000);
    expect(r.carry_out.sec179).toBe(20000);
  });
  test('the home office is taken before it: both come out of what is left', () => {
    const r = computeReturn(inputs({ ...base, home_office: { method: 'actual', deduction: 10000 }, depreciation: { regular: 0, sec179_elected: 90000 } }));
    expect(r.lines.home_office_deduction).toBe(10000);
    expect(r.lines.sec179_allowed).toBe(70000); // 100,000 - 20,000 - 10,000
    expect(r.carry_out.sec179).toBe(20000);
  });
});

describe('NOL and QBI', () => {
  test('the NOL takes at most 80% of taxable income, the rest carries out', () => {
    // profit 60,000: SE 55,410 x 15.3% = 8,477.73; half 4,238.87 (half cent up)
    // AGI 55,761.13; less standard 15,750 = 40,011.13; 80% = 32,008.90
    const r = computeReturn(inputs({ gross_receipts: 60000, carry_in: { nol: 50000 } }));
    expect(r.se_tax).toBe(8477.73);
    expect(r.half_se_deduction).toBe(4238.87);
    expect(r.agi).toBe(55761.13);
    expect(r.nol_used).toBe(32008.9);
    expect(r.carry_out.nol).toBe(17991.1);
    // taxable after NOL 8,002.23; QBI 20% of 55,761.13 = 11,152.23 vs 20% of 8,002.23 = 1,600.45
    expect(r.qbi_deduction).toBe(1600.45);
    expect(r.taxable_income).toBe(6401.78);
    expect(r.income_tax).toBe(640.18);
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
    const same = computeReturn(inputs({ gross_receipts: 1000, status: 'filed', filed_on: '2026-04-01', filed_snapshot: { result: { ...snap.result, total_tax: computeReturn(inputs({ gross_receipts: 1000 })).total_tax } } }));
    expect(codes(same)).not.toContain('filed_differs');
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
  //   actual home office 5,850 + carry-in 1,150 = 7,000 (cap 133,000: allowed)
  //   section 179 pool 41,000 elected + 20,000 carry-in = 61,000
  //     limit = 150,000 - 17,000 - 7,000 = 126,000: allowed in full, carry 0
  //   profit = 150,000 - 17,000 - 7,000 - 61,000 = 65,000
  //   SE base 65,000 x 0.9235 = 60,027.50; SE tax x 15.3% = 9,184.21 (9,184.2075)
  //   half 4,592.11; AGI 65,000 - 4,592.11 = 60,407.89; standard (2025 single) 15,750
  //   taxable before NOL 44,657.89; 80% = 35,726.31; NOL 26,000 used in full -> 18,657.89
  //   QBI: (60,407.89 - 3,000 loss) = 57,407.89 x 20% = 11,481.58 vs 20% x 18,657.89 = 3,731.58 -> 3,731.58
  //   taxable 18,657.89 - 3,731.58 = 14,926.31
  //   income tax 10% x 11,925 = 1,192.50 + 12% x 3,001.31 = 360.16 -> 1,552.66
  //   total 1,552.66 + 9,184.21 = 10,736.87; less 2,000 estimates = 8,736.87
  // (the script itself, unrounded, gives 10,736.87)
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
      net_profit: 65000, se_tax: 9184.21, half_se_deduction: 4592.11, agi: 60407.89, nol_used: 26000,
      qbi_deduction: 3731.58, taxable_income: 14926.31, income_tax: 1552.66, total_tax: 10736.87, owed: 8736.87,
    });
    expect(r.lines).toMatchObject({ home_office_deduction: 7000, sec179_allowed: 61000, total_expenses: 85000 });
    expect(r.carry_out).toEqual({ nol: 0, qbi_loss: 0, sec179: 0, home_office: 0 });
  });
  test('the same books on a smaller year: the caps bite and the carryovers move on', () => {
    // gross 84,000: room 84,000 - 17,000 = 67,000; home office 7,000 allowed;
    // section 179 limit 67,000 - 7,000 = 60,000 of the 61,000 pool (1,000 carries);
    // profit 0: no SE tax, no taxable income, nothing used of the NOL or QBI loss
    const r = computeReturn({ ...cross, gross_receipts: 84000 });
    expect(r.net_profit).toBe(0);
    expect(r.lines.sec179_allowed).toBe(60000);
    expect(r.total_tax).toBe(0);
    expect(r.nol_used).toBe(0);
    expect(r.carry_out).toEqual({ nol: 26000, qbi_loss: 3000, sec179: 1000, home_office: 0 });
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

describe('gatherInputs (database mocked)', () => {
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
      row: { filing_status: 'mfj', other_income: 1000, estimates_paid: 200, status: 'draft', filed_on: null, filed_snapshot: null },
      carry_in: { nol: { value: 5 }, qbi_loss: { value: 6 }, sec179: { value: 7 }, home_office: { value: 8 } },
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
});
