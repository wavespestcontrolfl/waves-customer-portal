// Payroll layer 3a: the line-by-line figures for Form 941, the Florida RT-6,
// Form 940 and W-2/W-3 from finalized pay checks. Pure aggregation; all names
// synthetic. 2026 is the only year with tables, so every check pays in 2026.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildFormFigures, parseFormPeriod, monthlyLiabilityLines, FROM_RECORDS,
} = require('../services/payroll-form-figures');
const { RATES, TAX_YEARS } = require('../services/payroll-calc');

// A stored check row. Tax columns default to zero so each test names only what it checks.
let tech = 0;
const check = (weekStart, payDate, patch = {}) => ({
  technician_id: `tech-${patch.tech ?? (tech += 1)}`,
  employee_name: 'Sample Employee',
  week_start: weekStart,
  pay_date: payDate,
  gross_cents: 100000,
  overtime_premium_cents: 0,
  federal_income_tax_cents: 0,
  social_security_cents: 0,
  medicare_cents: 0,
  additional_medicare_cents: 0,
  employer_social_security_cents: 0,
  employer_medicare_cents: 0,
  futa_cents: 0,
  fl_reemployment_cents: 0,
  ytd_gross_before_cents: 0,
  calc_snapshot: {},
  ...patch,
});
const build = (rows, extra = {}) => buildFormFigures({ year: 2026, quarter: 4, rows, ...extra });
// RT-6 rows marked paid on the Tax page well before the Form 940 due date, in full.
const paidOnTime = (...quarters) => quarters.map((q) => ({ source_key: `payroll:rt6:2026-Q${q}`, amount_paid: '100000.00', paid_date: '2026-12-31' }));
const line = (form, id) => form.rows.find((r) => r.line === id);

describe('constants come from the calculator', () => {
  test('the 2026 wage base and the rates are the calculator’s', () => {
    expect(TAX_YEARS[2026].socialSecurityWageBase).toBe(184500);
    expect(RATES).toMatchObject({ socialSecurityBp: 620, medicareBp: 145, additionalMedicareBp: 90, futaBp: 60, futaAndStateWageBaseCents: 700000 });
  });
});

describe('a quarter or year with no checks', () => {
  test('returns zeros, not an error', () => {
    const out = build([]);
    expect(out.f941.rows.filter((r) => r.kind !== 'text').every((r) => r.value === 0 && (r.value2 ?? 0) === 0)).toBe(true);
    expect(line(out.f941, '16').value).toMatch(/less than \$2,500/i);
    expect(out.rt6.rows.filter((r) => r.kind !== 'text').every((r) => r.value === 0)).toBe(true);
    expect(line(out.rt6, '5').rate).toBeNull();
    expect(line(out.f940, '12').value).toBe(0);
    expect(out.f940.rows.find((r) => r.line === '16a')).toBeUndefined();
    expect(out.w2).toEqual([]);
    expect(out.w3).toMatchObject({ boxC: 0, box1: 0 });
  });

  test('checks in another quarter leave this quarter at zero but still count for the year', () => {
    const out = build([check('2026-02-02', '2026-02-13', { tech: 1, fit: 0 })]);
    expect(line(out.f941, '2').value).toBe(0);
    expect(line(out.f940, '3').value).toBe(100000);
    expect(out.w2).toHaveLength(1);
  });
});

describe('Form 941', () => {
  test('Social Security wage base crossed mid-quarter: only the part under the base is taxable', () => {
    const out = build([
      check('2026-10-05', '2026-10-16', { tech: 1, gross_cents: 1000000, ytd_gross_before_cents: 18000000 }), // 450,000 left
      check('2026-10-12', '2026-10-23', { tech: 1, gross_cents: 1000000, ytd_gross_before_cents: 19000000 }), // none left
    ]);
    const l5a = line(out.f941, '5a');
    expect(l5a.value).toBe(450000);
    expect(l5a.rate).toBe('12.4%');
    expect(l5a.value2).toBe(55800);
    expect(line(out.f941, '2').value).toBe(2000000);
    expect(line(out.f941, '5c')).toMatchObject({ value: 2000000, value2: 58000, rate: '2.9%' });
  });

  test('Additional Medicare applies only to wages over $200,000 in the year', () => {
    const out = build([
      check('2026-10-05', '2026-10-16', { tech: 1, gross_cents: 500000, ytd_gross_before_cents: 19900000 }), // 400,000 over
      check('2026-10-12', '2026-10-23', { tech: 1, gross_cents: 100000, ytd_gross_before_cents: 20400000 }), // all over
    ]);
    expect(line(out.f941, '5d')).toMatchObject({ value: 500000, value2: 4500, rate: '0.9%' });
    // 5e adds the three column 2 amounts: 5a (none left under the base) is 0 here.
    expect(line(out.f941, '5a').value).toBe(0);
    expect(line(out.f941, '5e').value).toBe(line(out.f941, '5c').value2 + 4500);
  });

  test('line 7 is positive when the checks collected more cents than the form rounds', () => {
    const rows = [1, 2, 3].map((n) => check('2026-10-05', `2026-10-1${n}`, {
      tech: n, gross_cents: 1001, social_security_cents: 62, employer_social_security_cents: 62, medicare_cents: 15, employer_medicare_cents: 15,
    }));
    const out = build(rows);
    expect(line(out.f941, '5a').value2).toBe(372);
    expect(line(out.f941, '5c').value2).toBe(87);
    expect(line(out.f941, '5e').value).toBe(459);
    expect(line(out.f941, '7').value).toBe(3); // 462 stored less 459
    expect(line(out.f941, '10').value).toBe(462);
    expect(line(out.f941, '12').value).toBe(462);
  });

  test('line 7 is negative when the form rounds up more than the checks collected', () => {
    const rows = [1, 2, 3].map((n) => check('2026-10-05', `2026-10-1${n}`, {
      tech: n, gross_cents: 1008, social_security_cents: 62, employer_social_security_cents: 62, medicare_cents: 15, employer_medicare_cents: 15,
    }));
    const out = build(rows);
    expect(line(out.f941, '5e').value).toBe(463);
    expect(line(out.f941, '7').value).toBe(-1);
    expect(line(out.f941, '12').value).toBe(462);
  });

  test('the 12th rule: a week that holds the 12th counts, a week that does not is left out', () => {
    const q1 = (rows) => buildFormFigures({ year: 2026, quarter: 1, rows });
    // 2026-03-12 is a Thursday. The week of Mar 9 holds it; Mar 2 and Mar 16 do not.
    const out = q1([
      check('2026-03-09', '2026-03-20', { tech: 1 }),
      check('2026-03-02', '2026-03-13', { tech: 2 }),
      check('2026-03-16', '2026-03-27', { tech: 3 }),
      check('2026-03-09', '2026-03-20', { tech: 1, gross_cents: 5 }), // same employee twice
    ]);
    expect(line(out.f941, '1').value).toBe(1);
    // A week whose last day is the 12th still holds it; the day after does not.
    expect(line(q1([check('2026-03-06', '2026-03-13', { tech: 4 })]).f941, '1').value).toBe(1);
    expect(line(q1([check('2026-03-13', '2026-03-20', { tech: 4 })]).f941, '1').value).toBe(0);
    // Line 1 reads the third month only: a week that holds Jan 12 does not count.
    expect(line(q1([check('2026-01-12', '2026-01-23', { tech: 5 })]).f941, '1').value).toBe(0);
  });

  test('line 16 under $2,500 needs no schedule', () => {
    const out = build([check('2026-10-05', '2026-10-16', { tech: 1, federal_income_tax_cents: 10000 })]);
    expect(line(out.f941, '12').value).toBe(10000);
    expect(line(out.f941, '16').value).toMatch(/no schedule is needed/i);
    expect(line(out.f941, '16 month 1')).toBeUndefined();
  });

  test('line 16 at $2,500 or more lists the three months, and they total line 12', () => {
    const out = build([
      check('2026-09-28', '2026-10-09', { tech: 1, federal_income_tax_cents: 100000, social_security_cents: 6200, employer_social_security_cents: 6200 }),
      check('2026-10-26', '2026-11-06', { tech: 1, federal_income_tax_cents: 90000, medicare_cents: 1450, employer_medicare_cents: 1450 }),
      check('2026-11-23', '2026-12-04', { tech: 1, federal_income_tax_cents: 70000, additional_medicare_cents: 900 }),
    ]);
    const [m1, m2, m3] = ['16 month 1', '16 month 2', '16 month 3'].map((id) => line(out.f941, id).value);
    expect([m1, m2, m3]).toEqual([112400, 92900, 70900]);
    expect(m1 + m2 + m3).toBe(line(out.f941, '12').value);
    expect(line(out.f941, '16 total').value).toBe(276200);
    expect(out.f941.notes.join(' ')).not.toMatch(/rounding difference/);
  });

  test('any rounding difference goes into month 3', () => {
    expect(monthlyLiabilityLines(100000, [30000, 30000, 39999])).toEqual({ months: [30000, 30000, 40000], monthThreeAdjustment: 1 });
    expect(monthlyLiabilityLines(100000, [30000, 30000, 40000])).toEqual({ months: [30000, 30000, 40000], monthThreeAdjustment: 0 });
  });

  test('deposits recorded as paid reduce the balance; a surplus is an overpayment', () => {
    const rows = [check('2026-10-05', '2026-10-16', { tech: 1, federal_income_tax_cents: 30000 })];
    const owing = build(rows, { deposits941: [{ amount_paid: '100.00', amount_due: '300.00' }] });
    expect(line(owing.f941, '13').value).toBe(10000);
    expect(line(owing.f941, '14').value).toBe(20000);
    expect(line(owing.f941, '15').value).toBe(0);
    expect(line(owing.f941, '13').label).toMatch(/deposits recorded as paid on the Tax page/);
    const over = build(rows, { deposits941: [{ amount_paid: null, amount_due: '350.00' }] });
    expect(line(over.f941, '14').value).toBe(0);
    expect(line(over.f941, '15').value).toBe(5000);
  });
});

describe('Florida RT-6', () => {
  test('the $7,000 base crossed mid-quarter: wages over it are excess', () => {
    const out = build([
      check('2026-10-05', '2026-10-16', { tech: 1, gross_cents: 100000, ytd_gross_before_cents: 650000, fl_reemployment_cents: 1350 }),
      check('2026-10-12', '2026-10-23', { tech: 1, gross_cents: 100000, ytd_gross_before_cents: 750000, fl_reemployment_cents: 0 }),
    ]);
    expect(line(out.rt6, '2').value).toBe(200000);
    expect(line(out.rt6, '3').value).toBe(150000);
    expect(line(out.rt6, '4').value).toBe(50000);
    expect(line(out.rt6, '5').value).toBe(1350);
    expect(out.rt6.employees).toEqual([{ name: 'Sample Employee', grossCents: 200000, taxableCents: 50000, ssn: FROM_RECORDS }]);
  });

  test('line 5 is line 4 times the rate, rounded once (pre-push audit P1): three $100.10 checks owe $8.11, not $8.10', () => {
    const snapshot = { floridaReemploymentCents: 270, taxableWages: { floridaReemploymentCents: 10010 } };
    const out = build(['2026-10-05', '2026-10-12', '2026-10-19'].map((week, i) => check(week, `2026-10-${16 + 7 * i}`, {
      tech: 1, gross_cents: 10010, ytd_gross_before_cents: 10010 * i, fl_reemployment_cents: 270, calc_snapshot: JSON.stringify(snapshot),
    })));
    expect(line(out.rt6, '4').value).toBe(30030);
    expect(line(out.rt6, '5').value).toBe(811);
    expect(line(out.rt6, '5').note).toMatch(/The paychecks charged \$8\.10; the difference is per-paycheck rounding\./);
  });

  test('the rate is never rebuilt from a rounded tax (pre-push audit P1): three $25.25 checks at 2.7% owe $2.05', () => {
    // Each check stores $0.68; 68 / 2525 would read back as 2.69%.
    const out = build(['2026-10-05', '2026-10-12', '2026-10-19'].map((week, i) => check(week, `2026-10-${16 + 7 * i}`, {
      tech: 1, gross_cents: 2525, ytd_gross_before_cents: 2525 * i, fl_reemployment_cents: 68,
      calc_snapshot: JSON.stringify({ floridaReemploymentCents: 68, taxableWages: { floridaReemploymentCents: 2525 } }),
    })));
    expect(line(out.rt6, '5').rate).toBe('2.7%');
    expect(line(out.rt6, '5').value).toBe(205);
  });

  test('a rate stored with the check is the rate used', () => {
    const snapshot = { floridaReemploymentRateBp: 100, floridaReemploymentCents: 100, taxableWages: { floridaReemploymentCents: 10000 } };
    const out = build([check('2026-10-05', '2026-10-16', { tech: 1, gross_cents: 10000, fl_reemployment_cents: 100, calc_snapshot: JSON.stringify(snapshot) })]);
    expect(line(out.rt6, '5').rate).toBe('1.0%');
    expect(line(out.rt6, '5').value).toBe(100);
  });

  test('the rate is read back from the stored pay figures', () => {
    const snapshot = { floridaReemploymentCents: 270, taxableWages: { floridaReemploymentCents: 10000 } };
    const out = build([check('2026-10-05', '2026-10-16', { tech: 1, calc_snapshot: JSON.stringify(snapshot), fl_reemployment_cents: 270 })]);
    expect(line(out.rt6, '5').rate).toBe('2.7%');
  });

  test('covered employees are counted for each month by the 12th rule', () => {
    const out = buildFormFigures({
      year: 2026,
      quarter: 1,
      rows: [
        check('2026-01-12', '2026-01-23', { tech: 1 }), // holds Jan 12
        check('2026-02-09', '2026-02-20', { tech: 1 }), // holds Feb 12
        check('2026-02-09', '2026-02-20', { tech: 2 }),
        check('2026-03-02', '2026-03-13', { tech: 2 }), // misses Mar 12
      ],
    });
    expect(['1 month 1', '1 month 2', '1 month 3'].map((id) => line(out.rt6, id).value)).toEqual([1, 2, 0]);
  });
});

describe('Form 940', () => {
  const fourteen = (futa = 4200) => Array.from({ length: 14 }, (_v, i) => check(
    i < 7 ? '2026-02-02' : '2026-08-03', i < 7 ? '2026-02-13' : '2026-08-14',
    { tech: i + 1, gross_cents: 700000, futa_cents: i === 0 ? futa + 1 : futa },
  ));

  test('lines 3 to 8 and the $7,000 limit per employee across checks', () => {
    const out = build([
      check('2026-01-05', '2026-01-16', { tech: 1, gross_cents: 500000, ytd_gross_before_cents: 0 }),
      check('2026-06-01', '2026-06-12', { tech: 1, gross_cents: 400000, ytd_gross_before_cents: 500000 }),
      check('2026-06-01', '2026-06-12', { tech: 2, gross_cents: 300000 }),
    ], { rt6Paid: paidOnTime(1, 2) });
    expect(line(out.f940, '3').value).toBe(1200000);
    expect(line(out.f940, '5').value).toBe(200000); // 9,000 less 7,000 for tech 1
    expect(line(out.f940, '6').value).toBe(200000);
    expect(line(out.f940, '7').value).toBe(1000000);
    expect(line(out.f940, '8')).toMatchObject({ value: 6000, rate: '0.6%' });
    expect(line(out.f940, '11').value).toBe(0);
    expect(line(out.f940, '11').note).toMatch(/credit reduction list/);
    expect(line(out.f940, '12').value).toBe(6000);
  });

  test('line 13 reads paid 940 deposits; lines 14 and 15 follow', () => {
    const rows = [check('2026-01-05', '2026-01-16', { tech: 1, gross_cents: 700000 })];
    const out = build(rows, { deposits940: [{ amount_paid: '10.00' }], rt6Paid: paidOnTime(1) });
    expect(line(out.f940, '12').value).toBe(4200);
    expect(line(out.f940, '13').value).toBe(1000);
    expect(line(out.f940, '14').value).toBe(3200);
    expect(build(rows, { rt6Paid: paidOnTime(1) }).f940.rows.find((r) => r.line === '13').value).toBe(0);
  });

  test('Part 5 is left out when line 12 is $500 or less', () => {
    const out = build(fourteen().slice(0, 3), { rt6Paid: paidOnTime(1) });
    expect(line(out.f940, '12').value).toBe(12600);
    expect(line(out.f940, '16a')).toBeUndefined();
    expect(out.f940.notes.join(' ')).toMatch(/Part 5 is not needed/);
  });

  test('Part 5 appears over $500, by quarter, and line 17 equals line 12', () => {
    const out = build(fourteen(), { rt6Paid: paidOnTime(1, 3) });
    expect(line(out.f940, '12').value).toBe(58800);
    // The per-check rounding cent (-1) comes off the latest quarter WITH FUTA (Q3),
    // never a quarter with no FUTA wages: no quarter shows a negative liability.
    expect(['16a', '16b', '16c', '16d'].map((id) => line(out.f940, id).value)).toEqual([29401, 0, 29399, 0]);
    expect(line(out.f940, '17').value).toBe(58800);
    expect(out.f940.notes.join(' ')).toMatch(/the 1 cent difference comes off the latest quarters with FUTA, none below zero/);
  });

  test('missing cents larger than the last quarter come off earlier quarters, none below zero (pre-push audit P1)', () => {
    // 14 employees at $7,000 in Q1 whose checks stored 58,842 cents of FUTA, and
    // $10.00 in Q4 that stored 6 cents. Line 12 rounds $98,010.00 once: 58,806.
    const rows = [
      ...Array.from({ length: 14 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 1, gross_cents: 700000, futa_cents: 4203 })),
      check('2026-10-05', '2026-10-16', { tech: 30, gross_cents: 1000, futa_cents: 6 }),
    ];
    const out = build(rows, { rt6Paid: paidOnTime(1, 4) });
    expect(line(out.f940, '12').value).toBe(58806);
    // 42 missing cents: 6 from Q4 (to zero), the other 36 from Q1.
    expect(['16a', '16b', '16c', '16d'].map((id) => line(out.f940, id).value)).toEqual([58806, 0, 0, 0]);
    expect(line(out.f940, '17').value).toBe(58806);
  });

  test('extra cents go to the last quarter with FUTA', () => {
    const rows = Array.from({ length: 14 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 1, gross_cents: 700000, futa_cents: i === 0 ? 4199 : 4200 }));
    const out = build(rows, { rt6Paid: paidOnTime(1) });
    expect(['16a', '16b', '16c', '16d'].map((id) => line(out.f940, id).value)).toEqual([58800, 0, 0, 0]);
    expect(out.f940.notes.join(' ')).toMatch(/the 1 cent difference is added to the last quarter with FUTA/);
  });

  test('a line 12 of exactly $500.00 is not over $500', () => {
    // 500.00 / 0.6% = 83,333.33 taxable: 83,334 gives 500.004 -> 50000 cents.
    const out = build([check('2026-01-05', '2026-01-16', { tech: 1, gross_cents: 700000 }), ...Array.from({ length: 12 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 2, gross_cents: 700000 }))], { rt6Paid: paidOnTime(1) });
    expect(line(out.f940, '12').value).toBe(54600); // 13 employees at $7,000
    expect(line(out.f940, '16a')).toBeDefined();
    const edge = build([check('2026-01-05', '2026-01-16', { tech: 1, gross_cents: 700000 }), ...Array.from({ length: 10 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 2, gross_cents: 700000 })), check('2026-01-05', '2026-01-16', { tech: 20, gross_cents: 633334 })], { rt6Paid: paidOnTime(1) });
    expect(line(edge.f940, '12').value).toBe(50000);
    expect(line(edge.f940, '16a')).toBeUndefined();
  });
});

// Pre-push audit P1: line 10 was always 0, even with Florida tax unpaid or
// paid late, which cuts the FUTA credit (IRS Form 940 line 10 worksheet).
describe('Form 940 line 10: Florida tax paid on time', () => {
  // One employee per quarter at $7,000 (RT-6 line 5 at 2.7% = $189.00), and
  // the checks charged the same.
  const year = () => [1, 4, 7, 10].map((month, i) => check(`2026-${String(month).padStart(2, '0')}-05`, `2026-${String(month).padStart(2, '0')}-16`, {
    tech: i + 1, gross_cents: 700000, futa_cents: 4200, fl_reemployment_cents: 18900,
  }));
  const rt6 = (q, amount, paidDate, suffix = '') => ({ source_key: `payroll:rt6:2026-Q${q}${suffix}`, amount_paid: amount, paid_date: paidDate });
  const allPaid = (q4Date = '2027-01-20') => [rt6(1, '189.00', '2026-04-20'), rt6(2, '189.00', '2026-07-20'), rt6(3, '189.00', '2026-10-20'), rt6(4, '189.00', q4Date)];
  const needsCheck = (out, id) => expect(line(out.f940, id)).toMatchObject({ kind: 'text', value: 'Needs your check' });

  test('every quarter marked paid in full by the due date: line 10 is $0 and lines 12 to 17 are final', () => {
    const out = build(year(), { rt6Paid: allPaid() });
    expect(line(out.f940, '10')).toMatchObject({ kind: 'cents', value: 0 });
    expect(line(out.f940, '10').note).toMatch(/marked paid on the Tax page by 2027-02-01/);
    expect(line(out.f940, '12')).toMatchObject({ kind: 'cents', value: 16800 });
    expect(line(out.f940, '14')).toMatchObject({ kind: 'cents', value: 16800 });
  });

  test('a quarter not marked paid: lines 10, 12, 14 and 15 read "Needs your check" with no amount, and Part 5 waits', () => {
    const rows = [...year(), ...Array.from({ length: 10 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 10, gross_cents: 700000, futa_cents: 4200, fl_reemployment_cents: 18900 }))];
    const out = build(rows, { rt6Paid: allPaid().slice(0, 3) });
    expect(line(out.f940, '8').value).toBe(58800); // line 8 stays final
    for (const id of ['10', '12', '14', '15']) needsCheck(out, id);
    expect(line(out.f940, '10').note).toMatch(/Q4 is not marked paid in full \(RT-6 line 5\) on the Tax page by 2027-02-01/);
    expect(line(out.f940, '12').note).toBe('Depends on line 10.');
    expect(line(out.f940, '13')).toMatchObject({ kind: 'cents', value: 0 });
    expect(line(out.f940, '16a')).toBeUndefined();
    expect(line(out.f940, '17')).toBeUndefined();
    expect(out.f940.notes.join(' ')).toMatch(/Part 5 \(lines 16 and 17\) is needed because line 8 is more than \$500\. Fill it in after line 10 is checked/);
  });

  test('under $500 before line 10, Part 5 is left to decide after line 10', () => {
    const out = build(year(), { rt6Paid: [] });
    expect(line(out.f940, '10').note).toMatch(/Q1, Q2, Q3, Q4 is not marked paid/);
    expect(out.f940.notes.join(' ')).toMatch(/Part 5 is needed only if line 12 is more than \$500\. Decide after line 10 is checked/);
  });

  test('paid after the due date is late; the due date moves past a weekend (Jan 31, 2027 is a Sunday)', () => {
    expect(line(build(year(), { rt6Paid: allPaid('2027-02-01') }).f940, '10')).toMatchObject({ kind: 'cents', value: 0 });
    needsCheck(build(year(), { rt6Paid: allPaid('2027-02-02') }), '10');
    // A paid row with no paid date cannot show it was on time.
    needsCheck(build(year(), { rt6Paid: [...allPaid().slice(0, 3), rt6(4, '189.00', null)] }), '10');
  });

  test('a partial payment is not in full; a balance row paid on time completes it; a review row pays nothing', () => {
    const part = [...allPaid().slice(0, 3), rt6(4, '100.00', '2027-01-20')];
    needsCheck(build(year(), { rt6Paid: part }), '10');
    needsCheck(build(year(), { rt6Paid: [...part, rt6(4, '89.00', '2027-01-25', ':review:1')] }), '10');
    expect(line(build(year(), { rt6Paid: [...part, rt6(4, '89.00', '2027-01-25', ':balance:1')] }).f940, '10').value).toBe(0);
    // Another year's row does not pay this year.
    needsCheck(build(year(), { rt6Paid: [...allPaid().slice(0, 3), { source_key: 'payroll:rt6:2027-Q4', amount_paid: '189.00', paid_date: '2027-01-20' }] }), '10');
  });

  test('in full means all of RT-6 line 5 (pre-push audit P1): a cent short is not paid, even when the checks charged that much', () => {
    // Three $100.10 checks: RT-6 line 5 = $8.11 (rounded once), the checks charged $8.10.
    const rows = Array.from({ length: 3 }, (_v, i) => check('2026-01-05', '2026-01-16', { tech: i + 1, gross_cents: 10010, fl_reemployment_cents: 270 }));
    needsCheck(build(rows, { rt6Paid: [rt6(1, '8.10', '2026-04-20')] }), '10');
    expect(line(build(rows, { rt6Paid: [rt6(1, '8.11', '2026-04-20')] }).f940, '10').value).toBe(0);
    // Checks that stored no Florida tax still owe the RT-6 figure.
    const noStored = rows.map((r) => ({ ...r, fl_reemployment_cents: 0 }));
    needsCheck(build(noStored, { rt6Paid: [rt6(1, '8.10', '2026-04-20')] }), '10');
    expect(line(build(noStored, { rt6Paid: [rt6(1, '8.11', '2026-04-20')] }).f940, '10').value).toBe(0);
  });

  test('a year with no Florida tax needs no payment', () => {
    const out = build([]);
    expect(line(out.f940, '10')).toMatchObject({ kind: 'cents', value: 0 });
    expect(line(out.f940, '10').note).toBeUndefined();
  });
});

describe('W-2 and W-3', () => {
  test('one W-2 per employee with the box figures, the W-3 totals them', () => {
    const rows = [
      check('2026-01-05', '2026-01-16', { tech: 1, employee_name: 'Sample Alpha', gross_cents: 18400000, ytd_gross_before_cents: 0, federal_income_tax_cents: 2000000, social_security_cents: 1140800, medicare_cents: 266800, overtime_premium_cents: 5000 }),
      check('2026-06-01', '2026-06-12', { tech: 1, employee_name: 'Sample Alpha Renamed', gross_cents: 500000, ytd_gross_before_cents: 18400000, federal_income_tax_cents: 50000, social_security_cents: 5270, medicare_cents: 7250, additional_medicare_cents: 0 }),
      check('2026-06-01', '2026-06-12', { tech: 2, employee_name: 'Sample Beta', gross_cents: 300000, federal_income_tax_cents: 20000, social_security_cents: 18600, medicare_cents: 4350, additional_medicare_cents: 90 }),
    ];
    const out = build(rows, { addresses: new Map([['tech-2', '1 Example Way, Testville, FL 00000']]) });
    expect(out.w2.map((w) => w.name)).toEqual(['Sample Alpha Renamed', 'Sample Beta']);
    const alpha = out.w2[0];
    expect(alpha).toMatchObject({
      box1: 18900000, box2: 2050000, box3: 18450000, box4: 1146070, box5: 18900000, box6: 274050, box12TT: 5000, address: null, ssn: FROM_RECORDS,
    });
    expect(alpha.state).toMatch(/no state income tax/);
    const beta = out.w2[1];
    expect(beta).toMatchObject({ box6: 4440, box12TT: null, address: '1 Example Way, Testville, FL 00000' });
    // No box 12 TT total on the W-3 (IRS W-2/W-3 instructions): TT stays on each W-2.
    expect(out.w3).toEqual({
      boxC: 2, box1: 19200000, box2: 2070000, box3: 18750000, box4: 1164670, box5: 19200000, box6: 278490,
    });
    expect(out.employer.ein).toBe(FROM_RECORDS);
  });

  test('no SSN, EIN or bank number appears anywhere in the output', () => {
    const out = build([check('2026-10-05', '2026-10-16', { tech: 1 })]);
    expect(JSON.stringify(out)).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b|routing|account number/i);
  });
});

describe('parseFormPeriod', () => {
  test('accepts a year and a quarter', () => {
    expect(parseFormPeriod({ year: '2026', quarter: '3' })).toEqual({ year: 2026, quarter: 3 });
  });
  test.each([
    [{}], [{ year: '2026' }], [{ quarter: '2' }], [{ year: '26', quarter: '1' }], [{ year: '2026', quarter: '5' }],
    [{ year: '2026', quarter: '0' }], [{ year: '2019', quarter: '1' }], [{ year: ['2026', '2027'], quarter: '1' }], [{ year: '2026', quarter: '1.5' }],
  ])('rejects %j with a 400', (query) => {
    expect(() => parseFormPeriod(query)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
