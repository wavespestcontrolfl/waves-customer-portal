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

  describe('a week paid on more than one check: a check pays its own floor or the week\'s shortfall, whichever is larger', () => {
    // 45 h worked, 5 of them overtime: premium = line pay x 5 / 90
    const WEEK = '2026-11-09';
    const hours = [week(WEEK, '2400.00', '300.00')];
    const line = (amountCents) => ({ amountCents, weekStart: WEEK });
    const paidRows = (list) => list.map((premiumCents) => ({ weekStart: WEEK, premiumCents }));
    // the first check to pay line pay for the week
    const first = (cents) => lineOvertimePremium({ weeks: hours, lines: [].concat(cents).map(line) });
    // a check after finalized checks paid `earlierCents` of line pay and stored `paid` of premium for the week
    const later = (cents, earlierCents, paid) => lineOvertimePremium({
      weeks: hours, lines: [].concat(cents).map(line), earlierLines: earlierCents.map(line), earlierPremiums: paidRows(paid),
    });

    it('prices a week nobody paid for yet exactly as before, and marks nothing', () => {
      expect(first(600)).toEqual({
        extraPremiumCents: 33,
        weeks: [{ weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 600, premiumCents: 33 }],
      });
      // earlier line pay and premium of ANOTHER week change nothing
      expect(lineOvertimePremium({
        weeks: hours, lines: [line(600)], earlierLines: [{ amountCents: 600, weekStart: '2026-11-02' }], earlierPremiums: [{ weekStart: '2026-11-02', premiumCents: 33 }],
      })).toEqual(first(600));
    });

    it('two checks for one week: 33 then 34, the 67 of one check with both lines, and the row says how it was priced', () => {
      expect(first([600, 600]).extraPremiumCents).toBe(67); // 66.67
      expect(later(600, [600], [33])).toEqual({
        extraPremiumCents: 34, // floor 33.33 up = 34; shortfall 67 - 33 = 34
        weeks: [{
          weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 600, premiumCents: 34, earlierAllocatedCents: 600, earlierPremiumCents: 33,
        }],
      });
      expect(later(900, [900], [50]).extraPremiumCents).toBe(50); // a whole cent never moves
      // no overtime in the week: nothing, whatever was paid before
      expect(lineOvertimePremium({ weeks: [week(WEEK, '2400.00', '0.00')], lines: [line(600)], earlierLines: [line(600)] }).extraPremiumCents).toBe(0);
    });

    it('THE FLOOR: a later check never pays less than its own lines earn, rounded up, whatever another check paid', () => {
      // two 6.03 lines earn 33.5 each, 67 together. The first check paid 34, so the shortfall is 33. The later check still pays
      // 34: with the first check voided and its line gone, 34 is what the later check's line earns alone.
      expect(first(603).extraPremiumCents).toBe(34);
      expect(later(603, [603], [34]).extraPremiumCents).toBe(34);
      // an older check paid more than its part: this check still pays its floor
      expect(later(600, [600], [40]).extraPremiumCents).toBe(34);
      expect(later(1, [600], [40]).weeks[0]).toMatchObject({ premiumCents: 1, earlierAllocatedCents: 600, earlierPremiumCents: 40 });
      for (const cents of [1, 59, 600, 603, 609, 12345, 30000]) {
        const alone = first(cents).extraPremiumCents;
        const after = later(cents, [cents], [alone]).extraPremiumCents;
        expect([cents, after >= alone, after - alone <= 1]).toEqual([cents, true, true]);
      }
    });

    it('THE SHORTFALL: checks priced before this rule can be short together, and the next check makes the week whole', () => {
      // two older checks each paid a 6.02 line and rounded half up on its own: 33.44 -> 33, twice. Together they earn 66.89 -> 67.
      expect([first(602).extraPremiumCents, first([602, 602]).extraPremiumCents]).toEqual([33, 67]);
      // a 12.00 share of the same week (a 300.00 gift over 25 weeks): all three lines earn 133.56 -> 134, and 66 is paid
      const gift = later(1200, [602, 602], [33, 33]);
      expect(gift.weeks).toEqual([{
        weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 1200, premiumCents: 68, earlierAllocatedCents: 1204, earlierPremiumCents: 66,
      }]);
      expect(33 + 33 + gift.extraPremiumCents).toBe(first([602, 602, 1200]).extraPremiumCents); // 134, not 133
      // the earlier premium as one row or as several rows for the week: the same
      expect(later(1200, [602, 602], [66]).extraPremiumCents).toBe(68);
      // an older check that stored no premium for its line: this check pays for both
      expect(later(600, [600], []).extraPremiumCents).toBe(67);
    });

    it('checks priced by this rule never pay less than one check with every line, also after any one of them is voided (2,000 generated weeks)', () => {
      let seed = 20261121;
      const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % max); };
      const sum = (list) => list.reduce((total, cents) => total + cents, 0);
      for (let i = 0; i < 2000; i += 1) {
        const amounts = Array.from({ length: 1 + next(4) }, () => next(50000));
        const weeks = [week(WEEK, '2400.00', `${next(1500)}.00`)];
        const whole = (cents) => lineOvertimePremium({ weeks, lines: cents.map(line) }).extraPremiumCents;
        const paid = [];
        amounts.forEach((cents, n) => {
          paid.push(lineOvertimePremium({
            weeks, lines: [line(cents)], earlierLines: amounts.slice(0, n).map(line), earlierPremiums: paidRows(paid),
          }).extraPremiumCents);
          // after every check: never less than one check with every line so far, and at most 1 cent more for each later check
          const all = whole(amounts.slice(0, n + 1));
          expect([i, n, sum(paid) >= all, sum(paid) - all <= n]).toEqual([i, n, true, true]);
        });
        // any one check voided: the checks that are left still cover the lines that are left
        amounts.forEach((_, gone) => {
          const leftPaid = paid.filter((__, n) => n !== gone);
          const leftLines = amounts.filter((__, n) => n !== gone);
          if (leftLines.length) expect([i, gone, sum(leftPaid) >= whole(leftLines)]).toEqual([i, gone, true]);
        });
      }
    });

    it('after any number of checks priced the older way, one check by this rule makes the week whole (2,000 generated weeks)', () => {
      let seed = 11212026;
      const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % max); };
      const sum = (list) => list.reduce((total, cents) => total + cents, 0);
      for (let i = 0; i < 2000; i += 1) {
        const older = Array.from({ length: 1 + next(4) }, () => next(50000));
        const cents = next(50000);
        const weeks = [week(WEEK, '2400.00', `${next(1500)}.00`)];
        const alone = (list) => lineOvertimePremium({ weeks, lines: list.map(line) }).extraPremiumCents;
        // the older rule: each check half up on its own line
        const olderPaid = older.map((amount) => alone([amount]));
        const now = lineOvertimePremium({ weeks, lines: [line(cents)], earlierLines: older.map(line), earlierPremiums: paidRows(olderPaid) }).extraPremiumCents;
        expect([i, sum(olderPaid) + now >= alone([...older, cents]), now >= alone([cents])]).toEqual([i, true, true]);
      }
    });

    it('prices each week of a span by that week\'s own history', () => {
      // a 12.00 line over 2 weeks (6.00 a week); a finalized check already paid a 6.00 line and 33 of premium in the first week
      const weeks = [week('2026-11-09', '2400.00', '300.00'), week('2026-11-16', '2400.00', '300.00')];
      const result = lineOvertimePremium({
        weeks,
        lines: [{ amountCents: 1200, coversFrom: '2026-11-09', coversTo: '2026-11-22' }],
        earlierLines: [{ amountCents: 600, weekStart: '2026-11-09' }, { amountCents: 99999, weekStart: '2026-10-05' }],
        earlierPremiums: [{ weekStart: '2026-11-09', premiumCents: 33 }, { weekStart: '2026-10-05', premiumCents: 500 }],
      });
      expect(result.weeks.map((w) => [w.weekStart, w.premiumCents, w.earlierAllocatedCents, w.earlierPremiumCents])).toEqual([
        ['2026-11-09', 34, 600, 33],
        ['2026-11-16', 33, undefined, undefined], // nobody paid for this week: 33.33 half up
      ]);
      expect(result.extraPremiumCents).toBe(67);
    });

    it('refuses an earlier premium that is not a whole number of cents, zero or more', () => {
      expect(() => later(600, [600], [-1])).toThrow(/whole number of cents/);
      expect(() => later(600, [600], [1.5])).toThrow(/whole number of cents/);
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
