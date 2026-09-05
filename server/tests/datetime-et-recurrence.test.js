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
