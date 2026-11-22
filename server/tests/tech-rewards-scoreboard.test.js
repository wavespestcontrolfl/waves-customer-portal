// Tech Rewards Plan D5-4: the pure parts of the scoreboard service (which season, review rate, the compose step),
// with synthetic fixtures. The reads run against Postgres in tech-rewards-scoreboard-postgres.test.js.
jest.mock('../models/db', () => jest.fn());

const { composeScoreboard, pickSeason, reviewRateBps, earnedGrossCents, checkComponents, ordinaryPremium } = require('../services/tech-rewards-scoreboard');
const { priceCheckLines } = require('../services/payroll-pay-lines');

const WEIGHTS = { onTime: 25, audit: 25, callbacks: 20, truck: 10, ownerRating: 20 };
const CUTS = { top: 90, mid: 80, low: 70 };
const PARTS = { onTime: 95, audit: 90, callbacks: 88, truck: 100, ownerRating: 85 };

const complete = (parts = PARTS) => ({
  complete: true, year: 2026, parts, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS },
});
const incomplete = { complete: false, year: 2026, parts: { ...PARTS, audit: null }, missing: ['audit'] };

function inputs(over = {}) {
  const today = over.today || '2026-11-20';
  return {
    technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2025-04-01' },
    today,
    season: pickSeason(today),
    seasonScore: complete(),
    settings: null,
    reviews: 6,
    asks: 30,
    grossSeasonCents: 1000000,
    priorYearGrossCents: 2000000,
    commission: { paidCents: 20000, unpaidCents: 10000 },
    commissionRecordedThrough: { weekEnd: '2026-11-08' },
    ...over,
  };
}

describe('pickSeason (the off-season choice)', () => {
  test.each([
    ['2026-03-01', 2026, 'running', '2026-03-01'],
    ['2026-06-15', 2026, 'running', '2026-06-15'],
    ['2026-08-31', 2026, 'running', '2026-08-31'],
    ['2026-09-01', 2026, 'final', '2026-08-31'],
    ['2026-11-20', 2026, 'final', '2026-08-31'],
    ['2026-12-31', 2026, 'final', '2026-08-31'],
    ['2027-01-01', 2026, 'final', '2026-08-31'],
    ['2027-02-28', 2026, 'final', '2026-08-31'],
    ['2027-03-01', 2027, 'running', '2027-03-01'],
  ])('%s shows the %i season as %s (asOf %s)', (today, year, status, asOf) => {
    const season = pickSeason(today);
    expect([season.year, season.status, season.asOf]).toEqual([year, status, asOf]);
  });

  test('the bonus pay date is the last Friday of September', () => {
    expect(pickSeason('2026-11-20').payDate).toBe('2026-09-25');
  });
});

describe('reviewRateBps', () => {
  test('reviews over asks in basis points, null with no asks, capped at 100%', () => {
    expect(reviewRateBps(6, 30)).toBe(2000);
    expect(reviewRateBps(1, 3)).toBe(3333);
    expect(reviewRateBps(0, 0)).toBeNull();
    expect(reviewRateBps(5, 2)).toBe(10000);
  });
});

describe('the overtime a bonus causes is not a bonus base', () => {
  test('the premium a Tech Rewards line caused (techRewardsPremiumCents) is not left in the base as undated pay', () => {
    const check = {
      weekStart: '2026-09-14', grossCents: 100000 + 156000 + 6100, regularPayCents: 0, overtimePayCents: 0, overtimeMinutes: 0,
      ptoPayCents: 0, holidayPayCents: 0, techRewardsCents: 156000, techRewardsPremiumCents: 606,
      lines: [{ cents: 100000, weekStart: '2026-08-24' }], lineOvertimeWeeks: [{ weekStart: '2026-08-24', premiumCents: 5494 }],
    };
    // 100,000 line + 5,494 premium of the ordinary line: gross less the 156,000 bonus and its 606 premium
    expect(earnedGrossCents([check], '2026-03-01', '2026-08-31')).toBe(105494);
  });
});

describe('ordinaryPremium: the overtime a check paid for its ordinary lines only', () => {
  // one week of 50 hours, 10 of them overtime; the check stored 4,000 of premium for 40,000 of line pay in that week
  const stored = [{ weekStart: '2026-05-04', workedMinutes: 3000, overtimeMinutes: 600, premiumCents: 4000 }];
  const commission = { kind: 'commission', cents: 10000, weekStart: '2026-05-04' };
  const reward = { kind: 'stay_bonus', cents: 30000, weekStart: '2026-06-01', coversFrom: '2026-05-04', coversTo: '2026-05-10' };
  const withFigure = (ordinaryPremiumCents) => [{ ...stored[0], ordinaryPremiumCents }];

  test('a check with no season bonus, stay bonus or December gift keeps the premium it stored', () => {
    expect(ordinaryPremium([commission], stored)).toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 4000 }], excludedCents: 0, unsplitWeeks: [] });
    expect(ordinaryPremium([], [])).toEqual({ weeks: [], excludedCents: 0, unsplitWeeks: [] });
  });

  test('with one, a week it covers takes the figure the pay run stored for the ordinary lines, and the rest is left out', () => {
    // 10,000 over 50 hours is 200 an hour; half of it for 10 overtime hours is 1,000. The other 3,000 came from the bonus.
    expect(ordinaryPremium([commission, reward], withFigure(1000))).toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 1000 }], excludedCents: 3000, unsplitWeeks: [] });
    // a check whose only line is the bonus stored 0: none of its premium is a base
    expect(ordinaryPremium([reward], withFigure(0))).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: [] });
    // never over what the check stored for the week, and never under nothing
    expect(ordinaryPremium([commission, reward], withFigure(5000))).toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 4000 }], excludedCents: 0, unsplitWeeks: [] });
    expect(ordinaryPremium([commission, reward], withFigure(-5))).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: [] });
  });

  describe('a covered week with no stored figure (a check priced before the pay run stored one) is read by what its own row proves', () => {
    test('the row shows no earlier pay: the check priced its lines for the week alone, so its ordinary lines priced alone from the row\'s hours are exact', () => {
      // 10,000 over 50 hours, half of it for 10 overtime hours: 1,000, as the stored figure would say
      expect(ordinaryPremium([commission, reward], stored)).toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 1000 }], excludedCents: 3000, unsplitWeeks: [] });
      expect(ordinaryPremium([reward], stored)).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: [] });
    });

    test('the row shows earlier pay: the split is not proven, none of the week\'s premium counts and the week is named', () => {
      // the row holds the earlier line pay rounded to the cent, and the commission's part depends on the exact figure
      const row = { ...stored[0], earlierAllocatedCents: 600, earlierPremiumCents: 33 };
      expect(ordinaryPremium([commission, reward], [row])).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: ['2026-05-04'] });
      // an earlier premium alone is earlier pay too
      expect(ordinaryPremium([commission, reward], [{ ...stored[0], earlierPremiumCents: 33 }]).unsplitWeeks).toEqual(['2026-05-04']);
      // with the stored figure the same row is read as before, and a week the bonus does not cover is never unsplit
      expect(ordinaryPremium([commission, reward], [{ ...row, ordinaryPremiumCents: 1000 }]))
        .toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 1000 }], excludedCents: 3000, unsplitWeeks: [] });
      expect(ordinaryPremium([commission], [row])).toEqual({ weeks: [{ weekStart: '2026-05-04', premiumCents: 4000 }], excludedCents: 0, unsplitWeeks: [] });
    });

    test('nothing to split is proven nothing, with earlier pay on the row too: the bonus is the check\'s only line for the week, or the week paid no premium', () => {
      const row = { ...stored[0], earlierAllocatedCents: 600, earlierPremiumCents: 33 };
      // without the bonus the check would have paid nothing for the week
      expect(ordinaryPremium([reward], [row])).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: [] });
      // its commission is for another week
      expect(ordinaryPremium([{ ...commission, weekStart: '2026-04-27' }, reward], [row])).toEqual({ weeks: [], excludedCents: 4000, unsplitWeeks: [] });
      // a week with no overtime paid no premium: there is nothing to split
      expect(ordinaryPremium([commission, reward], [{ ...row, premiumCents: 0 }])).toEqual({ weeks: [], excludedCents: 0, unsplitWeeks: [] });
    });
  });

  describe('one rule: the ordinary part is what the check would have paid without its Tech Rewards lines, stored when the pay run prices the check', () => {
    // 45 hours, 5 of them overtime: premium = line pay x 5 / 90
    const WEEK = '2026-11-09';
    const BEFORE = '2026-11-02';
    const HOURS = [WEEK, BEFORE].map((weekStart) => ({ weekStart, regularMinutes: '2400.00', overtimeMinutes: '300.00' }));
    const commissionOf = (amountCents, weekStart = WEEK) => ({ kind: 'commission', amountCents, weekStart });
    const gift = (amountCents) => ({ kind: 'december_gift', amountCents, coversFrom: WEEK, coversTo: '2026-11-15' });
    const paid = (premiumCents, weekStart = WEEK) => [{ weekStart, premiumCents }];
    // the check as the pay run prices and stores it (priceCheckLines); `earlierLines` and `earlierPremiums`: what finalized
    // checks had paid for the week when this one was priced
    const priced = (lines, earlierLines = [], earlierPremiums = []) => priceCheckLines({ weeks: HOURS, lines, earlierLines, earlierPremiums });
    // what a bonus base reads from that check, with nothing but the check's own rows
    const baseOf = (lines, check) => ordinaryPremium(lines, check.weeks);
    const rowOf = (check, weekStart = WEEK) => check.weeks.find((w) => w.weekStart === weekStart);

    test('the first check for the week, a commission and the gift: the commission alone earns 33 of the 67', () => {
      const lines = [commissionOf(600), gift(600)];
      const check = priced(lines);
      expect(check.extraPremiumCents).toBe(67);
      expect(rowOf(check)).toMatchObject({ premiumCents: 67, ordinaryPremiumCents: 33 });
      expect(baseOf(lines, check)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 33 }], excludedCents: 34, unsplitWeeks: [] });
    });

    test('a later check: the commission is priced as the pay run prices a later check, with what the earlier checks paid', () => {
      // an earlier check paid a 6.00 commission and 33. This check's commission alone would pay 34 (its floor, 33.33 up; the
      // shortfall of the two commissions, 67 - 33, is 34 too). With the gift the check pays 67.
      const lines = [commissionOf(600), gift(600)];
      const check = priced(lines, [commissionOf(600)], paid(33));
      expect(rowOf(check)).toMatchObject({ premiumCents: 67, ordinaryPremiumCents: 34, earlierPremiumCents: 33 });
      // the base reads the 34 from the check: it needs no other check, in no order
      expect(baseOf(lines, check)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 34 }], excludedCents: 33, unsplitWeeks: [] });
    });

    test('a gift on the check never moves the base: the same commission counts the same with and without it', () => {
      // two 6.03 commissions on two checks earn 34 each under the pay rule (33.5 half up, then 33.5 up)
      const earlier = [[commissionOf(603)], paid(34)];
      const without = priced([commissionOf(603)], ...earlier); // the second check with no gift pays 34
      const withGift = priced([commissionOf(603), gift(600)], ...earlier); // with the gift it pays 67
      expect([rowOf(without).premiumCents, rowOf(withGift).premiumCents]).toEqual([34, 67]);
      expect(rowOf(without)).not.toHaveProperty('ordinaryPremiumCents'); // no Tech Rewards line: the row is as before
      expect(baseOf([commissionOf(603)], without)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 34 }], excludedCents: 0, unsplitWeeks: [] });
      expect(baseOf([commissionOf(603), gift(600)], withGift)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 34 }], excludedCents: 33, unsplitWeeks: [] });
      // the same when the check also makes up what two older commission checks were short (6.02 each, 33 + 33 paid; with a
      // 12.00 commission the three earn 133.56 -> 134): 68 without the gift, 68 of the 101 with it
      const older = [[commissionOf(602), commissionOf(602)], paid(66)];
      expect(rowOf(priced([commissionOf(1200)], ...older)).premiumCents).toBe(68);
      const madeUp = priced([commissionOf(1200), gift(600)], ...older);
      expect(rowOf(madeUp)).toMatchObject({ premiumCents: 101, ordinaryPremiumCents: 68 });
      expect(baseOf([commissionOf(1200), gift(600)], madeUp)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 68 }], excludedCents: 33, unsplitWeeks: [] });
    });

    test('a check with only the gift for the week has no ordinary part there, whatever it made up', () => {
      // without the gift this check would have paid nothing for the week
      const check = priced([gift(1200)], [commissionOf(602), commissionOf(602)], paid(66));
      expect(rowOf(check)).toMatchObject({ premiumCents: 68, ordinaryPremiumCents: 0 });
      expect(baseOf([gift(1200)], check)).toEqual({ weeks: [], excludedCents: 68, unsplitWeeks: [] });
    });

    test('an earlier line of another week changes nothing', () => {
      const lines = [commissionOf(600), gift(600)];
      const check = priced(lines, [commissionOf(600, BEFORE)], paid(33, BEFORE));
      expect(baseOf(lines, check)).toEqual({ weeks: [{ weekStart: WEEK, premiumCents: 33 }], excludedCents: 34, unsplitWeeks: [] });
    });

    test('a week no Tech Rewards line of the check covers keeps all of its premium, a make-up for an older shortfall included', () => {
      // the check holds the gift for the week of Nov 9, and a 12.00 commission for the week of Nov 2 that pays 68: its own 67
      // and 1 cent two older commission checks were short
      const lines = [commissionOf(1200, BEFORE), gift(600)];
      const check = priced(lines, [commissionOf(602, BEFORE), commissionOf(602, BEFORE)], paid(66, BEFORE));
      expect(rowOf(check, BEFORE)).toMatchObject({ premiumCents: 68 });
      expect(rowOf(check, BEFORE)).not.toHaveProperty('ordinaryPremiumCents');
      expect(rowOf(check)).toMatchObject({ premiumCents: 33, ordinaryPremiumCents: 0 });
      expect(baseOf(lines, check)).toEqual({ weeks: [{ weekStart: BEFORE, premiumCents: 68 }], excludedCents: 33, unsplitWeeks: [] });
    });
  });
});

describe('earnedGrossCents (by component earning date)', () => {
  const FROM = '2026-03-01';
  const TO = '2026-08-31';
  const plain = (weekStart, cents, extra = {}) => ({
    weekStart, grossCents: cents, regularPayCents: cents, overtimePayCents: 0, overtimeMinutes: 0, ptoPayCents: 0, holidayPayCents: 0, ...extra,
  });
  const mins = (...pairs) => pairs.map(([workDate, minutes]) => ({ workDate, minutes }));
  const sum = (check) => checkComponents(check).reduce((total, c) => total + c.cents, 0);

  test('the components of a plain week add up to its gross; so do the components of a full check', () => {
    const week = plain('2026-04-06', 70000);
    expect(sum(week)).toBe(week.grossCents);
    const full = {
      weekStart: '2026-09-07', grossCents: 40000 + 12000 + 8000 + 4000 + 3000 + 500 + 1500,
      regularPayCents: 40000, overtimePayCents: 12000, overtimeMinutes: 480, ptoPayCents: 8000, holidayPayCents: 4000,
      lines: [{ cents: 3000, earnedOn: '2026-05-10' }, { cents: 500, earnedOn: '2026-04-10' }],
      lineOvertimeWeeks: [{ weekStart: '2026-05-04', premiumCents: 1500 }],
    };
    expect(sum(full)).toBe(full.grossCents);
    expect(checkComponents(full).at(-1).cents).toBe(0); // nothing left undated
  });

  test('a season bonus, stay bonus or December gift on a check is never part of a bonus base (a bonus does not feed a bonus)', () => {
    const paid = plain('2026-04-06', 70000 + 50000, { regularPayCents: 70000, techRewardsCents: 50000 });
    expect(sum(paid)).toBe(70000); // the 50000 is not a component of the base
    expect(earnedGrossCents([paid], FROM, TO)).toBe(70000);
    expect(earnedGrossCents([plain('2026-04-06', 70000)], FROM, TO)).toBe(70000); // a check with none is as before
  });

  test('whole weeks inside the window count in full; a week before or after counts nothing', () => {
    expect(earnedGrossCents([plain('2026-03-02', 70000), plain('2026-08-24', 70000), plain('2026-02-16', 70000)], FROM, TO)).toBe(140000);
    expect(earnedGrossCents([plain('2026-09-07', 70000)], FROM, TO)).toBe(0);
  });

  test('an edge week with no day records (no summaries, no time off) counts its in-window days / 7', () => {
    expect(earnedGrossCents([plain('2026-08-31', 70000)], FROM, TO)).toBe(10000); // Mon Aug 31 only
    expect(earnedGrossCents([plain('2026-02-23', 70000)], FROM, TO)).toBe(10000); // Sun Mar 1 only
    expect(earnedGrossCents([plain('2028-08-28', 100000)], '2028-03-01', '2028-08-31')).toBe(57143); // Mon-Thu = 4 of 7
    expect(earnedGrossCents([plain('2026-08-31', 70000, { dayMinutes: [] })], FROM, TO)).toBe(10000);
    expect(earnedGrossCents([plain('2026-08-31', 70000, { dayMinutes: mins(['2026-08-31', 0]) })], FROM, TO)).toBe(10000);
  });

  test('wages in an edge week follow the shift dates: all inside is full, all outside is 0, a split is proportional', () => {
    expect(earnedGrossCents([plain('2026-02-23', 70000, { dayMinutes: mins(['2026-03-01', 480]) })], FROM, TO)).toBe(70000);
    expect(earnedGrossCents([plain('2026-08-31', 70000, { dayMinutes: mins(['2026-09-01', 480], ['2026-09-02', 480]) })], FROM, TO)).toBe(0);
    expect(earnedGrossCents([plain('2026-08-31', 50000, { dayMinutes: mins(['2026-08-31', 480], ['2026-09-01', 480], ['2026-09-02', 480]) })], FROM, TO)).toBe(16667);
  });

  test('overtime minutes are the last minutes worked, at 1.5x: Monday of a 48 hour week carries 960 of 6240 weight', () => {
    const days = mins(['2026-08-31', 480], ['2026-09-01', 480], ['2026-09-02', 480], ['2026-09-03', 480], ['2026-09-04', 480], ['2026-09-05', 480]);
    const week = plain('2026-08-31', 100000, { regularPayCents: 70000, overtimePayCents: 30000, overtimeMinutes: 480, dayMinutes: days });
    expect(earnedGrossCents([week], FROM, TO)).toBe(Math.round((100000 * 960) / 6240)); // 15385
  });

  test('paid time off on Aug 31 in a boundary week counts by its dated record, not by the shift minutes', () => {
    // 10000 of PTO taken Mon Aug 31 and Tue Sep 1 (half in the window), wages 30000 worked a third in the window
    const week = plain('2026-08-31', 40000, {
      regularPayCents: 30000, ptoPayCents: 10000,
      dayMinutes: mins(['2026-08-31', 480], ['2026-09-01', 480], ['2026-09-02', 480]),
      ptoRecords: mins(['2026-08-31', 480], ['2026-09-01', 480]), holidayRecords: [],
    });
    expect(earnedGrossCents([week], FROM, TO)).toBe(10000 + 5000);
    // a week of nothing but PTO (no shifts) is still dated by its record
    const onlyPto = plain('2026-08-31', 8000, { regularPayCents: 0, ptoPayCents: 8000, dayMinutes: [], ptoRecords: mins(['2026-08-31', 480]), holidayRecords: [] });
    expect(earnedGrossCents([onlyPto], FROM, TO)).toBe(8000);
  });

  test('holiday pay is dated by its own record', () => {
    const week = plain('2026-02-23', 12000, { regularPayCents: 0, holidayPayCents: 12000, dayMinutes: [], ptoRecords: [], holidayRecords: mins(['2026-02-27', 480]) });
    expect(earnedGrossCents([week], FROM, TO)).toBe(0);
  });

  test('catch-up overtime premium earned in May and paid in September counts in the season', () => {
    const paidSeptember = plain('2026-09-07', 10000, {
      regularPayCents: 7000, lineOvertimePremiumCents: 3000,
      lineOvertimeWeeks: [{ weekStart: '2026-05-04', premiumCents: 2000 }, { weekStart: '2026-05-11', premiumCents: 1000 }],
    });
    expect(earnedGrossCents([paidSeptember], FROM, TO)).toBe(3000);
    // a premium earned in a September week stays out of it
    expect(earnedGrossCents([{ ...paidSeptember, lineOvertimeWeeks: [{ weekStart: '2026-09-07', premiumCents: 3000 }] }], FROM, TO)).toBe(0);
  });

  test('pay lines count on the day they were earned, wherever they were paid', () => {
    const check = plain('2026-09-07', 12500, {
      regularPayCents: 2000,
      lines: [{ cents: 8000, earnedOn: '2026-05-10' }, { cents: 1500, earnedOn: '2026-04-10' }, { cents: 1000, earnedOn: '2026-09-07' }],
    });
    expect(earnedGrossCents([check], FROM, TO)).toBe(9500);
  });

  test('a line with only an earned pay week counts that week in-window days / 7; a day-dated line takes its one day', () => {
    // Mon Aug 31 week: 1 of 7 days in the season
    const weekOnly = plain('2026-09-07', 7000, { regularPayCents: 0, lines: [{ cents: 7000, earnedOn: null, weekStart: '2026-08-31' }] });
    expect(earnedGrossCents([weekOnly], FROM, TO)).toBe(1000);
    const dayDated = plain('2026-09-07', 7000, { regularPayCents: 0, lines: [{ cents: 7000, earnedOn: '2026-08-31', weekStart: '2026-08-31' }] });
    expect(earnedGrossCents([dayDated], FROM, TO)).toBe(7000);
    // a week-only line in a week fully inside is whole
    expect(earnedGrossCents([plain('2026-09-07', 7000, { regularPayCents: 0, lines: [{ cents: 7000, earnedOn: null, weekStart: '2026-04-06' }] })], FROM, TO)).toBe(7000);
  });

  test('a manual allowance covering August, paid in a September week, is split over its workweeks like the overtime premium', () => {
    // Aug 1 - Aug 31 covers the weeks of Jul 27 (2 covered days), Aug 3, 10, 17, 24 and 31 (1 covered day): 6 x 1000, every covered day in the season
    const allowance = plain('2026-09-07', 6000, { regularPayCents: 0, lines: [{ cents: 6000, earnedOn: null, weekStart: '2026-09-07', coversFrom: '2026-08-01', coversTo: '2026-08-31' }] });
    expect(earnedGrossCents([allowance], FROM, TO)).toBe(6000);
    // a span that runs past the season end: Aug 25 - Sep 6 is two weeks of 3000; the Aug 24 week (6 covered days) is all in, the Aug 31 week has 1 of its 7 covered days in
    const straddle = plain('2026-09-07', 6000, { regularPayCents: 0, lines: [{ cents: 6000, earnedOn: null, weekStart: '2026-09-07', coversFrom: '2026-08-25', coversTo: '2026-09-06' }] });
    expect(earnedGrossCents([straddle], FROM, TO)).toBe(3000 + 429);
    // the same line in the stay window of a later year takes the weeks by the same split; cents that do not divide go to the first weeks
    const odd = plain('2026-09-07', 1000, { regularPayCents: 0, lines: [{ cents: 1000, earnedOn: null, weekStart: '2026-09-07', coversFrom: '2026-04-06', coversTo: '2026-04-26' }] });
    expect(checkComponents(odd).map((c) => c.cents).filter(Boolean)).toEqual([334, 333, 333]);
    expect(earnedGrossCents([odd], FROM, TO)).toBe(1000);
    // a ledger commission line (a span, but a payment day) keeps its one day
    const ledger = plain('2026-09-07', 4000, { regularPayCents: 0, lines: [{ cents: 4000, earnedOn: '2026-05-10', weekStart: '2026-05-04', coversFrom: '2026-03-02', coversTo: '2026-05-10' }] });
    expect(earnedGrossCents([ledger], FROM, TO)).toBe(4000);
  });

  test('a gross the components do not explain is undated: it takes its week in-window days / 7', () => {
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 70000, regularPayCents: 0, overtimePayCents: 0, ptoPayCents: 0, holidayPayCents: 0 }], FROM, TO)).toBe(10000);
  });

  test('both edges prorate in the stay bonus window, and a week after the window is out', () => {
    // window 2026-04-01 (Wed) .. 2026-11-20 (Fri): Mon Mar 30 week has 5 of 7 days in; Mon Nov 16 week has 5 of 7 in; Nov 23 is out
    expect(earnedGrossCents([plain('2026-03-30', 70000), plain('2026-11-16', 70000), plain('2026-11-23', 70000)], '2026-04-01', '2026-11-20')).toBe(100000);
  });
});

describe('composeScoreboard', () => {
  test('a finished season: score, band, review rate, commission, bonus estimate and stay bonus from the calculator', () => {
    const board = composeScoreboard(inputs());
    expect(board.technician).toEqual({ id: 'tech-1', name: 'Sample Alpha' });
    expect(board.season).toMatchObject({ year: 2026, status: 'final', payDate: '2026-09-25' });
    expect(board.score).toMatchObject({ complete: true, value: 91.5, band: { rateBps: 400, cutLines: CUTS } });
    expect(board.score.parts.audit).toEqual({ value: 90, weight: 25 });
    expect(board.reviews).toEqual({ count: 6, asks: 30, rateBps: 2000, multiplierPartE4: 3333 });
    expect(board.commission).toEqual({ year: 2026, yearToDateCents: 30000, paidCents: 20000, unpaidCents: 10000, recordedThrough: { weekEnd: '2026-11-08' } });
    // 1 year of tenure on Mar 1 2026 (hired 2025-04-01 -> 0 full years: Apr 1 is after Mar 1)
    expect(board.multiplier).toMatchObject({ tenureYears: 0, level: 1, levelSource: 'entry_default', multiplierE4: 13333 });
    // 400 bps x $10,000.00 x 1.3333 = $533.32
    expect(board.seasonBonus).toEqual({ grossCents: 1000000, estimate: true, estimateCents: 53332, rateBps: 400, multiplierE4: 13333 });
    // hired 2025-04-01: the 1-year bonus was due 2026-04-01 (past); the next is the 3-year on 2028-04-01, whose pay window has not begun
    expect(board.stayBonus).toMatchObject({ dueDate: '2028-04-01', estimateCents: null });
  });

  test('an incomplete score names what is missing, still shows its parts and gives no bonus number', () => {
    const board = composeScoreboard(inputs({ seasonScore: incomplete, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS } }));
    expect(board.score).toMatchObject({ complete: false, value: null, missing: ['audit'], band: null });
    expect(board.score.parts.audit).toEqual({ value: null, weight: 25 });
    expect(board.score.parts.onTime).toEqual({ value: 95, weight: 25 });
    expect(board.seasonBonus).toEqual({ grossCents: 1000000, estimate: true, estimateCents: null, reason: 'score_incomplete' });
  });

  test('no pay run yet: the commission cutoff is null', () => {
    expect(composeScoreboard(inputs({ commissionRecordedThrough: null })).commission.recordedThrough).toBeNull();
  });

  test('no score settings in force: no score, no band, no bonus; the rest of the board is intact', () => {
    const board = composeScoreboard(inputs({ seasonScore: null, settings: null }));
    expect(board.score).toEqual({ complete: false, value: null, missing: [], parts: {}, band: null, settingsVersion: null, unavailable: 'no_settings' });
    expect(board.seasonBonus).toEqual({ grossCents: 1000000, estimate: true, estimateCents: null, reason: 'no_settings' });
    expect(board.reviews.rateBps).toBe(2000);
    expect(board.commission.yearToDateCents).toBe(30000);
    expect(board.stayBonus).toMatchObject({ dueDate: '2028-04-01' });
  });

  test('no asks: the review rate is null and counts 0 in the multiplier', () => {
    const board = composeScoreboard(inputs({ reviews: 0, asks: 0 }));
    expect(board.reviews).toEqual({ count: 0, asks: 0, rateBps: null, multiplierPartE4: 0 });
    expect(board.multiplier.multiplierE4).toBe(10000);
  });

  test('a score below the lowest band estimates $0', () => {
    const board = composeScoreboard(inputs({ seasonScore: { ...complete(), score: 60, rateBps: 0 } }));
    expect(board.seasonBonus.estimateCents).toBe(0);
  });

  test('no hire date: no multiplier, no bonus estimate, no stay bonus', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: null } }));
    expect(board.multiplier).toEqual({ reason: 'no_hire_date' });
    expect(board.seasonBonus).toMatchObject({ estimateCents: null, reason: 'no_hire_date' });
    expect(board.stayBonus).toBeNull();
    expect(board.reviews.multiplierPartE4).toBeNull();
  });

  test('hired after the season: no multiplier and no estimate', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2026-10-01' } }));
    expect(board.multiplier).toEqual({ reason: 'hired_after_season' });
    expect(board.seasonBonus).toMatchObject({ estimateCents: null, reason: 'hired_after_season' });
    // the first stay bonus is still ahead
    expect(board.stayBonus).toMatchObject({ dueDate: '2027-10-01', years: 1, rateBps: 200 });
  });

  test('a milestone whose 12 months of pay have not begun keeps its date and has no amount', () => {
    const board = composeScoreboard(inputs({ priorYearGrossCents: 0 }));
    // hired 2025-04-01 -> the 3-year bonus is due 2028-04-01; its pay window opens 2027-04-01
    expect(board.stayBonus).toEqual({ dueDate: '2028-04-01', years: 3, rateBps: 400, estimateCents: null, estimate: true, earningsStart: '2027-04-01', earningsEnd: '2028-03-31' });
  });

  test('an open window gives an amount, with the window start named', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2025-12-01' }, priorYearGrossCents: 230000 }));
    expect(board.stayBonus).toEqual({ dueDate: '2026-12-01', years: 1, rateBps: 200, estimateCents: 4600, estimate: true, earningsStart: '2025-12-01', earningsEnd: '2026-11-30' });
  });

  test('past the 5-year bonus there is no next stay bonus', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2018-01-01' } }));
    expect(board.stayBonus).toBeNull();
  });

  test('the output carries no customer fields', () => {
    expect(JSON.stringify(composeScoreboard(inputs()))).not.toMatch(/customer|address|phone|email/i);
  });
});
