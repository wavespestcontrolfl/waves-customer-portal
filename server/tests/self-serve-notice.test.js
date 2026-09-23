/**
 * server/services/scheduling/self-serve-notice.js — the self-serve notice
 * window (owner ruling 2026-09-23) that replaces the old "max 3
 * self-bookings per calendar day" cap: through a self-serve surface, a
 * customer can't book or move a visit starting within
 * SELF_SERVE_NOTICE_HOURS (default 24h) of now.
 */
const {
  DEFAULT_NOTICE_HOURS,
  selfServeNoticeMinutes,
  earliestSelfServeStart,
  violatesSelfServeNotice,
  visitInsideNoticeWindow,
} = require('../services/scheduling/self-serve-notice');

describe('selfServeNoticeMinutes', () => {
  const saved = process.env.SELF_SERVE_NOTICE_HOURS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SELF_SERVE_NOTICE_HOURS;
    else process.env.SELF_SERVE_NOTICE_HOURS = saved;
  });

  test('defaults to 24 hours (1440 minutes) when unset', () => {
    delete process.env.SELF_SERVE_NOTICE_HOURS;
    expect(DEFAULT_NOTICE_HOURS).toBe(24);
    expect(selfServeNoticeMinutes()).toBe(24 * 60);
  });

  test('reads a custom SELF_SERVE_NOTICE_HOURS at call time', () => {
    process.env.SELF_SERVE_NOTICE_HOURS = '6';
    expect(selfServeNoticeMinutes()).toBe(6 * 60);
  });

  test('falls back to the default on garbage or negative input', () => {
    process.env.SELF_SERVE_NOTICE_HOURS = 'not-a-number';
    expect(selfServeNoticeMinutes()).toBe(24 * 60);
    process.env.SELF_SERVE_NOTICE_HOURS = '-3';
    expect(selfServeNoticeMinutes()).toBe(24 * 60);
  });

  test('0 is honored (no notice) — distinct from unset/garbage', () => {
    process.env.SELF_SERVE_NOTICE_HOURS = '0';
    expect(selfServeNoticeMinutes()).toBe(0);
  });
});

describe('earliestSelfServeStart', () => {
  test('is now + the notice minutes', () => {
    const now = new Date('2027-06-01T12:00:00Z');
    expect(earliestSelfServeStart(now).getTime()).toBe(now.getTime() + 24 * 60 * 60000);
  });
});

describe('violatesSelfServeNotice — boundary cases', () => {
  // 2027-06-01T12:00:00Z = 08:00 EDT.
  const now = new Date('2027-06-01T12:00:00Z');

  test('23h59 out is blocked', () => {
    // Boundary is 2027-06-02 08:00 ET; one minute short of it.
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '07:59' }, now)).toBe(true);
  });

  test('exactly 24h out is allowed (inclusive boundary — the generator offers starts AT it)', () => {
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '08:00' }, now)).toBe(false);
  });

  test('24h01 out is allowed', () => {
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '08:01' }, now)).toBe(false);
  });

  test('today is always blocked (any same-day start is under 24h notice)', () => {
    expect(violatesSelfServeNotice({ date: '2027-06-01', startTime: '23:00' }, now)).toBe(true);
  });

  test('a date well beyond the notice window is unrestricted', () => {
    expect(violatesSelfServeNotice({ date: '2027-06-10', startTime: '00:00' }, now)).toBe(false);
  });

  test('a past date is blocked', () => {
    expect(violatesSelfServeNotice({ date: '2027-05-31', startTime: '08:00' }, now)).toBe(true);
  });

  test('fails closed on missing or unparsable input', () => {
    expect(violatesSelfServeNotice({ date: null, startTime: '08:00' }, now)).toBe(true);
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: null }, now)).toBe(true);
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: 'garbage' }, now)).toBe(true);
    expect(violatesSelfServeNotice({ date: 'not-a-date', startTime: '08:00' }, now)).toBe(true);
  });

  test('accepts an HH:MM:SS window_start (trims the seconds)', () => {
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '08:00:00' }, now)).toBe(false);
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '07:59:59' }, now)).toBe(true);
  });

  test('a custom SELF_SERVE_NOTICE_HOURS changes the boundary', () => {
    const saved = process.env.SELF_SERVE_NOTICE_HOURS;
    process.env.SELF_SERVE_NOTICE_HOURS = '2';
    try {
      // Same-day 2h+1min out clears a 2-hour notice.
      expect(violatesSelfServeNotice({ date: '2027-06-01', startTime: '10:01' }, now)).toBe(false);
      expect(violatesSelfServeNotice({ date: '2027-06-01', startTime: '09:59' }, now)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SELF_SERVE_NOTICE_HOURS;
      else process.env.SELF_SERVE_NOTICE_HOURS = saved;
    }
  });
});

describe('violatesSelfServeNotice — ET midnight / DST safety', () => {
  test('near-midnight ET: the notice window correctly spans into tomorrow', () => {
    // 2027-06-01T03:30:00Z = 2027-05-31 23:30 EDT.
    const now = new Date('2027-06-01T03:30:00Z');
    // The boundary is 2027-06-01 23:30 ET — a same-day-tomorrow slot at
    // 23:00 is still 30 minutes short of it.
    expect(violatesSelfServeNotice({ date: '2027-06-01', startTime: '23:00' }, now)).toBe(true);
    expect(violatesSelfServeNotice({ date: '2027-06-01', startTime: '23:30' }, now)).toBe(false);
    // Two calendar days out (2027-06-02) is unrestricted regardless of time.
    expect(violatesSelfServeNotice({ date: '2027-06-02', startTime: '00:00' }, now)).toBe(false);
  });

  test('spring-forward (2026-03-08, a 23-real-hour ET day): the boundary lands an hour later on the clock', () => {
    const now = new Date('2026-03-07T15:00:00Z'); // 10:00 EST (UTC-5)
    // A naive "same wall-clock time tomorrow" (10:00 EDT) is only 23 REAL
    // hours away on the spring-forward day — still inside the 24h window.
    expect(violatesSelfServeNotice({ date: '2026-03-08', startTime: '10:00' }, now)).toBe(true);
    // The true 24-real-hour boundary is an hour later on the clock (EDT).
    expect(violatesSelfServeNotice({ date: '2026-03-08', startTime: '11:00' }, now)).toBe(false);
  });

  test('fall-back (2026-11-01, a 25-real-hour ET day): the boundary lands an hour earlier on the clock', () => {
    const now = new Date('2026-10-31T14:00:00Z'); // 10:00 EDT (UTC-4)
    // The fall-back day is 25 real hours long, so 24 real hours after 10:00
    // EDT lands at 09:00 EST — an hour EARLIER than the naive guess.
    expect(violatesSelfServeNotice({ date: '2026-11-01', startTime: '08:00' }, now)).toBe(true);
    expect(violatesSelfServeNotice({ date: '2026-11-01', startTime: '09:00' }, now)).toBe(false);
  });
});

describe('visitInsideNoticeWindow — existing scheduled_services rows', () => {
  const now = new Date('2027-06-01T12:00:00Z'); // 08:00 EDT

  test('a row whose scheduled_date + window_start starts within the window is inside it', () => {
    expect(visitInsideNoticeWindow({ scheduled_date: '2027-06-01', window_start: '20:00' }, now)).toBe(true);
  });

  test('a row outside the window is not inside it', () => {
    expect(visitInsideNoticeWindow({ scheduled_date: '2027-06-10', window_start: '09:00' }, now)).toBe(false);
  });

  test('a UTC-midnight Date scheduled_date (pg DATE column convention) reads its ET calendar day literally', () => {
    // See etCalendarDayOf: a UTC-midnight Date must not shift a day earlier
    // through the ET wall clock.
    const scheduledDate = new Date('2027-06-01T00:00:00.000Z');
    expect(visitInsideNoticeWindow({ scheduled_date: scheduledDate, window_start: '20:00' }, now)).toBe(true);
    expect(visitInsideNoticeWindow({ scheduled_date: scheduledDate, window_start: '07:00' }, now)).toBe(true);
  });

  test('a null row fails closed', () => {
    expect(visitInsideNoticeWindow(null, now)).toBe(true);
  });
});
