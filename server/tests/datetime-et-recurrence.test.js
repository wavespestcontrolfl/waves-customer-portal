const {
  parseETDateTime, etDateString, etParts, addETDaysAtWallClock,
  addETMonthsByWeekday, etNthWeekdayOfMonth,
} = require('../utils/datetime-et');

describe('parseETDateTime across the DST seams', () => {
  const wall = (d) => { const p = etParts(d); return `${etDateString(d)}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
  test('the fall-back Sunday: 02:30 ET exists once (EST) and resolves to it — not to 01:30 with the pre-transition offset', () => {
    expect(parseETDateTime('2026-11-01T02:30').toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(wall(parseETDateTime('2026-11-01T02:30'))).toBe('2026-11-01T02:30');
    // 01:30 that day exists twice — the FIRST occurrence (EDT) as before
    expect(parseETDateTime('2026-11-01T01:30').toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // an ordinary EST time after the seam, and an EDT time before it
    expect(parseETDateTime('2026-11-01T09:00').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(parseETDateTime('2026-10-31T09:00').toISOString()).toBe('2026-10-31T13:00:00.000Z');
  });
  test('the spring-forward gap: 02:30 ET does not exist — the first candidate (03:30 EDT) stands, as before', () => {
    expect(parseETDateTime('2026-03-08T02:30').toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(parseETDateTime('2026-03-08T03:30').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  test('addETDaysAtWallClock keeps the wall clock onto the fall-back Sunday: 10-22 02:30 + 10 days = 11-01 02:30 ET, 25 elapsed hours on the seam day', () => {
    const due = addETDaysAtWallClock(parseETDateTime('2026-10-22T02:30'), 10);
    expect(wall(due)).toBe('2026-11-01T02:30');
    expect(due.toISOString()).toBe('2026-11-01T07:30:00.000Z');
    // the 45-day closure window across the same seam is not an hour short either
    const closes = addETDaysAtWallClock(parseETDateTime('2026-09-17T02:30'), 45);
    expect(wall(closes)).toBe('2026-11-01T02:30');
  });
});

describe('ET calendar-month recurrence helpers', () => {
  test('quarterly cadence preserves ordinal weekday instead of fixed day gaps', () => {
    const base = parseETDateTime('2026-05-04T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 3))).toBe('2026-08-03');
    expect(etDateString(addETMonthsByWeekday(base, 6))).toBe('2026-11-02');
    expect(etDateString(addETMonthsByWeekday(base, 9))).toBe('2027-02-01');
  });

  test('monthly and bimonthly cadences preserve ordinal weekday', () => {
    const base = parseETDateTime('2026-05-04T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 1))).toBe('2026-06-01');
    expect(etDateString(addETMonthsByWeekday(base, 2))).toBe('2026-07-06');
    expect(etDateString(addETMonthsByWeekday(base, 4))).toBe('2026-09-07');
  });

  test('fifth weekday falls back to the last matching weekday', () => {
    const base = parseETDateTime('2026-01-31T12:00');

    expect(etDateString(addETMonthsByWeekday(base, 1))).toBe('2026-02-28');
    expect(etDateString(addETMonthsByWeekday(base, 2))).toBe('2026-03-28');
    expect(etDateString(etNthWeekdayOfMonth(2026, 2, 5, 1))).toBe('2026-02-23');
  });

  test('explicit fifth weekday anchor does not drift after fallback months', () => {
    const fallbackMonth = parseETDateTime('2026-04-24T12:00');

    expect(etDateString(addETMonthsByWeekday(fallbackMonth, 1, { nth: 5, weekday: 5 }))).toBe('2026-05-29');
  });
});

describe('parseETDateTime on DST transition mornings', () => {
  const { parseETDateTime } = require('../utils/datetime-et');
  // The offset in force at the naive-as-UTC guess is the offset 4-5 h before
  // the wall clock asked for; on a transition morning that is the wrong one
  // (pre-push audit on #3869). 2026: spring-forward Sun 03-08, fall-back Sun 11-01.
  test.each([
    ['2026-03-09T04:30', '2026-03-09T08:30:00.000Z'], // day after spring-forward: 04:30 EDT, not 05:30
    ['2026-03-08T04:30', '2026-03-08T08:30:00.000Z'], // spring-forward day, after the jump
    ['2026-03-08T01:30', '2026-03-08T06:30:00.000Z'], // spring-forward day, before the jump (EST)
    ['2026-11-01T04:30', '2026-11-01T09:30:00.000Z'], // fall-back day, after the repeat: 04:30 EST, not 03:30
    ['2026-11-02T04:30', '2026-11-02T09:30:00.000Z'], // day after fall-back
    ['2026-11-01T00:30', '2026-11-01T04:30:00.000Z'], // fall-back day, before the repeat (EDT)
    ['2026-03-08T02:30', '2026-03-08T07:30:00.000Z'], // nonexistent (the gap): forward to 03:30 EDT, never 01:30 EST
    ['2026-03-08T02:00', '2026-03-08T07:00:00.000Z'], // the gap's first minute, same rule
    ['2026-07-04T12:00', '2026-07-04T16:00:00.000Z'], // plain summer
    ['2026-01-15T00:00', '2026-01-15T05:00:00.000Z'], // plain winter midnight
  ])('%s → %s', (naive, iso) => {
    expect(parseETDateTime(naive).toISOString()).toBe(iso);
  });
});
