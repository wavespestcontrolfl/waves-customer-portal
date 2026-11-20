// Tech Rewards Plan D5-4: the pure parts of the scoreboard service (which season, review rate, the compose step),
// with synthetic fixtures. The reads run against Postgres in tech-rewards-scoreboard-postgres.test.js.
jest.mock('../models/db', () => jest.fn());

const { composeScoreboard, pickSeason, reviewRateBps, earnedGrossCents } = require('../services/tech-rewards-scoreboard');

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
    commission: { paidCents: 20000, pendingCents: 10000 },
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

describe('earnedGrossCents (work-week basis, edge weeks prorated)', () => {
  const week = (weekStart, grossCents) => ({ weekStart, grossCents });
  test('whole weeks inside the window count in full', () => {
    expect(earnedGrossCents([week('2026-03-02', 70000), week('2026-08-24', 70000)], '2026-03-01', '2026-08-31')).toBe(140000);
  });
  test('the week of Aug 31 (Mon Aug 31 - Sun Sep 6) counts one day in seven', () => {
    expect(earnedGrossCents([week('2026-08-31', 70000)], '2026-03-01', '2026-08-31')).toBe(10000);
  });
  test('the week ending Mar 1 (Mon Feb 23 - Sun Mar 1) counts one day in seven; the week before it counts nothing', () => {
    expect(earnedGrossCents([week('2026-02-23', 70000), week('2026-02-16', 70000)], '2026-03-01', '2026-08-31')).toBe(10000);
  });
  test('a mid-week edge counts the in-window days (Thu Aug 31 2028: Mon-Thu = 4 of 7), rounded half up', () => {
    expect(earnedGrossCents([week('2028-08-28', 100000)], '2028-03-01', '2028-08-31')).toBe(57143);
  });
  const mins = (...pairs) => pairs.map(([workDate, minutes]) => ({ workDate, minutes }));
  test('an edge week whose hours all fall inside the window counts in full', () => {
    // Mon Aug 31 week: all the work was done Mon-Tue Aug 31 (Mon) ... window ends Aug 31, so use the Mar 1 edge: week of Feb 23, work done only Sun Mar 1
    expect(earnedGrossCents([{ weekStart: '2026-02-23', grossCents: 70000, dayMinutes: mins(['2026-03-01', 480]) }], '2026-03-01', '2026-08-31')).toBe(70000);
  });
  test('an edge week whose hours all fall outside the window counts nothing', () => {
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 70000, dayMinutes: mins(['2026-09-01', 480], ['2026-09-02', 480]) }], '2026-03-01', '2026-08-31')).toBe(0);
  });
  test('an edge week with hours on both sides splits by paid minutes, not by days', () => {
    // Mon Aug 31 8 h inside; Tue-Wed Sep 1-2 16 h outside: one third
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 50000, dayMinutes: mins(['2026-08-31', 480], ['2026-09-01', 480], ['2026-09-02', 480]) }], '2026-03-01', '2026-08-31')).toBe(16667);
    // days/7 would have said one seventh
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 50000 }], '2026-03-01', '2026-08-31')).toBe(7143);
  });
  test('an edge week with no worked time on record (or only zero minutes) falls back to days / 7', () => {
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 70000, dayMinutes: [] }], '2026-03-01', '2026-08-31')).toBe(10000);
    expect(earnedGrossCents([{ weekStart: '2026-08-31', grossCents: 70000, dayMinutes: mins(['2026-08-31', 0]) }], '2026-03-01', '2026-08-31')).toBe(10000);
  });
  test('a week fully inside ignores its minutes', () => {
    expect(earnedGrossCents([{ weekStart: '2026-04-06', grossCents: 70000, dayMinutes: mins(['2026-04-06', 480]) }], '2026-03-01', '2026-08-31')).toBe(70000);
  });

  test('both edges prorate in the stay bonus window, and a week after the window is out', () => {
    // window 2026-04-01 (Wed) .. 2026-11-20 (Fri): Mon Mar 30 week has 5 of 7 days in; Mon Nov 16 week has 5 of 7 in; Nov 23 is out
    expect(earnedGrossCents([week('2026-03-30', 70000), week('2026-11-16', 70000), week('2026-11-23', 70000)], '2026-04-01', '2026-11-20')).toBe(100000);
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
    expect(board.commission).toEqual({ year: 2026, yearToDateCents: 30000, paidCents: 20000, pendingCents: 10000 });
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
    expect(board.stayBonus).toEqual({ dueDate: '2028-04-01', years: 3, rateBps: 400, estimateCents: null, estimate: true, earningsStart: '2027-04-01' });
  });

  test('an open window gives an amount, with the window start named', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2025-12-01' }, priorYearGrossCents: 230000 }));
    expect(board.stayBonus).toEqual({ dueDate: '2026-12-01', years: 1, rateBps: 200, estimateCents: 4600, estimate: true, earningsStart: '2025-12-01' });
  });

  test('past the 5-year bonus there is no next stay bonus', () => {
    const board = composeScoreboard(inputs({ technician: { id: 'tech-1', name: 'Sample Alpha', hireDate: '2018-01-01' } }));
    expect(board.stayBonus).toBeNull();
  });

  test('the output carries no customer fields', () => {
    expect(JSON.stringify(composeScoreboard(inputs()))).not.toMatch(/customer|address|phone|email/i);
  });
});
