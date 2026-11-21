// Pure tests (no database) for the extra overtime that bonus, commission,
// allowance and HSA pay lines cause (payroll-regular-rate.js), and for how
// computePaycheck carries pay lines (payroll-calc.js, GATE_PAYROLL_PAY_LINES).
// All names and figures are synthetic.
const { lineOvertimePremium, weeksOfLine } = require('../services/payroll-regular-rate');
const { computePaycheck } = require('../services/payroll-calc');

const W4 = { formYear: 2026, filingStatus: 'single', step2Checkbox: false, exempt: false };
const week = (weekStart, regularMinutes, overtimeMinutes = 0) => ({ weekStart, regularMinutes, overtimeMinutes });

describe('lineOvertimePremium', () => {
  it('works the page example: $23.00/h, 42 h (2 overtime), $30.00 bonus and $46.15 allowance in the week', () => {
    const result = lineOvertimePremium({
      weeks: [week('2026-10-12', '2400.00', '120.00')],
      lines: [
        { amountCents: 3000, weekStart: '2026-10-12' },
        { amountCents: 4615, weekStart: '2026-10-12' },
      ],
    });
    // 1/2 x ($76.15 / 42 h) x 2 h = $1.81
    expect(result.extraPremiumCents).toBe(181);
    expect(result.weeks).toEqual([
      { weekStart: '2026-10-12', workedMinutes: 2520, overtimeMinutes: 120, allocatedCents: 7615, premiumCents: 181 },
    ]);
  });

  it('through computePaycheck: regular rate $24.81, base premium $23.00, extra premium $1.81, code TT $24.81', () => {
    const { extraPremiumCents } = lineOvertimePremium({
      weeks: [week('2026-10-12', '2400.00', '120.00')],
      lines: [{ amountCents: 3000, weekStart: '2026-10-12' }, { amountCents: 4615, weekStart: '2026-10-12' }],
    });
    const pay = computePaycheck({
      payDate: '2026-10-23', hourlyRate: '23.00', regularMinutes: '2400.00', overtimeMinutes: '120.00', w4: W4,
      payLines: { reviewBonusCents: 3000, healthAllowanceCents: 4615, lineOvertimePremiumCents: extraPremiumCents },
      flsaCovered: true,
    });
    expect(pay.overtimePremiumCents).toBe(2300);
    expect(pay.lineOvertimePremiumCents).toBe(181);
    expect(pay.qualifiedOvertimeCents).toBe(2481);
    // Straight time for 42 h plus the lines, over 42 h, is the regular rate.
    const straightTime = 23 * 42 * 100 + 3000 + 4615;
    expect(Math.round(straightTime / 42)).toBe(2481);
    // Gross: 40 h x 23.00 + 2 h x 34.50 + lines + extra premium.
    expect(pay.grossPayCents).toBe(92000 + 6900 + 3000 + 4615 + 181);
  });

  it('spreads a late commission over 4 past weeks and pays a premium only for the 2 that had overtime', () => {
    const result = lineOvertimePremium({
      weeks: [
        week('2026-09-14', '2400.00', '0.00'), // 40 h, no overtime
        week('2026-09-21', '2400.00', '240.00'), // 44 h, 4 overtime
        week('2026-09-28', '2400.00', '60.00'), // 41 h, 1 overtime
        // 2026-10-05 has no approved timesheet: counts as no hours worked.
      ],
      lines: [{ amountCents: 40000, coversFrom: '2026-09-14', coversTo: '2026-10-11' }],
    });
    expect(result.weeks.map((w) => [w.weekStart, w.allocatedCents, w.premiumCents])).toEqual([
      ['2026-09-14', 10000, 0],
      ['2026-09-21', 10000, 455], // 1/2 x (100.00 / 44) x 4 = 4.545
      ['2026-09-28', 10000, 122], // 1/2 x (100.00 / 41) x 1 = 1.2195
      ['2026-10-05', 10000, 0],
    ]);
    expect(result.extraPremiumCents).toBe(577);
  });

  it('keeps overtime in the week it was worked: a Saturday week then a short week never average', () => {
    const weeks = [week('2026-09-14', '2400.00', '240.00'), week('2026-09-21', '2160.00', '0.00')]; // 44 h, then 36 h
    // A bonus earned in the short week gets nothing, although the two weeks together average 40 h.
    expect(lineOvertimePremium({ weeks, lines: [{ amountCents: 10000, weekStart: '2026-09-21' }] }).extraPremiumCents).toBe(0);
    // The same bonus earned in the long week gets the long week's overtime.
    expect(lineOvertimePremium({ weeks, lines: [{ amountCents: 10000, weekStart: '2026-09-14' }] }).extraPremiumCents).toBe(455);
  });

  it('does not depend on the base rate: a raise between weeks changes the base premium only', () => {
    const lineWeeks = { weeks: [week('2026-09-14', '2400.00', '240.00')], lines: [{ amountCents: 10000, weekStart: '2026-09-14' }] };
    const { extraPremiumCents } = lineOvertimePremium(lineWeeks);
    const before = computePaycheck({
      payDate: '2026-09-25', hourlyRate: '22.00', regularMinutes: '2400.00', overtimeMinutes: '240.00', w4: W4,
      payLines: { reviewBonusCents: 10000, lineOvertimePremiumCents: extraPremiumCents }, flsaCovered: true,
    });
    const after = computePaycheck({
      payDate: '2026-09-25', hourlyRate: '25.00', regularMinutes: '2400.00', overtimeMinutes: '240.00', w4: W4,
      payLines: { reviewBonusCents: 10000, lineOvertimePremiumCents: extraPremiumCents }, flsaCovered: true,
    });
    expect(before.lineOvertimePremiumCents).toBe(after.lineOvertimePremiumCents);
    expect(before.overtimePremiumCents).toBe(4400); // 4 h x 22.00 / 2 x ... = 1/2 x 22.00 x 4 h = 44.00
    expect(after.overtimePremiumCents).toBe(5000);
    expect(after.qualifiedOvertimeCents - before.qualifiedOvertimeCents).toBe(600);
  });

  it('adds exactly when two lines have different spans (no cent lost to the split)', () => {
    // 100 cents over 3 weeks is 33.33 a week. Over a common denominator the week sum is exact.
    const result = lineOvertimePremium({
      weeks: [week('2026-09-14', '2400.00', '2400.00')], // 80 h worked, 40 overtime: premium = 1/2 x share
      lines: [
        { amountCents: 100, coversFrom: '2026-09-14', coversTo: '2026-09-28' },
        { amountCents: 100, coversFrom: '2026-09-14', coversTo: '2026-09-20' },
      ],
    });
    // Week 1 holds 100/3 + 100 = 133.33 cents; 1/2 x (133.33 / 80 h) x 40 h = 33.33 -> 33.
    expect(result.weeks[0]).toMatchObject({ weekStart: '2026-09-14', allocatedCents: 133, premiumCents: 33 });
  });

  describe('a week paid on more than one check: each check pays the difference', () => {
    // 45 h worked, 5 of them overtime: premium = line pay x 5 / 90
    const WEEK = '2026-11-09';
    const hours = [week(WEEK, '2400.00', '300.00')];
    const line = (amountCents) => ({ amountCents, weekStart: WEEK });
    const price = (cents, earlierCents = [], paid = []) => lineOvertimePremium({
      weeks: hours, lines: cents.map(line), earlierLines: earlierCents.map(line), earlierPremiums: paid.map((premiumCents) => ({ weekStart: WEEK, premiumCents })),
    });

    it('prices a week with no earlier line pay exactly as before, and stores no earlier figures', () => {
      expect(price([600])).toEqual({
        extraPremiumCents: 33,
        weeks: [{ weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 600, premiumCents: 33 }],
      });
      // earlier pay for ANOTHER week changes nothing
      expect(lineOvertimePremium({
        weeks: hours, lines: [line(600)], earlierLines: [{ amountCents: 600, weekStart: '2026-11-02' }], earlierPremiums: [{ weekStart: '2026-11-02', premiumCents: 33 }],
      })).toEqual(price([600]));
    });

    it('pays 34 after an earlier check paid 33 for the same week: together 67, the premium on both lines', () => {
      // one check with both 6.00 lines: 1/2 x 12.00 / 45 h x 5 h = 66.67 -> 67
      expect(price([600, 600]).extraPremiumCents).toBe(67);
      const later = price([600], [600], [33]);
      expect(later.extraPremiumCents).toBe(34);
      expect(later.weeks).toEqual([{
        weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 600, premiumCents: 34, earlierAllocatedCents: 600, earlierPremiumCents: 33,
      }]);
    });

    it('does not depend on the order of the checks or on the rule an older check was priced by', () => {
      // two older checks each rounded their own line half up (33 + 33); the third check makes the week whole: 100 - 66
      expect(price([600], [600, 600], [33, 33]).extraPremiumCents).toBe(34);
      // the earlier premium arrives as one row or as several rows for the week: the same
      expect(price([600], [600, 600], [66]).extraPremiumCents).toBe(34);
      // an older check that paid more than its share: this check pays less, never under zero
      expect(price([600], [600], [40]).extraPremiumCents).toBe(27);
      expect(price([1], [600], [40]).extraPremiumCents).toBe(0);
      expect(price([1], [600], [40]).weeks[0]).toMatchObject({ premiumCents: 0, earlierAllocatedCents: 600, earlierPremiumCents: 40 });
    });

    it('adds up to the premium on the whole line pay after every check, for any amounts and hours (2,000 generated weeks)', () => {
      let seed = 20261121;
      const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % max); };
      for (let i = 0; i < 2000; i += 1) {
        const amounts = Array.from({ length: 1 + next(4) }, () => next(50000));
        const weeks = [week(WEEK, '2400.00', `${next(1500)}.00`)];
        const whole = (cents) => lineOvertimePremium({ weeks, lines: cents.map(line) }).extraPremiumCents;
        let paidSoFar = 0;
        amounts.forEach((cents, n) => {
          paidSoFar += lineOvertimePremium({
            weeks, lines: [line(cents)], earlierLines: amounts.slice(0, n).map(line), earlierPremiums: n ? [{ weekStart: WEEK, premiumCents: paidSoFar }] : [],
          }).extraPremiumCents;
          // after each check: exactly what one check with every line so far would pay
          expect([i, n, paidSoFar]).toEqual([i, n, whole(amounts.slice(0, n + 1))]);
        });
      }
    });

    it('trues up each week of a span against the earlier lines that cover that week only', () => {
      // a 12.00 line over 2 weeks (6.00 a week) after a 6.00 line that an earlier check paid in the first week only
      const weeks = [week('2026-11-09', '2400.00', '300.00'), week('2026-11-16', '2400.00', '300.00')];
      const result = lineOvertimePremium({
        weeks,
        lines: [{ amountCents: 1200, coversFrom: '2026-11-09', coversTo: '2026-11-22' }],
        earlierLines: [{ amountCents: 600, weekStart: '2026-11-09' }, { amountCents: 99999, weekStart: '2026-10-05' }],
        earlierPremiums: [{ weekStart: '2026-11-09', premiumCents: 33 }, { weekStart: '2026-10-05', premiumCents: 500 }],
      });
      expect(result.weeks.map((w) => [w.weekStart, w.premiumCents, w.earlierPremiumCents])).toEqual([
        ['2026-11-09', 34, 33], // 67 on the week's 12.00, less 33
        ['2026-11-16', 33, undefined], // no earlier pay: 33.33 -> 33
      ]);
      expect(result.extraPremiumCents).toBe(67);
    });

    it('refuses an earlier premium that is not a whole number of cents, zero or more', () => {
      expect(() => price([600], [600], [-1])).toThrow(/whole number of cents/);
      expect(() => price([600], [600], [1.5])).toThrow(/whole number of cents/);
    });
  });

  it('counts an HSA line like any other line (a cash-or-HSA choice is in the regular rate)', () => {
    const base = { weeks: [week('2026-10-12', '2400.00', '120.00')] };
    const without = lineOvertimePremium({ ...base, lines: [{ amountCents: 4615, weekStart: '2026-10-12' }] });
    const withHsa = lineOvertimePremium({ ...base, lines: [{ amountCents: 4615, weekStart: '2026-10-12' }, { amountCents: 20000, weekStart: '2026-10-12' }] });
    expect(without.extraPremiumCents).toBe(110);
    expect(withHsa.extraPremiumCents).toBe(Math.round((24615 * 120) / (2 * 2520)));
  });

  it('lists the weeks of a span, Monday to Monday', () => {
    expect(weeksOfLine({ coversFrom: '2026-10-01', coversTo: '2026-10-31' })).toEqual([
      '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26',
    ]);
    expect(weeksOfLine({ weekStart: '2026-10-12' })).toEqual(['2026-10-12']);
  });

  it('returns nothing for no lines and refuses a bad line or a bad span', () => {
    expect(lineOvertimePremium({ weeks: [week('2026-10-12', '2400.00', '120.00')], lines: [] })).toEqual({ extraPremiumCents: 0, weeks: [] });
    expect(() => lineOvertimePremium({ lines: [{ amountCents: 0, weekStart: '2026-10-12' }] })).toThrow(/positive whole number of cents/);
    expect(() => lineOvertimePremium({ lines: [{ amountCents: 10.5, weekStart: '2026-10-12' }] })).toThrow(/whole number of cents/);
    expect(() => lineOvertimePremium({ lines: [{ amountCents: 100, coversFrom: '2026-10-12' }] })).toThrow(/both dates/);
    expect(() => lineOvertimePremium({ lines: [{ amountCents: 100, coversFrom: '2026-10-19', coversTo: '2026-10-12' }] })).toThrow(/both dates/);
    expect(() => lineOvertimePremium({ weeks: [week('2026-10-12', '-5', '0')], lines: [{ amountCents: 100, weekStart: '2026-10-12' }] })).toThrow(/Regular minutes/);
  });
});

describe('computePaycheck with pay lines', () => {
  const NEW_KEYS = [
    'reviewBonusCents', 'commissionCents', 'healthAllowanceCents', 'lineOvertimePremiumCents',
    'incomeTaxWagesCents', 'simpleCompensationCents', 'qualifiedOvertimeCents', 'hsaEmployerCents',
  ];
  const input = { payDate: '2026-10-23', hourlyRate: '22.00', regularMinutes: '2400.00', overtimeMinutes: '0.00', w4: W4 };

  it('adds no key and changes no figure without payLines (gate off)', () => {
    const plain = computePaycheck(input);
    for (const key of NEW_KEYS) expect(plain).not.toHaveProperty(key);
    expect(computePaycheck({ ...input, payLines: undefined, flsaCovered: true })).toEqual(plain);
    expect(plain.grossPayCents).toBe(88000);
  });

  it('adds bonus, commission, allowance and the line overtime to gross and every tax base', () => {
    const plain = computePaycheck(input);
    const pay = computePaycheck({
      ...input,
      payLines: { reviewBonusCents: 5000, commissionCents: 20000, healthAllowanceCents: 20000, lineOvertimePremiumCents: 0 },
    });
    expect(pay.grossPayCents).toBe(88000 + 45000);
    expect(pay.incomeTaxWagesCents).toBe(133000);
    expect(pay.simpleCompensationCents).toBe(133000);
    expect(pay.taxableWages).toMatchObject({ socialSecurityCents: 133000, medicareCents: 133000, futaCents: 133000 });
    expect(pay.socialSecurityEmployeeCents).toBe(8246); // 6.2% of 1330.00
    expect(pay.medicareEmployeeCents).toBe(1929); // 1.45% of 1330.00, half up
    expect(pay.federalIncomeTaxCents).toBeGreaterThan(plain.federalIncomeTaxCents);
    expect(pay.netPayCents).toBe(pay.grossPayCents - pay.federalIncomeTaxCents - pay.socialSecurityEmployeeCents - pay.medicareEmployeeCents - pay.additionalMedicareCents);
  });

  it('keeps the employer HSA money out of gross, every tax base and net pay, and reports it for code W', () => {
    const plain = computePaycheck(input);
    const pay = computePaycheck({ ...input, payLines: { hsaEmployerCents: 20000 } });
    expect(pay.hsaEmployerCents).toBe(20000);
    for (const key of ['grossPayCents', 'federalIncomeTaxCents', 'socialSecurityEmployeeCents', 'medicareEmployeeCents', 'netPayCents', 'futaCents', 'floridaReemploymentCents']) {
      expect(pay[key]).toBe(plain[key]);
    }
    expect(pay.taxableWages).toEqual(plain.taxableWages);
    expect(pay.incomeTaxWagesCents).toBe(plain.grossPayCents);
    expect(pay.simpleCompensationCents).toBe(plain.grossPayCents);
  });

  it('fills qualified overtime only for an employee the overtime law covers', () => {
    const lines = { reviewBonusCents: 3000, lineOvertimePremiumCents: 181 };
    const overtime = { regularMinutes: '2400.00', overtimeMinutes: '120.00' };
    expect(computePaycheck({ ...input, ...overtime, payLines: lines, flsaCovered: true }).qualifiedOvertimeCents).toBe(2381);
    expect(computePaycheck({ ...input, ...overtime, payLines: lines, flsaCovered: false }).qualifiedOvertimeCents).toBe(0);
    expect(computePaycheck({ ...input, ...overtime, payLines: lines }).qualifiedOvertimeCents).toBe(0);
    expect(computePaycheck({ ...input, ...overtime, payLines: lines, flsaCovered: null }).qualifiedOvertimeCents).toBe(0);
    // Gross still pays the line overtime whatever the coverage setting says.
    expect(computePaycheck({ ...input, ...overtime, payLines: lines }).grossPayCents)
      .toBe(computePaycheck({ ...input, ...overtime, payLines: lines, flsaCovered: true }).grossPayCents);
  });

  it('pays a lines-only check after the technician left, taxed as wages, no premium without spread-week overtime', () => {
    const pay = computePaycheck({
      payDate: '2026-10-23', hourlyRate: '22.00', regularMinutes: 0, overtimeMinutes: 0, w4: W4,
      payLines: { commissionCents: 50000, lineOvertimePremiumCents: 0 }, flsaCovered: true,
    });
    expect(pay.grossPayCents).toBe(50000);
    expect(pay.regularPayCents).toBe(0);
    expect(pay.overtimePremiumCents).toBe(0);
    expect(pay.qualifiedOvertimeCents).toBe(0);
    expect(pay.socialSecurityEmployeeCents).toBe(3100);
    expect(pay.medicareEmployeeCents).toBe(725);
    // A spread week that had overtime brings its premium onto the lines-only check.
    const withPremium = computePaycheck({
      payDate: '2026-10-23', hourlyRate: '22.00', regularMinutes: 0, overtimeMinutes: 0, w4: W4,
      payLines: { commissionCents: 50000, lineOvertimePremiumCents: 577 }, flsaCovered: true,
    });
    expect(withPremium.grossPayCents).toBe(50577);
    expect(withPremium.qualifiedOvertimeCents).toBe(577);
  });

  it('refuses a pay line that is not a whole number of cents', () => {
    expect(() => computePaycheck({ ...input, payLines: { reviewBonusCents: 10.5 } })).toThrow(/whole number of cents/);
    expect(() => computePaycheck({ ...input, payLines: { commissionCents: -1 } })).toThrow(/whole number of cents/);
    expect(() => computePaycheck({ ...input, payLines: { hsaEmployerCents: '200' } })).toThrow(/whole number of cents/);
  });
});
