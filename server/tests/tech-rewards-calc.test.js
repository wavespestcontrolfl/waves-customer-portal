// Tech Rewards calculator (Plan D5-1): pure functions, synthetic round numbers only.
const calc = require('../services/tech-rewards-calc');

const {
  TechRewardsCalcError, scoreBand, weightedScore, seasonMultiplier, seasonBonusCents,
  seasonBonusPayDate, seasonWindow, stayBonus, DEFAULT_WEIGHTS, MULTIPLIER_MIN_E4, MULTIPLIER_MAX_E4,
} = calc;

function codeOf(fn) {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(TechRewardsCalcError);
    expect(err.name).toBe('TechRewardsCalcError');
    return err.code;
  }
  throw new Error('expected a throw');
}

describe('scoreBand', () => {
  test.each([
    [69.99, 0], [70, 100], [79.99, 100], [80, 250], [89.99, 250], [90, 400], [100, 400], [0, 0],
  ])('score %p -> %p bps', (score, bps) => {
    expect(scoreBand(score)).toBe(bps);
  });

  test('custom cut lines apply', () => {
    expect(scoreBand(85, { top: 95, mid: 85, low: 75 })).toBe(250);
    expect(scoreBand(84.99, { top: 95, mid: 85, low: 75 })).toBe(100);
  });

  test('bad cut lines throw', () => {
    expect(codeOf(() => scoreBand(90, { top: 80, mid: 80, low: 70 }))).toBe('INVALID_CUT_LINES');
    expect(codeOf(() => scoreBand(90, { top: 90, mid: 70, low: 80 }))).toBe('INVALID_CUT_LINES');
    expect(codeOf(() => scoreBand(90, { top: 90, mid: 80 }))).toBe('INVALID_CUT_LINES');
    expect(codeOf(() => scoreBand(90, null))).toBe('INVALID_CUT_LINES');
  });

  test('bad scores throw', () => {
    [-1, 100.01, NaN, Infinity, '90', null, undefined].forEach((s) => {
      expect(codeOf(() => scoreBand(s))).toBe('INVALID_SCORE');
    });
  });
});

describe('weightedScore', () => {
  const parts = { onTime: 100, audit: 80, callbacks: 60, truck: 50, ownerRating: 90 };

  test('default weights sum to 100 and combine the parts', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    // 2500 + 2000 + 1200 + 500 + 1800 = 8000
    expect(weightedScore(parts)).toBe(80);
  });

  test('all 100 gives 100, all 0 gives 0', () => {
    const all = (n) => ({ onTime: n, audit: n, callbacks: n, truck: n, ownerRating: n });
    expect(weightedScore(all(100))).toBe(100);
    expect(weightedScore(all(0))).toBe(0);
  });

  test('custom weights', () => {
    const w = { onTime: 20, audit: 20, callbacks: 20, truck: 20, ownerRating: 20 };
    expect(weightedScore(parts, w)).toBe(76);
  });

  test('weights that do not sum to 100 throw', () => {
    expect(codeOf(() => weightedScore(parts, { onTime: 25, audit: 25, callbacks: 20, truck: 10, ownerRating: 19 }))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => weightedScore(parts, { onTime: 25, audit: 25, callbacks: 20, truck: 10, ownerRating: 21 }))).toBe('INVALID_WEIGHTS');
  });

  test('missing, unknown or negative weights throw', () => {
    expect(codeOf(() => weightedScore(parts, { onTime: 50, audit: 50 }))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => weightedScore(parts, { ...DEFAULT_WEIGHTS, extra: 0 }))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => weightedScore(parts, { onTime: 125, audit: -25, callbacks: 0, truck: 0, ownerRating: 0 }))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => weightedScore(parts, null))).toBe('INVALID_WEIGHTS');
  });

  test('parts and weights allow 2 decimals, exactly; more decimals throw', () => {
    const p = { onTime: 89.99, audit: 89.99, callbacks: 89.99, truck: 89.99, ownerRating: 89.99 };
    expect(weightedScore(p)).toBe(89.99);
    expect(scoreBand(weightedScore(p))).toBe(250);
    expect(codeOf(() => weightedScore({ ...p, audit: 89.995 }))).toBe('INVALID_PARTS');
    const near = { onTime: 89.999999999, audit: 89.999999999, callbacks: 89.999999999, truck: 89.999999999, ownerRating: 89.999999999 };
    expect(codeOf(() => weightedScore(near))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore(p, { onTime: 25.000000001, audit: 24.999999999, callbacks: 20, truck: 10, ownerRating: 20 }))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => weightedScore(p, { onTime: 25.001, audit: 24.999, callbacks: 20, truck: 10, ownerRating: 20 }))).toBe('INVALID_WEIGHTS');
  });

  test('bad parts throw', () => {
    expect(codeOf(() => weightedScore({ ...parts, truck: 101 }))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore({ ...parts, audit: -1 }))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore({ ...parts, audit: NaN }))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore({ onTime: 1 }))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore({ ...parts, extra: 1 }))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore(undefined))).toBe('INVALID_PARTS');
  });
});

describe('seasonMultiplier', () => {
  const base = { asOf: '2026-09-01', reviewRateBps: 1000, level: 1 };
  const part = (over, key) => seasonMultiplier({ hireDate: '2026-06-01', ...base, ...over }).parts[key];

  test('new hire at entry level with a low review rate is 1.0', () => {
    const r = seasonMultiplier({ ...base, hireDate: '2026-06-01' });
    expect(r.multiplierE4).toBe(10000);
    expect(r.parts).toEqual({ baseE4: 10000, tenureE4: 0, reviewRateE4: 0, levelE4: 0 });
    expect(r.tenureYears).toBe(0);
    expect(r.seasonYear).toBe(2026);
  });

  test('tenure counts a full year on Mar 1 but not the day after', () => {
    expect(seasonMultiplier({ ...base, hireDate: '2025-03-01' }).parts.tenureE4).toBe(2500);
    expect(seasonMultiplier({ ...base, hireDate: '2025-03-02' }).parts.tenureE4).toBe(0);
    expect(seasonMultiplier({ ...base, hireDate: '2025-02-28' }).parts.tenureE4).toBe(2500);
  });

  test('tenure is 0.25 per year and caps at 1.0', () => {
    expect(seasonMultiplier({ ...base, hireDate: '2023-03-01' }).parts.tenureE4).toBe(7500);
    expect(seasonMultiplier({ ...base, hireDate: '2022-03-01' }).parts.tenureE4).toBe(10000);
    expect(seasonMultiplier({ ...base, hireDate: '2010-01-15' }).parts.tenureE4).toBe(10000);
  });

  test('a hire after Mar 1 of the season year has no tenure', () => {
    expect(seasonMultiplier({ ...base, hireDate: '2026-03-02' }).parts.tenureE4).toBe(0);
  });

  test('Feb 29 hire reaches a year of service on Mar 1', () => {
    expect(seasonMultiplier({ ...base, hireDate: '2024-02-29', asOf: '2025-09-01' }).parts.tenureE4).toBe(2500);
    expect(seasonMultiplier({ ...base, hireDate: '2024-02-29', asOf: '2028-09-01' }).parts.tenureE4).toBe(10000);
    expect(seasonMultiplier({ ...base, hireDate: '2023-02-28', asOf: '2024-09-01' }).parts.tenureE4).toBe(2500);
  });

  test('review rate: 10% -> 0, 25% -> 0.5, linear between, clamped outside', () => {
    const r = (reviewRateBps) => part({ reviewRateBps }, 'reviewRateE4');
    expect(r(0)).toBe(0);
    expect(r(500)).toBe(0);
    expect(r(1000)).toBe(0);
    expect(r(1750)).toBe(2500);
    expect(r(2500)).toBe(5000);
    expect(r(4000)).toBe(5000);
    expect(r(10000)).toBe(5000);
  });

  test('review part rounds half-up once to ten-thousandths (exact rational x 10/3)', () => {
    const r = (reviewRateBps) => part({ reviewRateBps }, 'reviewRateE4');
    expect(r(1001)).toBe(3); // 3.33 -> 3
    expect(r(1002)).toBe(7); // 6.67 -> 7
    expect(r(1003)).toBe(10); // 10.0 exact
    expect(r(1500)).toBe(1667); // 1666.67 -> 1667
  });

  test('review rate must be an integer number of basis points', () => {
    const bad = (reviewRateBps) => codeOf(() => seasonMultiplier({ hireDate: '2025-01-01', ...base, reviewRateBps }));
    expect(bad(1000.45)).toBe('INVALID_REVIEW_RATE');
    expect(bad(0.25)).toBe('INVALID_REVIEW_RATE');
    expect(bad(-1)).toBe('INVALID_REVIEW_RATE');
    expect(bad(10001)).toBe('INVALID_REVIEW_RATE');
    expect(bad('2500')).toBe('INVALID_REVIEW_RATE');
    expect(bad(NaN)).toBe('INVALID_REVIEW_RATE');
    expect(bad(undefined)).toBe('INVALID_REVIEW_RATE');
  });

  test('level: 0.25 per level above entry, capped at 0.75', () => {
    const l = (level) => part({ level }, 'levelE4');
    expect(l(1)).toBe(0);
    expect(l(2)).toBe(2500);
    expect(l(4)).toBe(7500);
    expect(l(9)).toBe(7500);
  });

  test('the maximum total is 3.25 (32500)', () => {
    const r = seasonMultiplier({ hireDate: '2010-01-01', asOf: '2026-09-01', reviewRateBps: 5000, level: 6 });
    expect(r.multiplierE4).toBe(32500);
    expect(MULTIPLIER_MAX_E4).toBe(32500);
    expect(MULTIPLIER_MIN_E4).toBe(10000);
  });

  test('returns integers only', () => {
    const r = seasonMultiplier({ hireDate: '2024-03-01', asOf: '2026-09-01', reviewRateBps: 1337, level: 3 });
    [r.multiplierE4, ...Object.values(r.parts)].forEach((n) => expect(Number.isInteger(n)).toBe(true));
    expect(r.multiplierE4).toBe(r.parts.baseE4 + r.parts.tenureE4 + r.parts.reviewRateE4 + r.parts.levelE4);
  });

  test('accepts a Date for asOf and hireDate (ET calendar date)', () => {
    const r = seasonMultiplier({ ...base, hireDate: new Date('2025-03-01T17:00:00Z'), asOf: new Date('2026-09-01T16:00:00Z') });
    expect(r.parts.tenureE4).toBe(2500);
  });

  test('bad input throws', () => {
    const ok = { ...base, hireDate: '2025-01-01' };
    expect(codeOf(() => seasonMultiplier({ ...ok, hireDate: '2025-02-30' }))).toBe('INVALID_HIRE_DATE');
    expect(codeOf(() => seasonMultiplier({ ...ok, hireDate: undefined }))).toBe('INVALID_HIRE_DATE');
    expect(codeOf(() => seasonMultiplier({ ...ok, hireDate: '2027-01-01' }))).toBe('INVALID_HIRE_DATE');
    expect(codeOf(() => seasonMultiplier({ ...ok, asOf: 'soon' }))).toBe('INVALID_AS_OF');
    expect(codeOf(() => seasonMultiplier({ ...ok, level: 0 }))).toBe('INVALID_LEVEL');
    expect(codeOf(() => seasonMultiplier({ ...ok, level: 1.5 }))).toBe('INVALID_LEVEL');
  });
});

describe('seasonBonusCents', () => {
  const ok = { score: 90, grossCentsMarToAug: 1000000, multiplierE4: 10000 };

  test('multiplier 1.0, score 90, 1,000,000 gross is exactly 40,000', () => {
    expect(seasonBonusCents(ok)).toBe(40000);
  });

  test('band rate x gross x multiplier', () => {
    expect(seasonBonusCents({ ...ok, score: 95, multiplierE4: 20000 })).toBe(80000);
    expect(seasonBonusCents({ ...ok, score: 85 })).toBe(25000);
    expect(seasonBonusCents({ ...ok, score: 70, multiplierE4: 32500 })).toBe(32500);
  });

  test('below the lowest cut line pays nothing', () => {
    expect(seasonBonusCents({ ...ok, score: 69.99, multiplierE4: 30000 })).toBe(0);
  });

  test('rounds half-up to the cent, once', () => {
    const c = (grossCentsMarToAug, multiplierE4 = 10000) => seasonBonusCents({ score: 75, grossCentsMarToAug, multiplierE4 });
    expect(c(150)).toBe(2); // 1.5 -> 2
    expect(c(149)).toBe(1); // 1.49 -> 1
    expect(c(50)).toBe(1); // 0.5 -> 1
    expect(c(49)).toBe(0); // 0.49 -> 0
    expect(c(250)).toBe(3); // 2.5 -> 3
    expect(c(100, 15000)).toBe(2); // 1% of 100 x 1.5 = 1.5 -> 2
    expect(c(100, 14999)).toBe(1); // 1.4999 -> 1
    // 4% of 1250 x 1.1 = 55 exactly; 4% of 1251 x 1.1 = 55.044
    expect(seasonBonusCents({ ...ok, grossCentsMarToAug: 1250, multiplierE4: 11000 })).toBe(55);
    expect(seasonBonusCents({ ...ok, grossCentsMarToAug: 1251, multiplierE4: 11000 })).toBe(55);
  });

  test('custom cut lines move the band', () => {
    expect(seasonBonusCents({ ...ok, cutLines: { top: 95, mid: 85, low: 75 } })).toBe(25000);
  });

  test('bad input throws', () => {
    expect(codeOf(() => seasonBonusCents({ ...ok, score: 101 }))).toBe('INVALID_SCORE');
    expect(codeOf(() => seasonBonusCents({ ...ok, grossCentsMarToAug: 10.5 }))).toBe('INVALID_GROSS');
    expect(codeOf(() => seasonBonusCents({ ...ok, grossCentsMarToAug: -1 }))).toBe('INVALID_GROSS');
    expect(codeOf(() => seasonBonusCents({ ...ok, grossCentsMarToAug: '1000' }))).toBe('INVALID_GROSS');
    expect(codeOf(() => seasonBonusCents({ ...ok, multiplierE4: 9999 }))).toBe('INVALID_MULTIPLIER');
    expect(codeOf(() => seasonBonusCents({ ...ok, multiplierE4: 32501 }))).toBe('INVALID_MULTIPLIER');
    expect(codeOf(() => seasonBonusCents({ ...ok, multiplierE4: 10000.5 }))).toBe('INVALID_MULTIPLIER');
    expect(codeOf(() => seasonBonusCents({ ...ok, multiplierE4: 1 }))).toBe('INVALID_MULTIPLIER');
    expect(codeOf(() => seasonBonusCents({ ...ok, multiplierE4: undefined }))).toBe('INVALID_MULTIPLIER');
    expect(codeOf(() => seasonBonusCents({ ...ok, cutLines: { top: 1, mid: 2, low: 3 } }))).toBe('INVALID_CUT_LINES');
    expect(codeOf(() => seasonBonusCents({ ...ok, cutLines: null }))).toBe('INVALID_CUT_LINES');
  });
});

describe('options objects are validated before use', () => {
  test.each([null, undefined, 'x', 5, [], [1]])('seasonMultiplier, seasonBonusCents, stayBonus reject %p', (bad) => {
    expect(codeOf(() => seasonMultiplier(bad))).toBe('INVALID_OPTIONS');
    expect(codeOf(() => seasonBonusCents(bad))).toBe('INVALID_OPTIONS');
    expect(codeOf(() => stayBonus(bad))).toBe('INVALID_OPTIONS');
  });

  test('null into every export throws a typed error', () => {
    expect(codeOf(() => scoreBand(null))).toBe('INVALID_SCORE');
    expect(codeOf(() => scoreBand(90, null))).toBe('INVALID_CUT_LINES');
    expect(codeOf(() => weightedScore(null))).toBe('INVALID_PARTS');
    expect(codeOf(() => weightedScore({ onTime: 1, audit: 1, callbacks: 1, truck: 1, ownerRating: 1 }, null))).toBe('INVALID_WEIGHTS');
    expect(codeOf(() => seasonMultiplier(null))).toBe('INVALID_OPTIONS');
    expect(codeOf(() => seasonBonusCents(null))).toBe('INVALID_OPTIONS');
    expect(codeOf(() => seasonBonusPayDate(null))).toBe('INVALID_YEAR');
    expect(codeOf(() => seasonWindow(null))).toBe('INVALID_YEAR');
    expect(codeOf(() => stayBonus(null))).toBe('INVALID_OPTIONS');
  });
});

describe('season dates', () => {
  test('window is Mar 1 to Aug 31', () => {
    expect(seasonWindow(2027)).toEqual({ start: '2027-03-01', end: '2027-08-31' });
  });

  test('pay date is the last Friday of September', () => {
    expect(seasonBonusPayDate(2027)).toBe('2027-09-24'); // Sep 30, 2027 is a Thursday
    expect(seasonBonusPayDate(2028)).toBe('2028-09-29'); // Sep 30, 2028 is a Saturday
    expect(seasonBonusPayDate(2026)).toBe('2026-09-25');
  });

  test('every pay date is a Friday in the last 7 days of September', () => {
    for (let y = 2025; y <= 2040; y += 1) {
      const d = new Date(`${seasonBonusPayDate(y)}T12:00:00Z`);
      expect(d.getUTCDay()).toBe(5);
      expect(d.getUTCMonth()).toBe(8);
      expect(d.getUTCDate()).toBeGreaterThan(23);
    }
  });

  test('bad years throw', () => {
    expect(codeOf(() => seasonBonusPayDate('2027'))).toBe('INVALID_YEAR');
    expect(codeOf(() => seasonWindow(2027.5))).toBe('INVALID_YEAR');
    expect(codeOf(() => seasonWindow(undefined))).toBe('INVALID_YEAR');
  });
});

describe('stayBonus', () => {
  const pay = 5000000; // $50,000.00

  test('before 1 year: the 1-year bonus, 2%', () => {
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2026-11-20', priorTwelveMonthsPayCents: pay }))
      .toEqual({ dueDate: '2027-03-10', rateBps: 200, cents: 100000 });
  });

  test('on the 1-year anniversary it is due that day', () => {
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2027-03-10', priorTwelveMonthsPayCents: pay }))
      .toEqual({ dueDate: '2027-03-10', rateBps: 200, cents: 100000 });
  });

  test('the day after the 1-year anniversary: next is 3 years, 4%', () => {
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2027-03-11', priorTwelveMonthsPayCents: pay }))
      .toEqual({ dueDate: '2029-03-10', rateBps: 400, cents: 200000 });
  });

  test('after 3 years: 5 years, 8%', () => {
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2029-03-11', priorTwelveMonthsPayCents: pay }))
      .toEqual({ dueDate: '2031-03-10', rateBps: 800, cents: 400000 });
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2031-03-10', priorTwelveMonthsPayCents: pay }))
      .toEqual({ dueDate: '2031-03-10', rateBps: 800, cents: 400000 });
  });

  test('after year 5: null', () => {
    expect(stayBonus({ hireDate: '2026-03-10', asOf: '2031-03-11', priorTwelveMonthsPayCents: pay })).toBeNull();
    expect(stayBonus({ hireDate: '2010-01-01', asOf: '2026-11-20', priorTwelveMonthsPayCents: pay })).toBeNull();
  });

  test('Feb 29 hire: every milestone anniversary falls on Mar 1', () => {
    const hireDate = '2024-02-29';
    expect(stayBonus({ hireDate, asOf: '2024-03-01', priorTwelveMonthsPayCents: pay }).dueDate).toBe('2025-03-01');
    expect(stayBonus({ hireDate, asOf: '2025-03-02', priorTwelveMonthsPayCents: pay }).dueDate).toBe('2027-03-01');
    expect(stayBonus({ hireDate, asOf: '2027-03-02', priorTwelveMonthsPayCents: pay }).dueDate).toBe('2029-03-01');
    // 1, 3 and 5 years after a Feb 29 hire are always common years, so each lands on Mar 1.
    expect(stayBonus({ hireDate: '2020-02-29', asOf: '2025-02-01', priorTwelveMonthsPayCents: pay }).dueDate).toBe('2025-03-01');
  });

  test('rounds half-up', () => {
    // 2% of 25 cents = 0.5 -> 1; 2% of 24 cents = 0.48 -> 0
    expect(stayBonus({ hireDate: '2026-01-01', asOf: '2026-02-01', priorTwelveMonthsPayCents: 25 }).cents).toBe(1);
    expect(stayBonus({ hireDate: '2026-01-01', asOf: '2026-02-01', priorTwelveMonthsPayCents: 24 }).cents).toBe(0);
  });

  test('bad input throws', () => {
    const ok = { hireDate: '2026-01-01', asOf: '2026-02-01', priorTwelveMonthsPayCents: 100 };
    expect(codeOf(() => stayBonus({ ...ok, hireDate: '2026-13-01' }))).toBe('INVALID_HIRE_DATE');
    expect(codeOf(() => stayBonus({ ...ok, hireDate: '2026-03-01' }))).toBe('INVALID_HIRE_DATE');
    expect(codeOf(() => stayBonus({ ...ok, asOf: null }))).toBe('INVALID_AS_OF');
    expect(codeOf(() => stayBonus({ ...ok, priorTwelveMonthsPayCents: 1.5 }))).toBe('INVALID_PAY');
    expect(codeOf(() => stayBonus({ ...ok, priorTwelveMonthsPayCents: -5 }))).toBe('INVALID_PAY');
    expect(codeOf(() => stayBonus({ ...ok, priorTwelveMonthsPayCents: undefined }))).toBe('INVALID_PAY');
  });

  test('named bonus constants are 2, 4 and 8 percent in basis points', () => {
    expect([calc.STAY_BONUS_1_YEAR_BPS, calc.STAY_BONUS_3_YEAR_BPS, calc.STAY_BONUS_5_YEAR_BPS]).toEqual([200, 400, 800]);
  });
});
