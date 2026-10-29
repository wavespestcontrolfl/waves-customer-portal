const { computePaycheck, TAX_YEARS } = require('../services/payroll-calc');

const W4_SINGLE = { formYear: 2026, filingStatus: 'single', step2Checkbox: false };
const FULL_WEEK = { payDate: '2026-06-05', hourlyRate: '23.00', regularMinutes: '2400.00' };

function paycheck(overrides = {}) {
  return computePaycheck({ ...FULL_WEEK, w4: W4_SINGLE, ...overrides });
}

describe('computePaycheck: federal income tax', () => {
  // IRS Pub. 15-T (2026), WEEKLY wage bracket table for 2020-or-later W-4s,
  // read at the middle of each $10 row. The table rounds to whole dollars, so
  // the percentage method may differ by up to 50 cents.
  // Columns: MFJ standard, MFJ checkbox, HOH standard, HOH checkbox,
  // single standard, single checkbox.
  const BRACKET_ROWS = [
    [480, [0, 17, 2, 26, 17, 37]],
    [600, [0, 30, 14, 41, 30, 51]],
    [770, [15, 50, 31, 61, 50, 84]],
    [920, [30, 68, 48, 83, 68, 117]],
    [1050, [43, 84, 63, 112, 84, 146]],
    [1500, [96, 160, 117, 216, 160, 252]],
  ];
  const COLUMNS = [
    ['married_jointly', false], ['married_jointly', true],
    ['head_of_household', false], ['head_of_household', true],
    ['single', false], ['single', true],
  ];
  const cases = BRACKET_ROWS.flatMap(([wage, dollars]) => COLUMNS.map(([status, checkbox], i) => (
    [wage, status, checkbox, dollars[i]]
  )));

  test.each(cases)('$%i weekly, %s, Step 2 box %s → about $%i', (wage, status, checkbox, dollars) => {
    const result = paycheck({
      hourlyRate: String(wage / 40),
      w4: { formYear: 2026, filingStatus: status, step2Checkbox: checkbox },
    });
    expect(result.grossPayCents).toBe(wage * 100);
    expect(Math.abs(result.federalIncomeTaxCents - dollars * 100)).toBeLessThanOrEqual(50);
  });

  test('every 2026 schedule row continues the row before it (catches a mistyped table cell)', () => {
    // Column C of a row equals the previous row's C plus the previous rate on
    // the band. Two Step 2 checkbox thresholds are rounded halves in the IRS
    // table, so allow under a dollar.
    const { standard, step2Checkbox } = TAX_YEARS[2026];
    for (const schedules of [standard, step2Checkbox]) {
      for (const rows of Object.values(schedules)) {
        for (let i = 1; i < rows.length; i += 1) {
          const [prevAtLeast, prevTentative, prevPercent] = rows[i - 1];
          const [atLeast, tentative] = rows[i];
          const expected = prevTentative + ((atLeast - prevAtLeast) * prevPercent) / 100;
          expect(Math.abs(tentative - expected)).toBeLessThan(1);
        }
      }
    }
  });

  test('a single filer at 40 hours and $23 follows Worksheet 1A line by line', () => {
    const { federalIncomeTaxCents, withholdingWorksheet: w } = paycheck();
    expect(w.line1c).toBe(4784000); // $920 x 52
    expect(w.line1g).toBe(860000); // Step 2 box not checked, not MFJ
    expect(w.line1i).toBe(3924000);
    expect(w.line2h).toBe(6848); // ($1,240 + 12% of $19,340) / 52
    expect(federalIncomeTaxCents).toBe(6848);
  });

  test('Step 3 credits reduce it, never below zero, and Step 4(c) adds on top', () => {
    expect(paycheck({ w4: { ...W4_SINGLE, step3Amount: '2000' } }).federalIncomeTaxCents).toBe(3002);
    expect(paycheck({ w4: { ...W4_SINGLE, step3Amount: '2000', step4cExtraWithholding: '10' } })
      .federalIncomeTaxCents).toBe(4002);
    expect(paycheck({ w4: { ...W4_SINGLE, step3Amount: '5000' } }).federalIncomeTaxCents).toBe(0);
  });

  test('Step 4(a) other income raises it and Step 4(b) deductions lower it', () => {
    expect(paycheck({ w4: { ...W4_SINGLE, step4aOtherIncome: '5200' } }).federalIncomeTaxCents).toBe(8048);
    expect(paycheck({ w4: { ...W4_SINGLE, step4bDeductions: '5200' } }).federalIncomeTaxCents).toBe(5648);
  });

  test('married filing separately uses the single schedule', () => {
    expect(paycheck({ w4: { ...W4_SINGLE, filingStatus: 'married_separately' } }).federalIncomeTaxCents)
      .toBe(paycheck().federalIncomeTaxCents);
  });

  test('an exempt W-4 withholds no income tax but still owes Social Security and Medicare', () => {
    const result = paycheck({ w4: { ...W4_SINGLE, exempt: true } });
    expect(result.federalIncomeTaxCents).toBe(0);
    expect(result.socialSecurityEmployeeCents).toBe(5704);
    expect(result.medicareEmployeeCents).toBe(1334);
  });

  test('a check too small for its Step 4(c) extra withholds only what it covers', () => {
    const result = paycheck({ regularMinutes: '60', w4: { ...W4_SINGLE, step4cExtraWithholding: '50' } });
    expect(result.grossPayCents).toBe(2300);
    expect(result.federalIncomeTaxCents).toBe(2300 - 143 - 33);
    expect(result.federalIncomeTaxShortfallCents).toBe(5000 - (2300 - 143 - 33));
    expect(result.netPayCents).toBe(0);
  });
});

describe('computePaycheck: pay and payroll taxes', () => {
  test('a 40-hour week at $23 for a single filer, first paycheck of the year', () => {
    expect(paycheck()).toMatchObject({
      taxYear: 2026,
      payPeriodsPerYear: 52,
      grossPayCents: 92000,
      federalIncomeTaxCents: 6848,
      socialSecurityEmployeeCents: 5704,
      medicareEmployeeCents: 1334,
      additionalMedicareCents: 0,
      netPayCents: 78114,
      socialSecurityEmployerCents: 5704,
      medicareEmployerCents: 1334,
      futaCents: 552,
      floridaReemploymentCents: 2484,
    });
  });

  test('overtime pays time and a half and reports the extra half on its own', () => {
    const result = paycheck({ overtimeMinutes: '120.00' });
    expect(result.regularPayCents).toBe(92000);
    expect(result.overtimePayCents).toBe(6900);
    expect(result.overtimePremiumCents).toBe(2300);
    expect(result.grossPayCents).toBe(98900);
  });

  test('fractional minutes and cents round half up', () => {
    // $23.33 x 37 minutes = $14.3868...
    expect(paycheck({ hourlyRate: '23.33', regularMinutes: '37' }).grossPayCents).toBe(1439);
  });

  test('Social Security stops at the 2026 wage base inside the paycheck that crosses it', () => {
    const result = paycheck({ ytdGrossWages: '184000.00' });
    expect(result.taxableWages.socialSecurityCents).toBe(50000);
    expect(result.socialSecurityEmployeeCents).toBe(3100);
    expect(result.socialSecurityEmployerCents).toBe(3100);
    expect(result.medicareEmployeeCents).toBe(1334);
  });

  test('Additional Medicare applies only to wages over $200,000 for the year', () => {
    expect(paycheck({ ytdGrossWages: '199500.00' }).additionalMedicareCents).toBe(378);
    expect(paycheck({ ytdGrossWages: '250000.00' }).additionalMedicareCents).toBe(828);
  });

  test('FUTA and Florida reemployment tax stop at $7,000 of wages for the year', () => {
    const crossing = paycheck({ ytdGrossWages: '6500.00' });
    expect(crossing.taxableWages.futaCents).toBe(50000);
    expect(crossing.futaCents).toBe(300);
    expect(crossing.floridaReemploymentCents).toBe(1350);
    const past = paycheck({ ytdGrossWages: '7000.00' });
    expect(past.futaCents).toBe(0);
    expect(past.floridaReemploymentCents).toBe(0);
  });

  test('uses the Florida rate assigned to Waves when it is not the new-employer 2.7%', () => {
    expect(paycheck({ reemploymentRateBp: 100 }).floridaReemploymentCents).toBe(920);
  });

  test('returns the Florida rate it used, so the RT-6 figures never rebuild it from a rounded tax', () => {
    expect(paycheck().floridaReemploymentRateBp).toBe(270);
    expect(paycheck({ reemploymentRateBp: 100 }).floridaReemploymentRateBp).toBe(100);
  });
});

describe('computePaycheck: refuses to guess', () => {
  test.each([
    ['a pay date in a year without tables', { payDate: '2027-01-08' }, /No federal withholding tables for 2027/],
    ['an impossible pay date', { payDate: '2026-02-30' }, /real YYYY-MM-DD/],
    ['no pay rate', { hourlyRate: null }, /No pay rate set/],
    ['no W-4', { w4: null }, /No Form W-4 on file/],
    ['a 2019 W-4', { w4: { ...W4_SINGLE, formYear: 2019 } }, /2020 or later/],
    ['an unknown filing status', { w4: { ...W4_SINGLE, filingStatus: 'widowed' } }, /Unknown W-4 filing status/],
    ['negative minutes', { regularMinutes: '-5' }, /Regular minutes must be a non-negative number/],
    ['mistyped minutes', { regularMinutes: 'oops' }, /Regular minutes must be a non-negative number/],
    ['a mistyped rate', { hourlyRate: 'abc' }, /Hourly rate must be a non-negative number/],
    ['year-to-date wages that are not a number', { ytdGrossWages: Number.NaN }, /Year-to-date wages must be/],
    ['an infinite Step 4(c) amount', { w4: { ...W4_SINGLE, step4cExtraWithholding: Infinity } }, /W-4 Step 4\(c\) must be/],
    ['an unknown pay frequency', { payFrequency: 'daily' }, /Unknown pay frequency/],
  ])('%s', (_label, overrides, message) => {
    expect(() => paycheck(overrides)).toThrow(message);
  });
});

describe('computePaycheck: paid time off and holidays (GATE_PAYROLL_TIME_OFF)', () => {
  // 10 hours of paid time off at $21.00 and 8 hours of holiday: hours not worked,
  // paid at the straight rate. Minutes arrive like regularMinutes.
  const OFF = { hourlyRate: '21.00', regularMinutes: '1800.00' };

  test('pays time off and holiday at the straight rate and sums all four into gross', () => {
    const result = paycheck({ ...OFF, overtimeMinutes: '120.00', ptoMinutes: '600.00', holidayMinutes: '480.00' });
    expect(result.regularPayCents).toBe(63000);
    expect(result.overtimePayCents).toBe(6300);
    expect(result.ptoPayCents).toBe(21000);
    expect(result.holidayPayCents).toBe(16800);
    expect(result.grossPayCents).toBe(63000 + 6300 + 21000 + 16800);
  });

  test('time off never counts toward overtime: 40 h worked plus a 10 h holiday has no overtime pay', () => {
    const result = paycheck({ hourlyRate: '22.00', regularMinutes: '2400.00', overtimeMinutes: '0.00', holidayMinutes: '600.00' });
    expect(result.overtimePayCents).toBe(0);
    expect(result.overtimePremiumCents).toBe(0);
    expect(result.holidayPayCents).toBe(22000);
    expect(result.grossPayCents).toBe(88000 + 22000);
  });

  test('a week of time off alone is a paycheck', () => {
    const result = paycheck({ hourlyRate: '21.00', regularMinutes: '0.00', ptoMinutes: '2400.00' });
    expect(result.grossPayCents).toBe(84000);
    expect(result.ptoPayCents).toBe(84000);
  });

  test('rounds each line half-up to the cent like regular pay', () => {
    // 0.01 h (0.6 min = 60 hundredths) at $21.00 is 0.21 cents; 2.5 min at $21.00 is 87.5 cents.
    const result = paycheck({ hourlyRate: '21.00', regularMinutes: '0', ptoMinutes: '2.50', holidayMinutes: '0.60' });
    expect(result.ptoPayCents).toBe(88);
    expect(result.holidayPayCents).toBe(21);
  });

  test('taxes and withholding run on the full gross', () => {
    const withOff = paycheck({ ...OFF, ptoMinutes: '600.00', holidayMinutes: '480.00' });
    const asWorked = paycheck({ hourlyRate: '21.00', regularMinutes: '2880.00' });
    expect(withOff.grossPayCents).toBe(asWorked.grossPayCents);
    for (const key of ['federalIncomeTaxCents', 'socialSecurityEmployeeCents', 'medicareEmployeeCents', 'netPayCents', 'futaCents', 'floridaReemploymentCents']) {
      expect(withOff[key]).toBe(asWorked[key]);
    }
    expect(withOff.taxableWages).toEqual(asWorked.taxableWages);
    expect(withOff.withholdingWorksheet).toEqual(asWorked.withholdingWorksheet);
  });

  test('the $7,000 FUTA and RT-6 cap counts time off pay in the check', () => {
    // $6,800 paid: only $200 of this $840 check (all time off) is under the $7,000 base.
    const result = paycheck({ hourlyRate: '21.00', regularMinutes: '0.00', ptoMinutes: '2400.00', ytdGrossWages: '6800.00' });
    expect(result.taxableWages.futaCents).toBe(20000);
    expect(result.futaCents).toBe(120);
    expect(result.floridaReemploymentCents).toBe(540);
  });

  test('output is identical when neither figure is passed, and carries no time-off keys', () => {
    const plain = paycheck();
    expect(plain).not.toHaveProperty('ptoPayCents');
    expect(plain).not.toHaveProperty('holidayPayCents');
    expect(JSON.stringify(paycheck({ regularMinutes: '2400.00', overtimeMinutes: '0.00' }))).toBe(JSON.stringify(plain));
    // Passing zero is a caller that opted in: same numbers, two extra keys.
    const zero = paycheck({ ptoMinutes: 0, holidayMinutes: 0 });
    const { ptoPayCents, holidayPayCents, ...rest } = zero;
    expect([ptoPayCents, holidayPayCents]).toEqual([0, 0]);
    expect(rest).toEqual(plain);
  });

  test('a mistyped figure is refused, never read as zero', () => {
    expect(() => paycheck({ ptoMinutes: '-5' })).toThrow(/Paid time off minutes/);
    expect(() => paycheck({ holidayMinutes: 'abc' })).toThrow(/Holiday minutes/);
  });
});

describe('computePaycheck: family employee (GATE_PAYROLL_FAMILY_EMPLOYEE)', () => {
  const stripExempt = ({ unemploymentExempt, ...rest }) => rest;

  test('an exempt check owes no FUTA or Florida tax and counts no unemployment wages; every other figure is unchanged', () => {
    const normal = paycheck({ ytdGrossWages: '1200.00' });
    const exempt = paycheck({ ytdGrossWages: '1200.00', unemploymentExempt: true });
    expect(exempt.unemploymentExempt).toBe(true);
    expect(exempt.futaCents).toBe(0);
    expect(exempt.floridaReemploymentCents).toBe(0);
    expect(exempt.taxableWages.futaCents).toBe(0);
    expect(exempt.taxableWages.floridaReemploymentCents).toBe(0);
    expect(normal.futaCents).toBeGreaterThan(0);
    // Everything but the two taxes and the two taxable wage lines equals the same check not exempt.
    const without = (check) => {
      const copy = { ...stripExempt(check), taxableWages: { ...check.taxableWages, futaCents: 0, floridaReemploymentCents: 0 } };
      copy.futaCents = 0;
      copy.floridaReemploymentCents = 0;
      return copy;
    };
    expect(without(exempt)).toEqual(without(normal));
  });

  test('exempt pay never uses up the $7,000 base: exempt pay earlier leaves the full base', () => {
    // ytdGrossWages (Social Security, Medicare) counts the earlier pay; ytdUnemploymentWages (the base) does not.
    const later = paycheck({ ytdGrossWages: '6500.00', ytdUnemploymentWages: '0.00', unemploymentExempt: false });
    expect(later.taxableWages.futaCents).toBe(92000);
    expect(later.futaCents).toBe(552);
    expect(later.floridaReemploymentCents).toBe(2484);
    // Without the new year-to-date the base is figured from all wages, as it always was.
    expect(paycheck({ ytdGrossWages: '6500.00', unemploymentExempt: false }).taxableWages.futaCents).toBe(50000);
    // Social Security still follows the gross year to date.
    expect(later.socialSecurityEmployeeCents).toBe(paycheck({ ytdGrossWages: '6500.00' }).socialSecurityEmployeeCents);
  });

  test('passing false changes nothing but the extra key; omitting both is byte for byte today', () => {
    const plain = paycheck({ ytdGrossWages: '6500.00' });
    expect(plain).not.toHaveProperty('unemploymentExempt');
    expect(JSON.stringify(paycheck({ ytdGrossWages: '6500.00', unemploymentExempt: undefined, ytdUnemploymentWages: undefined }))).toBe(JSON.stringify(plain));
    const off = paycheck({ ytdGrossWages: '6500.00', unemploymentExempt: false });
    expect(off.unemploymentExempt).toBe(false);
    expect(stripExempt(off)).toEqual(plain);
  });

  test('a mistyped year-to-date figure is refused', () => {
    expect(() => paycheck({ unemploymentExempt: false, ytdUnemploymentWages: '-1' })).toThrow(/Year-to-date unemployment wages/);
  });
});
