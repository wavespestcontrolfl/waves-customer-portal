const {
  LAWN_ROUNDS_9, LAWN_ROUND_TABLE, roundOf, lawnRoundDate,
} = require('../services/lawn-rounds');
const Seeder = require('../services/recurring-appointment-seeder');

const dayNum = (s) => Math.floor(Date.parse(`${s}T12:00:00Z`) / 86400000);
const weekday = (s) => new Date(`${s}T12:00:00Z`).getUTCDay();
const ordinal = (s) => { const r = roundOf(s); return r.programYear * 9 + (r.round - 1); };

function* dates(from, to) {
  for (let d = dayNum(from); d <= dayNum(to); d++) yield new Date(d * 86400000).toISOString().slice(0, 10);
}

describe('lawn rounds calendar', () => {
  test('pattern constant fits the pattern column and the table has nine rounds', () => {
    expect(LAWN_ROUNDS_9).toBe('lawn_rounds_9');
    expect(LAWN_ROUNDS_9.length).toBeLessThanOrEqual(20);
    expect(LAWN_ROUND_TABLE).toHaveLength(9);
  });

  test('round lengths: 1-8 are 40 days, round 9 is 45 (non-leap); Feb 29 lengthens round 2', () => {
    for (let r = 1; r <= 8; r++) {
      const probe = ['2027-01-10', '2027-02-10', '2027-03-20', '2027-05-01', '2027-06-10', '2027-07-20', '2027-08-25', '2027-10-05'][r - 1];
      expect(roundOf(probe)).toMatchObject({ round: r, length: 40 });
    }
    expect(roundOf('2027-11-20')).toMatchObject({ round: 9, length: 45 });
    expect(roundOf('2028-02-10')).toMatchObject({ round: 2, length: 41 });
  });

  test.each([
    ['2026-12-24', 2026, 9, '2026-11-10', '2026-12-24'],
    ['2026-12-25', 2027, 1, '2026-12-25', '2027-02-02'],
    ['2027-02-02', 2027, 1, '2026-12-25', '2027-02-02'],
    ['2027-02-03', 2027, 2, '2027-02-03', '2027-03-14'],
    ['2027-03-14', 2027, 2, '2027-02-03', '2027-03-14'],
    ['2027-03-15', 2027, 3, '2027-03-15', '2027-04-23'],
    ['2027-04-24', 2027, 4, '2027-04-24', '2027-06-02'],
    ['2027-06-03', 2027, 5, '2027-06-03', '2027-07-12'],
    ['2027-07-13', 2027, 6, '2027-07-13', '2027-08-21'],
    ['2027-08-22', 2027, 7, '2027-08-22', '2027-09-30'],
    ['2027-09-30', 2027, 7, '2027-08-22', '2027-09-30'],
    ['2027-10-01', 2027, 8, '2027-10-01', '2027-11-09'],
    ['2027-11-09', 2027, 8, '2027-10-01', '2027-11-09'],
    ['2027-11-10', 2027, 9, '2027-11-10', '2027-12-24'],
  ])('roundOf %s', (date, programYear, round, start, end) => {
    expect(roundOf(date)).toMatchObject({ programYear, round, start, end });
  });

  test('roundOf returns null for junk', () => {
    expect(roundOf('nope')).toBeNull();
    expect(roundOf(null)).toBeNull();
  });

  test('i = 0 returns the anchor, even on a weekend', () => {
    expect(lawnRoundDate('2027-03-17', 0)).toBe('2027-03-17');
    expect(lawnRoundDate('2027-03-20', 0)).toBe('2027-03-20');
  });

  test('year wrap: round 9 to round 1 and on', () => {
    // Wed Nov 10 2027 = round 9 offset 0. Round 1 of PY2028 starts Dec 25 (Sat) -> nearest Wed is Dec 22? must stay in round 1.
    const next = lawnRoundDate('2027-11-10', 1);
    expect(roundOf(next)).toMatchObject({ programYear: 2028, round: 1 });
    expect(weekday(next)).toBe(weekday('2027-11-10'));
    expect(next).toBe('2027-12-29');
    expect(roundOf(lawnRoundDate('2027-11-10', 2))).toMatchObject({ programYear: 2028, round: 2 });
    expect(roundOf(lawnRoundDate('2027-11-10', 10))).toMatchObject({ programYear: 2029, round: 1 });
  });

  test('late round 9 anchor (offset 44) lands on the last matching weekday of 40-day rounds', () => {
    // Fri Dec 24 2027 = round 9 offset 44. Round 1 (PY2028) ends Wed Feb 2 2028: last Friday inside is Jan 28.
    expect(lawnRoundDate('2027-12-24', 1)).toBe('2028-01-28');
    // Round 2 of PY2028 is 41 days (leap): Feb 3 + 40 = Mar 14 (Tue); nearest Friday Mar 17 > end, so Mar 10.
    expect(lawnRoundDate('2027-12-24', 2)).toBe('2028-03-10');
    expect(lawnRoundDate('2027-12-24', 3)).toBe('2028-04-21');
  });

  test('boundary anchors keep their own round and weekday', () => {
    for (const anchor of ['2027-12-24', '2027-12-27', '2028-02-02', '2028-02-03', '2027-09-30', '2027-10-01', '2027-11-09', '2027-11-10']) {
      for (let i = 1; i <= 9; i++) {
        const got = lawnRoundDate(anchor, i);
        expect(ordinal(got)).toBe(ordinal(anchor) + i);
        expect(weekday(got)).toBe(weekday(anchor));
      }
    }
  });

  test('property: Mon-Fri anchors, every offset 0-44, program years 2027-2031', () => {
    const gaps = new Set();
    let anchors = 0;
    // Every round, every offset 0-44 (capped by the round end), each program year.
    for (let py = 2027; py <= 2031; py++) {
      for (let r = 1; r <= 9; r++) {
        const { start, end } = roundOf(
          r === 1 ? `${py - 1}-12-25` : `${py}-${['', '', '02-03', '03-15', '04-24', '06-03', '07-13', '08-22', '10-01', '11-10'][r]}`,
        );
        for (let d = dayNum(start); d <= dayNum(end) && d - dayNum(start) <= 44; d++) {
          const anchor = new Date(d * 86400000).toISOString().slice(0, 10);
          if (weekday(anchor) < 1 || weekday(anchor) > 5) continue;
          anchors++;
          let prev = anchor;
          const seenRounds = new Set([ordinal(anchor)]);
          for (let i = 1; i <= 18; i++) {
            const got = lawnRoundDate(anchor, i);
            const info = roundOf(got);
            expect(got >= info.start && got <= info.end).toBe(true);
            expect(ordinal(got)).toBe(ordinal(anchor) + i);
            expect(seenRounds.has(ordinal(got))).toBe(false);
            seenRounds.add(ordinal(got));
            expect(weekday(got)).toBe(weekday(anchor));
            if (info.round === 8) expect(got >= `${info.programYear}-10-01`).toBe(true);
            gaps.add(dayNum(got) - dayNum(prev));
            prev = got;
          }
        }
      }
    }
    expect(anchors).toBeGreaterThan(1000);
    expect([...gaps].sort((a, b) => a - b)).toEqual([35, 42, 49]);
  });

  test('every Mon-Fri date of one program year is a valid anchor for 18 rounds (all of 2027)', () => {
    for (const anchor of dates('2026-12-25', '2027-12-24')) {
      if (weekday(anchor) < 1 || weekday(anchor) > 5) continue;
      let prev = anchor;
      for (let i = 1; i <= 18; i++) {
        const got = lawnRoundDate(anchor, i);
        const gap = dayNum(got) - dayNum(prev);
        expect([35, 42, 49]).toContain(gap);
        prev = got;
      }
    }
  });
});

describe('seeder wiring for lawn_rounds_9', () => {
  const { nextRecurringDate } = Seeder._internals;

  test('exports the constant and the date function', () => {
    expect(Seeder.LAWN_ROUNDS_9).toBe('lawn_rounds_9');
    expect(Seeder.lawnRoundDate).toBe(lawnRoundDate);
  });

  test('normalizeRecurringPattern accepts explicit tokens only', () => {
    expect(Seeder.normalizeRecurringPattern('lawn_rounds_9')).toBe('lawn_rounds_9');
    expect(Seeder.normalizeRecurringPattern('Lawn Rounds 9')).toBe('lawn_rounds_9');
  });

  test('nextRecurringDate dispatches to lawnRoundDate', () => {
    for (const base of ['2027-03-17', '2027-12-24', '2027-11-10']) {
      for (let i = 0; i <= 9; i++) {
        expect(nextRecurringDate(base, 'lawn_rounds_9', i)).toBe(lawnRoundDate(base, i));
      }
    }
  });

  test('default count is 9; explicit counts still win', () => {
    expect(Seeder.plannedVisitCountForPattern('lawn_rounds_9')).toBe(9);
    expect(Seeder.plannedVisitCountForPattern('lawn_rounds_9', { plannedCount: 5 })).toBe(5);
  });

  test('scheduler places the pattern and it has no nominal day gap', () => {
    expect(Seeder.schedulerPlacesPattern('lawn_rounds_9')).toBe(true);
    expect(Seeder.intervalDaysForPattern('lawn_rounds_9')).toBeNull();
  });

  test('regression: 9-visit inference does not resolve to the new pattern', () => {
    expect(Seeder.patternFromVisitsPerYear(9)).toBe('bimonthly');
    expect(Seeder.inferRecurringPattern({ visitsPerYear: 9 })).toBe('bimonthly');
    expect(Seeder.inferRecurringPattern({ visitsPerYear: 9, service: { name: 'Lawn Care' } })).toBe('bimonthly');
    expect(Seeder.normalizeRecurringPattern('9')).toBe('bimonthly');
    expect(Seeder.normalizeRecurringPattern('9x')).toBe('every_6_weeks');
    expect(Seeder.inferRecurringPattern({ frequency: 'every_6_weeks', visitsPerYear: 9 })).toBe('every_6_weeks');
  });

  test('buildRecurringFollowUpRows seeds one visit per round, 8 follow-ups', () => {
    const rows = Seeder.buildRecurringFollowUpRows({
      id: 'parent-lawn9', customer_id: 'customer-1', scheduled_date: '2027-03-17',
      window_start: '09:00:00', window_end: '10:00:00', service_type: 'Lawn Care', status: 'confirmed',
    }, { pattern: 'lawn_rounds_9', plannedCount: 9, skipWeekends: true });
    expect(rows.map((r) => r.scheduled_date)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((i) => lawnRoundDate('2027-03-17', i)));
    expect(new Set(rows.map((r) => ordinal(r.scheduled_date))).size).toBe(8);
  });

  test('clampDateToRound: no-op elsewhere, pulls a drifted date back into its round', () => {
    const { clampDateToRound } = Seeder;
    expect(clampDateToRound('monthly', '2027-03-20', { intendedDate: '2027-03-14' })).toBe('2027-03-20');
    expect(clampDateToRound('lawn_rounds_9', '2027-03-20')).toBe('2027-03-20');
    // Round 2 ends Sun Mar 14: a forward weekend shift to Mon Mar 15 leaves the round.
    expect(clampDateToRound('lawn_rounds_9', '2027-03-15', { skipWeekends: true, intendedDate: '2027-03-14' })).toBe('2027-03-12');
    // Round 3 starts Mon Mar 15: a backward shift off Sun Mar 14... walk forward is blocked by skipWeekends, goes to Mon Mar 15? it is in round 3.
    expect(clampDateToRound('lawn_rounds_9', '2027-03-12', { skipWeekends: true, intendedDate: '2027-03-15' })).toBe('2027-03-15');
    expect(clampDateToRound('lawn_rounds_9', '2027-03-14', { skipWeekends: true, intendedDate: '2027-03-14' })).toBe('2027-03-14');
    // Blackout eats the rest of the round -> null
    const blackout = new Set([...dates('2027-02-03', '2027-03-14')]);
    expect(clampDateToRound('lawn_rounds_9', '2027-03-15', { blackoutDates: blackout, intendedDate: '2027-03-14' })).toBeNull();
  });

  test('weekend anchor with skipWeekends never leaves its round', () => {
    // Sat anchors: raw dates are Saturdays; the forward shift to Monday can cross a round edge.
    for (const anchor of ['2027-02-06', '2027-03-13', '2027-04-23', '2027-06-12']) {
      const rows = Seeder.buildRecurringFollowUpRows({
        id: 'p', customer_id: 'c', scheduled_date: anchor, window_start: '09:00:00', window_end: '10:00:00',
        service_type: 'Lawn Care', status: 'confirmed',
      }, { pattern: 'lawn_rounds_9', plannedCount: 9, skipWeekends: true });
      rows.forEach((row, idx) => {
        expect(ordinal(row.scheduled_date)).toBe(ordinal(anchor) + idx + 1);
        expect([0, 6]).not.toContain(weekday(row.scheduled_date));
      });
    }
  });
});
