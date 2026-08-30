/**
 * The THREE nextRecurringDate copies (seeder / rebooker / admin-schedule)
 * must agree on every supported cadence — the 2026-08-30 series-move incident:
 * the seeder knew every_6_weeks = 42 days, the other two fell through to
 * the generic 91-day gap, and an edit-modal collective move projected the
 * sibling to Dec 2 where the cadence says Oct 14. This parity sweep pins
 * every pattern across all three so a cadence added to one copy can never
 * silently miss the others again.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next() };
});

const seeder = require('../services/recurring-appointment-seeder')._internals.nextRecurringDate;
const rebooker = require('../services/rebooker').nextRecurringDate;
const adminSchedule = require('../routes/admin-schedule').nextRecurringDate;

const PATTERNS = [
  'daily', 'weekly', 'biweekly', 'every_6_weeks',
  'monthly', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'biannual', 'annual', 'yearly',
  'monthly_nth_weekday',
  'seasonal_feb_oct',
  'custom',
];
const BASES = ['2026-09-02', '2026-01-15', '2026-11-20'];
const OPTS = { intervalDays: 10, nth: 3, weekday: 4 };

describe('nextRecurringDate parity across the three copies', () => {
  for (const pattern of PATTERNS) {
    test(`${pattern}: seeder / rebooker / admin-schedule agree for i=0..4`, () => {
      for (const base of BASES) {
        for (let i = 0; i <= 4; i++) {
          const a = seeder(base, pattern, i, OPTS);
          const b = rebooker(base, pattern, i, OPTS);
          const c = adminSchedule(base, pattern, i, OPTS);
          expect({ pattern, base, i, rebooker: b }).toEqual({ pattern, base, i, rebooker: a });
          expect({ pattern, base, i, adminSchedule: c }).toEqual({ pattern, base, i, adminSchedule: a });
        }
      }
    });
  }

  test('the incident cadence: every_6_weeks from 2026-09-02 lands 2026-10-14, never the 91-day 2026-12-02', () => {
    expect(rebooker('2026-09-02', 'every_6_weeks', 1, {})).toBe('2026-10-14');
    expect(adminSchedule('2026-09-02', 'every_6_weeks', 1, {})).toBe('2026-10-14');
    expect(seeder('2026-09-02', 'every_6_weeks', 1, {})).toBe('2026-10-14');
  });

  test('an UNKNOWN pattern still falls back identically (91-day gap) in all three', () => {
    const a = seeder('2026-09-02', 'made_up_pattern', 1, {});
    expect(rebooker('2026-09-02', 'made_up_pattern', 1, {})).toBe(a);
    expect(adminSchedule('2026-09-02', 'made_up_pattern', 1, {})).toBe(a);
  });
});

describe('rescheduleReminderTime accepts pg raw time (series-move incident, twice)', () => {
  const { normalizeHHMM, rescheduleReminderTime } = require('../routes/admin-dispatch');
  test('normalizeHHMM: HH:MM, HH:MM:SS, and 1-digit hours normalize; junk is null', () => {
    expect(normalizeHHMM('13:00')).toBe('13:00');
    expect(normalizeHHMM('13:00:00')).toBe('13:00');
    expect(normalizeHHMM('9:05:30')).toBe('09:05');
    expect(normalizeHHMM('')).toBe(null);
    expect(normalizeHHMM('noon')).toBe(null);
  });
  test('a sibling occurrence windowStart of 13:00:00 arms the reminder at 13:00, not the 08:00 fallback', () => {
    expect(rescheduleReminderTime('2026-10-14', { start: '13:00:00' })).toBe('2026-10-14T13:00');
    expect(rescheduleReminderTime('2026-10-14', { start: null })).toBe('2026-10-14T08:00');
  });
});
