// The yearly pay statement's arithmetic (Tech Rewards Plan D5-6), with no database: the rows of `pay` add up to gross
// pay whatever the sums are, every Tech Rewards pay line kind has a row, and the year asked for is checked.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { composeStatement, parseYear } = require('../services/tech-rewards-year-statement');
const { ScoreboardError } = require('../services/tech-rewards-scoreboard');
const { TECH_REWARD_KINDS } = require('../services/payroll-pay-lines');

const TECH = { id: '00000000-0000-4000-8000-000000000001', name: 'Sample Alpha', pay_rate: '25.00' };
const compose = (sums, rewards = {}, extra = {}) => composeStatement({ technician: TECH, year: 2027, currentYear: 2027, sums, rewards, ...extra });
const payRowsTotal = (statement) => Object.entries(statement.pay)
  .filter(([key]) => key !== 'grossCents').reduce((total, [, value]) => total + value, 0);

describe('composeStatement', () => {
  // PostgreSQL returns a bigint sum as text.
  const SUMS = {
    checkCount: 3, firstPayDate: '2027-01-08', lastPayDate: '2027-12-24',
    gross: '1000000', regularPay: '700000', overtimePay: '50000', ptoPay: '20000', holidayPay: '10000',
    commission: '60000', reviewBonus: '4500', healthAllowance: '30000', techRewards: '120000', lineOvertimePremium: '5500',
    hsaEmployer: '12000', simpleEmployer: '20000', simpleDeferral: '30000',
    federalIncomeTax: '90000', socialSecurity: '62000', medicare: '14500', additionalMedicare: '0', net: '803500',
  };
  const REWARDS = { season_bonus: '80000', stay_bonus: '10000', december_gift: '30000' };

  test('names each part of gross pay, what Waves paid on top, the taxes, the savings and net pay', () => {
    expect(compose(SUMS, REWARDS, { years: [2027, 2026] })).toEqual({
      technician: { id: TECH.id, name: 'Sample Alpha' },
      year: 2027,
      years: [2027, 2026],
      checkCount: 3,
      firstPayDate: '2027-01-08',
      lastPayDate: '2027-12-24',
      pay: {
        regularPayCents: 700000, overtimePayCents: 50000, ptoPayCents: 20000, holidayPayCents: 10000,
        commissionCents: 60000, reviewBonusCents: 4500, healthAllowanceCents: 30000,
        seasonBonusCents: 80000, stayBonusCents: 10000, decemberGiftCents: 30000,
        lineOvertimePremiumCents: 5500, otherCents: 0, grossCents: 1000000,
      },
      fromWaves: { simpleEmployerCents: 20000, hsaEmployerCents: 12000 },
      totalCents: 1032000,
      withheld: { federalIncomeTaxCents: 90000, socialSecurityCents: 62000, medicareCents: 14500, totalCents: 166500 },
      simpleSavingsCents: 30000,
      netCents: 803500,
    });
  });

  test('gross less the taxes and the savings is net pay, as payroll-calc.js works a paycheck out', () => {
    const s = compose(SUMS, REWARDS);
    expect(s.pay.grossCents - s.withheld.totalCents - s.simpleSavingsCents).toBe(s.netCents);
  });

  test('carries only the technician\'s id and name', () => {
    expect(compose(SUMS).technician).toEqual({ id: TECH.id, name: 'Sample Alpha' });
  });

  test('the rows of pay add up to gross pay: a part no row names goes to "other", never away', () => {
    // the bonus lines on file name 110,000 of the 120,000 the checks stored as Tech Rewards pay
    const short = compose(SUMS, { season_bonus: '80000', december_gift: '30000' });
    expect(short.pay.otherCents).toBe(10000);
    expect(payRowsTotal(short)).toBe(short.pay.grossCents);
    // no line on file at all
    const none = compose(SUMS);
    expect(none.pay).toMatchObject({ seasonBonusCents: 0, stayBonusCents: 0, decemberGiftCents: 0, otherCents: 120000 });
    expect(payRowsTotal(none)).toBe(none.pay.grossCents);
    // lines on file for more than the checks stored: the difference shows as a negative "other", and the rows still add up
    const over = compose(SUMS, { ...REWARDS, stay_bonus: '15000' });
    expect(over.pay.otherCents).toBe(-5000);
    expect(payRowsTotal(over)).toBe(over.pay.grossCents);
  });

  test('every Tech Rewards pay line kind has its own row', () => {
    for (const kind of TECH_REWARD_KINDS) {
      const one = compose({ gross: '700', techRewards: '700' }, { [kind]: '700' });
      expect(one.pay.otherCents).toBe(0);
      expect(payRowsTotal(one)).toBe(700);
    }
  });

  test('Medicare is one figure: the regular tax and the additional 0.9% together', () => {
    const s = compose({ ...SUMS, additionalMedicare: '900' });
    expect(s.withheld.medicareCents).toBe(15400);
    expect(s.withheld.totalCents).toBe(167400);
  });

  test('a year with no paycheck is all zeros with no pay dates', () => {
    const empty = compose({ checkCount: 0, firstPayDate: null, lastPayDate: null, gross: '0', net: '0' });
    expect(empty).toMatchObject({ checkCount: 0, firstPayDate: null, lastPayDate: null, totalCents: 0, netCents: 0, simpleSavingsCents: 0 });
    expect(Object.values(empty.pay).every((value) => value === 0)).toBe(true);
    expect(empty.withheld.totalCents).toBe(0);
  });

  test('the picker\'s years: every year with a paycheck, this year and the year shown, newest first, once each', () => {
    expect(compose(SUMS, {}, { years: [2026, 2027] }).years).toEqual([2027, 2026]);
    expect(composeStatement({ technician: TECH, year: 2024, currentYear: 2027, sums: {}, years: [2026] }).years).toEqual([2027, 2026, 2024]);
    expect(composeStatement({ technician: TECH, year: 2027, currentYear: 2027, sums: {} }).years).toEqual([2027]);
  });
});

describe('parseYear', () => {
  test('no year is the current year in Eastern time', () => {
    for (const none of [undefined, null, '']) expect(parseYear(none, '2027-01-01')).toBe(2027);
  });

  test('a four-digit year from 2020 to 2100 is taken', () => {
    expect(parseYear('2026', '2027-06-01')).toBe(2026);
    expect(parseYear(2020, '2027-06-01')).toBe(2020);
    expect(parseYear('2100', '2027-06-01')).toBe(2100);
  });

  test('anything else is a 400, never a read', () => {
    for (const bad of ['2019', '2101', '27', '20270', '2027.0', ' 2027', '2027-01-01', 'abcd', '2e3', ['2027', '2026'], {}]) {
      expect(() => parseYear(bad, '2027-06-01')).toThrow(ScoreboardError);
      try { parseYear(bad, '2027-06-01'); } catch (err) { expect(err).toMatchObject({ status: 400, code: 'INVALID_YEAR' }); }
    }
  });
});
