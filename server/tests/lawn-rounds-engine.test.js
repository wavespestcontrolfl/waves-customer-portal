/**
 * Lawn 9x rounds, PR 2 (engine, still inert): every server path that computes,
 * extends, tops up, re-seeds, moves or audits a series handles lawn_rounds_9 —
 * one visit in each of nine fixed rounds a year, never two in a round and never
 * a round skipped. PR 1 (lawn-rounds.test.js) pins the calendar and the seeder;
 * this file pins the walks that hop from the latest visit (admin-schedule),
 * the rebooker's projector and guards, the audit and the dispatch window.
 * DATABASE_URL suites are not needed: every path below is pure or fake-knex.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next() };
});

const fs = require('fs');
const path = require('path');
const {
  LAWN_ROUNDS_9, roundOf, roundOrdinal, roundTaken, lawnRoundDate, lawnRoundDateFrom,
} = require('../services/lawn-rounds');
const Seeder = require('../services/recurring-appointment-seeder');
const rebooker = require('../services/rebooker');
const adminSchedule = require('../routes/admin-schedule');
const audit = require('../services/recurring-schedule-audit');
const { reseedAnchorFloor } = require('../services/recurring-series-cancel-reseed');
const { _internals: { searchWindow } } = require('../services/auto-dispatch/candidate-slots');

const {
  planSeriesExtendDates, planSpawnChildDates, planCadenceRewriteTargets, seriesExtendAnchor,
  seasonalSafeShift, recurrenceOrdinalOptions, seriesDateTaken,
} = adminSchedule._test;

// Only Date is faked (the planners floor candidates at today); timers stay real.
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2027-01-05T12:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
      'cancelIdleCallback', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => { jest.useRealTimers(); });

const weekday = (s) => new Date(`${s}T12:00:00Z`).getUTCDay();
const ord = (s) => roundOrdinal(s);
const inItsRound = (date, k, anchor) => {
  const round = roundOf(lawnRoundDate(anchor, k));
  return date >= round.start && date <= round.end;
};

describe('anchored hop: the series offset survives extension one visit at a time', () => {
  test('hopping from the latest visit with the anchor lands where the seeded series did', () => {
    for (const anchor of ['2027-01-12', '2027-03-17', '2027-04-23', '2027-11-10', '2027-12-24']) {
      let d = anchor;
      for (let k = 1; k <= 20; k++) {
        d = lawnRoundDateFrom(anchor, d, 1);
        expect(d).toBe(lawnRoundDate(anchor, k));
      }
    }
  });

  test('without the anchor each hop drifts toward the end of its round (why the anchor is threaded)', () => {
    let d = '2027-01-12';
    for (let k = 1; k <= 9; k++) d = lawnRoundDate(d, 1);
    expect(d).not.toBe(lawnRoundDate('2027-01-12', 9));
  });

  test('i = 0 is the base visit itself, and an unreadable anchor hops from the base', () => {
    expect(lawnRoundDateFrom('2027-01-12', '2027-05-12', 0)).toBe('2027-05-12');
    expect(lawnRoundDateFrom(undefined, '2027-05-12', 1)).toBe(lawnRoundDate('2027-05-12', 1));
    expect(lawnRoundDateFrom('nope', '2027-05-12', 1)).toBe(lawnRoundDate('2027-05-12', 1));
  });

  test('roundTaken: a visit anywhere in the round owns it', () => {
    expect(roundTaken(new Set(['2027-03-16']), '2027-04-20')).toBe(true);
    expect(roundTaken(new Set(['2027-03-14']), '2027-03-15')).toBe(false);
    expect(roundTaken([], '2027-03-15')).toBe(false);
  });

  test('the three nextRecurringDate copies agree, with and without the anchor', () => {
    const copies = [Seeder._internals.nextRecurringDate, rebooker.nextRecurringDate, adminSchedule.nextRecurringDate];
    for (const base of ['2027-04-02', '2027-12-24']) {
      for (let i = 0; i <= 9; i++) {
        for (const opts of [{}, { roundAnchor: '2027-01-12' }]) {
          const [a, b, c] = copies.map((fn) => fn(base, LAWN_ROUNDS_9, i, opts));
          expect([b, c]).toEqual([a, a]);
        }
      }
    }
  });
});

describe('admin-schedule: extension across the program-year wrap', () => {
  const anchor = '2027-03-17'; // Wed, round 3 of 2027
  const rOpts = recurrenceOrdinalOptions(anchor, {});

  test('recurrenceOrdinalOptions carries the series anchor for the rounds walk', () => {
    expect(rOpts.roundAnchor).toBe(anchor);
  });

  test('from the round 9 visit the next date is round 1 of the next program year, on the anchor offset', () => {
    const latest = lawnRoundDate(anchor, 6); // round 9 of 2027
    expect(roundOf(latest)).toMatchObject({ round: 9, programYear: 2027 });
    const dates = planSeriesExtendDates({
      baseDateStr: latest, pattern: LAWN_ROUNDS_9, rOpts, skip: false, dir: 'forward',
      seen: new Set([latest]), need: 3, blackoutDates: null,
    });
    expect(dates).toEqual([7, 8, 9].map((k) => lawnRoundDate(anchor, k)));
    expect(roundOf(dates[0])).toMatchObject({ round: 1, programYear: 2028 });
    expect(dates.map(ord)).toEqual([ord(latest) + 1, ord(latest) + 2, ord(latest) + 3]);
  });

  test('a long walk from the latest visit never drifts from the seeded dates', () => {
    const dates = planSeriesExtendDates({
      baseDateStr: anchor, pattern: LAWN_ROUNDS_9, rOpts, skip: false, dir: 'forward',
      seen: new Set([anchor]), need: 12, blackoutDates: null,
    });
    expect(dates).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => lawnRoundDate(anchor, k)));
  });

  test('a visit already in a round, on another day, owns it: no second visit, no skipped round', () => {
    // The customer moved the round 6 visit to the last day of its round.
    const moved = roundOf(lawnRoundDate(anchor, 3)).end;
    const dates = planSeriesExtendDates({
      baseDateStr: anchor, pattern: LAWN_ROUNDS_9, rOpts, skip: false, dir: 'forward',
      seen: new Set([anchor, moved]), need: 4, blackoutDates: null,
    });
    expect(dates.map(ord)).toEqual([1, 2, 4, 5].map((k) => ord(anchor) + k));
    expect(new Set(dates.map(ord)).size).toBe(4);
  });

  test('seriesDateTaken: exact date for every pattern, the whole round only for lawn rounds', () => {
    const seen = new Set(['2027-03-16']);
    expect(seriesDateTaken(seen, LAWN_ROUNDS_9, '2027-04-10')).toBe(true);
    expect(seriesDateTaken(seen, LAWN_ROUNDS_9, '2027-04-24')).toBe(false);
    expect(seriesDateTaken(seen, 'monthly', '2027-04-10')).toBe(false);
    expect(seriesDateTaken(seen, 'monthly', '2027-03-16')).toBe(true);
  });

  test('a stale series fast-forwards along its own rounds, then continues one visit per round', () => {
    // Series anchored 2026-03-18; its last visit is the 2026 round 9 date and today (pinned)
    // is 2027-01-05, in round 1 of 2027. The anchor moves to the last round date on or before
    // today, on the series offset, and the walk resumes from it.
    const a = '2026-03-18';
    const opts = { ...recurrenceOrdinalOptions(a, {}), roundAnchor: a };
    const base = seriesExtendAnchor({ scheduled_date: lawnRoundDate(a, 6) }, LAWN_ROUNDS_9, opts);
    expect(base).toBe(lawnRoundDate(a, 7));
    const dates = planSeriesExtendDates({
      baseDateStr: base, pattern: LAWN_ROUNDS_9, rOpts: opts, skip: false, dir: 'forward',
      seen: new Set([base]), need: 2, blackoutDates: null,
    });
    expect(dates).toEqual([lawnRoundDate(a, 8), lawnRoundDate(a, 9)]);
  });

  test('a rounds series edit (cadence rewrite) re-dates pending visits one per round from the new anchor', () => {
    const newAnchor = '2027-02-10'; // Wed, round 2
    const pendingChildren = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { childTargets } = planCadenceRewriteTargets({
      baseDateStr: newAnchor, pattern: LAWN_ROUNDS_9, rOpts: { roundAnchor: newAnchor }, skip: true, dir: 'forward',
      pendingChildren, pendingBoosters: [], boosterMonths: [], seenDates: new Set([newAnchor]), blackoutDates: null,
    });
    expect([...childTargets.values()]).toEqual([1, 2, 3].map((k) => lawnRoundDate(newAnchor, k)));
  });

  test('a spawned series places one visit per round', () => {
    const dates = planSpawnChildDates({
      baseDateStr: anchor, pattern: LAWN_ROUNDS_9, rOpts, skip: true, dir: 'forward',
      seen: new Set([anchor]), spawnCount: 9, spawnTarget: 8, blackoutDates: null,
    });
    expect(dates).toHaveLength(8);
    expect(dates.map(ord)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((k) => ord(anchor) + k));
  });
});

describe('admin-schedule: a weekend or blackout shift never carries a visit into the next round', () => {
  test('a Sunday on the last day of a round, forward weekend shift: back to the Friday inside the round', () => {
    // Round 2 of 2027 ends Sun Mar 14; Monday Mar 15 is round 3.
    expect(weekday('2027-03-14')).toBe(0);
    const shifted = seasonalSafeShift('2027-03-14', LAWN_ROUNDS_9, true, 'forward', null);
    expect(shifted).toBe('2027-03-12');
    expect(roundOf(shifted).round).toBe(2);
  });

  test('a blackout nudge past the round edge walks back into the round', () => {
    // Mar 14 is closed; the nudge goes forward to Mar 15 (round 3); the clamp walks back to Sat Mar 13.
    expect(seasonalSafeShift('2027-03-14', LAWN_ROUNDS_9, false, 'forward', { dates: new Set(['2027-03-14']) })).toBe('2027-03-13');
  });

  test('other patterns are untouched', () => {
    expect(seasonalSafeShift('2027-03-14', 'monthly', true, 'forward', null)).toBe('2027-03-15');
  });

  test('a weekend-anchored series with the weekend rule still gets exactly one visit per round', () => {
    for (const anchor of ['2027-02-06', '2027-03-13', '2027-04-17', '2027-06-12', '2027-08-21', '2027-10-02', '2027-12-18']) {
      const dates = planSeriesExtendDates({
        baseDateStr: anchor, pattern: LAWN_ROUNDS_9, rOpts: { roundAnchor: anchor }, skip: true, dir: 'forward',
        seen: new Set([anchor]), need: 9, blackoutDates: null,
      });
      expect(dates).toHaveLength(9);
      dates.forEach((d, idx) => {
        expect(ord(d)).toBe(ord(anchor) + idx + 1);
        expect([0, 6]).not.toContain(weekday(d));
        expect(inItsRound(d, idx + 1, anchor)).toBe(true);
      });
    }
  });
});

describe('reseed after a cancel adds the next round after the series end', () => {
  const anchor = '2027-03-17';
  const rows = (cancelledIdx) => [0, 1, 2, 3, 4].map((k) => ({
    id: `r${k}`, is_recurring: true, recurring_pattern: LAWN_ROUNDS_9,
    scheduled_date: lawnRoundDate(anchor, k), status: k === cancelledIdx ? 'cancelled' : 'pending',
  }));

  test('a mid-series cancel appends one visit in the round after the last visit', () => {
    const series = rows(2);
    const floor = reseedAnchorFloor(series, 'r2');
    expect(floor.scheduled_date).toBe(lawnRoundDate(anchor, 4));
    const [added] = planSeriesExtendDates({
      baseDateStr: seriesExtendAnchor(floor, LAWN_ROUNDS_9, { roundAnchor: anchor }), pattern: LAWN_ROUNDS_9,
      rOpts: { roundAnchor: anchor }, skip: false, dir: 'forward',
      seen: new Set(series.map((r) => r.scheduled_date)), need: 1, blackoutDates: null,
    });
    expect(added).toBe(lawnRoundDate(anchor, 5));
    expect(ord(added)).toBe(ord(series[4].scheduled_date) + 1);
  });

  test('cancelling the tail appends past it, never onto the cancelled round', () => {
    const series = rows(4);
    const floor = reseedAnchorFloor(series, 'r4');
    expect(floor.scheduled_date).toBe(lawnRoundDate(anchor, 4));
    const [added] = planSeriesExtendDates({
      baseDateStr: seriesExtendAnchor(floor, LAWN_ROUNDS_9, { roundAnchor: anchor }), pattern: LAWN_ROUNDS_9,
      rOpts: { roundAnchor: anchor }, skip: false, dir: 'forward',
      seen: new Set(series.map((r) => r.scheduled_date)), need: 1, blackoutDates: null,
    });
    expect(ord(added)).toBe(ord(lawnRoundDate(anchor, 4)) + 1);
  });

  test('the in-term gap picker is not used for a rounds series (it can aim at a round that has its visit)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(src).toMatch(/parent\.recurring_pattern === LAWN_ROUNDS_9 \? null : require\('\.\.\/services\/recurring-series-cancel-reseed'\)\.pickInTermReseedDate/);
  });
});

describe('rebooker: a round visit stays in its round', () => {
  const { leavesOwnRound, roundSweepHasGap } = rebooker;

  test('leavesOwnRound: inside the round is fine, either side is not, other patterns are free', () => {
    // Round 3 of 2027 is Mar 15 - Apr 23; today (pinned) is 2027-01-05.
    expect(leavesOwnRound(LAWN_ROUNDS_9, '2027-03-20', '2027-04-23')).toBe(false);
    expect(leavesOwnRound(LAWN_ROUNDS_9, '2027-03-20', '2027-03-15')).toBe(false);
    expect(leavesOwnRound(LAWN_ROUNDS_9, '2027-03-20', '2027-04-24')).toBe(true);
    expect(leavesOwnRound(LAWN_ROUNDS_9, '2027-03-20', '2027-03-14')).toBe(true);
    expect(leavesOwnRound('quarterly', '2027-03-20', '2027-08-01')).toBe(false);
  });

  test('a round that has ended is a missed visit for the office to place, not a round to hold', () => {
    expect(leavesOwnRound(LAWN_ROUNDS_9, '2026-12-01', '2027-02-10', '2027-01-05')).toBe(false);
  });

  test('a series move is refused when the rows are not in consecutive rounds', () => {
    const pos = (row) => row.d;
    const consecutive = [0, 1, 2].map((k) => ({ d: lawnRoundDate('2027-03-17', k) }));
    const gap = [0, 1, 3].map((k) => ({ d: lawnRoundDate('2027-03-17', k) }));
    const doubled = [{ d: '2027-03-17' }, { d: '2027-04-01' }, { d: lawnRoundDate('2027-03-17', 1) }];
    expect(roundSweepHasGap(consecutive, 0, pos)).toBe(false);
    expect(roundSweepHasGap(gap, 0, pos)).toBe(true);
    expect(roundSweepHasGap(doubled, 0, pos)).toBe(true);
    expect(roundSweepHasGap(gap, 2, pos)).toBe(false);
  });

  describe('series projector', () => {
    const service = { scheduled_date: '2027-03-12', customer_id: 'c', skip_weekends: true };
    const make = (newDate, extra = {}) => rebooker.makeSeriesProjector({
      service, parent: { recurring_pattern: LAWN_ROUNDS_9, customer_id: 'c', skip_weekends: true, ...extra },
      newDate, seriesDateStr: newDate, prefersNoWeekends: true,
    });

    test('every projected visit sits in its own round, one per round, off weekends', async () => {
      for (const anchor of ['2027-03-12', '2027-03-19', '2027-04-23', '2027-12-24']) {
        const { projectOccurrenceDate } = await make(anchor);
        const dates = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => projectOccurrenceDate(i));
        dates.forEach((d, i) => {
          expect(ord(d)).toBe(ord(anchor) + i);
          if (i > 0) expect([0, 6]).not.toContain(weekday(d));
        });
      }
    });

    test('closed days that eat the end of a round do not push the visit into the next one', async () => {
      // Anchor Fri Mar 12 (round 2): occurrence 1 is Fri Apr 23, the last day of round 3.
      // Close it: the nudge goes forward to Mon Apr 26 (round 4); the clamp walks back to Thu Apr 22.
      const anchor = '2027-03-12';
      expect(lawnRoundDate(anchor, 1)).toBe('2027-04-23');
      const { projectOccurrenceDate } = await rebooker.makeSeriesProjector({
        service, parent: { recurring_pattern: LAWN_ROUNDS_9, customer_id: 'c', skip_weekends: true },
        newDate: anchor, seriesDateStr: anchor, prefersNoWeekends: true,
        closedDays: { dates: new Set(['2027-04-23']) },
      });
      expect(projectOccurrenceDate(1)).toBe('2027-04-22');
      // Later occurrences are untouched.
      expect(projectOccurrenceDate(2)).toBe(lawnRoundDate(anchor, 2));
    });

    test('two occurrences never share a day, and a collision stays in the round', async () => {
      const anchor = '2027-03-12';
      const { cadenceSlotDate } = await make(anchor);
      const slots = [0, 1, 2, 3].map((i) => cadenceSlotDate(i));
      expect(new Set(slots).size).toBe(4);
      slots.forEach((d, i) => expect(ord(d)).toBe(ord(anchor) + i));
    });
  });

  describe('wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/rebooker.js'), 'utf8');
    test('the single move, the series re-anchor and the offered options all hold the round', () => {
      expect(src).toMatch(/initiatedBy !== 'admin' && leavesOwnRound\(service\.recurring_pattern, service\.scheduled_date, newDateStr\)/);
      expect(src).toMatch(/initiatedBy !== 'admin' && leavesOwnRound\(parent\.recurring_pattern, service\.scheduled_date, seriesDateStr\)/);
      expect(src).toMatch(/reason && leavesOwnRound\(service\.recurring_pattern, service\.scheduled_date, dateStr\)/);
    });
  });
});

describe('audit: a visit outside its round is the finding', () => {
  const anchor = '2027-03-17';
  const series = (count) => Array.from({ length: count }, (_, k) => ({ scheduled_date: lawnRoundDate(anchor, k) }));

  test('a correct series passes, whatever the day inside each round', () => {
    expect(audit.lawnRoundsOutOfRound(series(9))).toBe(false);
    // A move or weekend shift inside the round is not drift.
    const moved = series(9).map((row, k) => (k === 3 ? { scheduled_date: roundOf(row.scheduled_date).end } : row));
    expect(audit.lawnRoundsOutOfRound(moved)).toBe(false);
  });

  test('a visit one round late, early or doubled is flagged', () => {
    const rows = series(9);
    const late = rows.map((row, k) => (k === 4 ? { scheduled_date: lawnRoundDate(anchor, 5) } : row));
    expect(audit.lawnRoundsOutOfRound(late)).toBe(true);
    const skipped = rows.filter((_, k) => k !== 2); // a missing round shifts every later visit
    expect(audit.lawnRoundsOutOfRound(skipped)).toBe(true);
    const doubled = [...rows.slice(0, 3), { scheduled_date: '2027-04-30' }, ...rows.slice(3)].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    expect(audit.lawnRoundsOutOfRound(doubled)).toBe(true);
  });

  test('an exception with no recorded position breaks the count instead of flagging the run after it', () => {
    const rows = series(6);
    rows.splice(2, 0, { scheduled_date: '2027-05-20', date_exception: true });
    expect(audit.lawnRoundsOutOfRound(rows)).toBe(false);
  });

  test('the accepted-schedule spacing check uses it for lawn_rounds_9, and keeps the ±14 day rule elsewhere', () => {
    const base = { is_recurring: true, recurring_pattern: LAWN_ROUNDS_9, status: 'pending', customer_id: 'c' };
    const good = series(9).map((r, i) => ({ ...base, id: `v${i}`, scheduled_date: r.scheduled_date }));
    expect(audit.hasAcceptedScheduleSpacingGap(good, LAWN_ROUNDS_9, Seeder)).toBe(false);
    const bad = good.map((r, i) => (i === 5 ? { ...r, scheduled_date: lawnRoundDate(anchor, 6) } : r));
    expect(audit.hasAcceptedScheduleSpacingGap(bad, LAWN_ROUNDS_9, Seeder)).toBe(true);
  });

  test('rounds are in the min-gap table so the SQL anomaly audit reads them', () => {
    expect(audit.MIN_GAP_DAYS_BY_PATTERN[LAWN_ROUNDS_9]).toBeGreaterThan(0);
    const { sql, bindings } = audit.buildRecurringScheduleAnomalySql();
    expect(sql).toContain('intervals(pattern, min_gap_days)');
    expect(bindings).toEqual(expect.arrayContaining([LAWN_ROUNDS_9]));
  });
});

describe('auto-dispatch: the search window stops at the round edge', () => {
  const ctx = (extra = {}) => ({
    nowDate: new Date('2027-03-01T12:00:00Z'), lookaheadDays: 60, lockWindowDays: 3, dateToleranceDays: 5, ...extra,
  });
  const visit = (over) => ({ recurring_pattern: LAWN_ROUNDS_9, scheduled_date: '2027-03-12', ...over });

  test('a visit near the end of its round is not offered days in the next round', () => {
    // Round 2 ends Sun Mar 14.
    const { dateTo } = searchWindow(visit(), ctx());
    expect(dateTo).toBe('2027-03-14');
  });

  test('a visit near the start is not offered days in the previous round', () => {
    const { dateFrom } = searchWindow(visit({ scheduled_date: '2027-03-16' }), ctx());
    expect(dateFrom >= '2027-03-15').toBe(true);
  });

  test('a +/-3 day hand-off from a due date on the last day of a round stays in it', () => {
    const { dateFrom, dateTo } = searchWindow(
      visit({ scheduled_date: '2027-03-14', recurring_dispatch_due_date: '2027-03-14', window_start: null }), ctx(),
    );
    expect(dateTo).toBe('2027-03-14');
    expect(dateFrom <= dateTo).toBe(true);
  });

  test('every other pattern keeps its window', () => {
    const { dateTo } = searchWindow(visit({ recurring_pattern: 'quarterly' }), ctx());
    expect(dateTo > '2027-03-14').toBe(true);
  });
});

describe('seeder: one visit per round when a visit already sits in a round', () => {
  test('recurringDateCandidates skips a round an existing visit owns and keeps going', () => {
    const anchor = '2027-03-17';
    const owner = roundOf(lawnRoundDate(anchor, 2)).end;
    const got = [...Seeder.recurringDateCandidates(anchor, LAWN_ROUNDS_9, {
      existingDates: [owner], maxAttempts: 6,
    })];
    expect(got.map(ord)).toEqual([1, 3, 4, 5].map((k) => ord(anchor) + k));
  });
});
