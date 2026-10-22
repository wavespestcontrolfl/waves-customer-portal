/**
 * Holiday closures (owner 2026-10-22): a third layer in the shared
 * blackout-dates readers, next to one-off dates and weekly days off, so every
 * consumer (find-time, the booking re-checks, the seeder, the converter's
 * first-visit fallback, auto-dispatch's closed-day conflict) inherits it with
 * no call-site change. Every holiday is open until the owner closes it.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const blackout = require('../services/scheduling/blackout-dates');
const { clearOfBlackout, isBlackedOut } = require('../services/scheduling/blackout-nudge');
const { isClosedHoliday } = require('../services/scheduling/holidays');

// One mock table per read; system_settings answers by key.
function mockTables({ weekly = '[0,6]', holidays, oneOff = [], holidayReadFails = false } = {}) {
  const settings = { schedule_weekly_days_off: weekly, schedule_holiday_closures: holidays };
  const conn = jest.fn((table) => {
    if (table === 'system_settings') {
      return {
        where: (_col, key) => ({
          first: async () => {
            if (key === 'schedule_holiday_closures' && holidayReadFails) throw new Error('db down');
            return settings[key] === undefined ? null : { value: settings[key] };
          },
        }),
      };
    }
    if (table === 'schedule_blackout_dates') {
      return {
        whereBetween: () => ({ select: async () => oneOff.map((date) => ({ date })) }),
        where: (_col, date) => ({ first: async () => (oneOff.includes(date) ? { id: 'row' } : null) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  conn.transaction = async (fn) => fn(conn);
  return conn;
}

beforeEach(() => db.mockReset());

describe('every holiday is open until the owner closes it', () => {
  test('no stored list: no holiday is closed', async () => {
    const conn = mockTables();
    expect((await blackout.getClosedHolidays(conn)).size).toBe(0);
    expect(await blackout.isBlackoutDate('2026-11-26', conn)).toBe(false); // Thanksgiving, a Thursday
    const dates = await blackout.getBlackoutDates('2026-11-23', '2026-11-27', conn);
    expect([...dates]).toEqual([]);
  });

  test('an empty list closes nothing either', async () => {
    const conn = mockTables({ holidays: '[]' });
    expect(await blackout.isBlackoutDate('2026-12-25', conn)).toBe(false);
  });
});

describe('a closed holiday is a closed day', () => {
  const conn = () => mockTables({ holidays: '["thanksgiving","black_friday","independence_day"]' });

  test('isBlackoutDate: the holiday and only the holiday', async () => {
    expect(await blackout.isBlackoutDate('2026-11-26', conn())).toBe(true);
    expect(await blackout.isBlackoutDate('2026-11-27', conn())).toBe(true);
    expect(await blackout.isBlackoutDate('2026-11-25', conn())).toBe(false);
    expect(await blackout.isBlackoutDate('2026-12-25', conn())).toBe(false); // Christmas stays open
    expect(await blackout.isBlackoutDate(new Date('2026-11-26T12:00:00Z'), conn())).toBe(true); // a Date value
  });

  test('the observed weekday of a weekend holiday closes too', async () => {
    expect(await blackout.isBlackoutDate('2027-07-05', conn())).toBe(true); // July 4 2027 is a Sunday
    expect(await blackout.isBlackoutDate('2026-07-03', conn())).toBe(true); // July 4 2026 is a Saturday
  });

  test('getBlackoutDates adds the closed days to the weekly and one-off layers', async () => {
    const dates = await blackout.getBlackoutDates('2026-11-23', '2026-11-30',
      mockTables({ holidays: '["thanksgiving","black_friday"]', oneOff: ['2026-11-24'] }));
    expect([...dates].sort()).toEqual(['2026-11-24', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
  });

  test('getBlackoutLayers carries the closed keys for dates past the horizon', async () => {
    const layers = await blackout.getBlackoutLayers('2026-11-01', '2026-11-30', conn());
    expect([...layers.closedHolidays].sort()).toEqual(['black_friday', 'independence_day', 'thanksgiving']);
    expect(layers.dates.has('2026-11-26')).toBe(true);
    expect(layers.dates.has('2026-11-27')).toBe(true);
    expect(layers.dates.has('2030-11-28')).toBe(false); // outside the expanded range...
    expect(isBlackedOut('2030-11-28', layers)).toBe(true); // ...still closed through the key layer
  });

  test('the nudge moves a series visit off a closed holiday and the weekend after it', () => {
    const layers = { dates: new Set(), weeklyDaysOff: new Set([0, 6]), closedHolidays: new Set(['thanksgiving', 'black_friday']) };
    expect(clearOfBlackout('2026-11-26', layers, { skipWeekends: true })).toBe('2026-11-30');
    expect(clearOfBlackout('2026-11-25', layers)).toBe('2026-11-25');
    expect(isBlackedOut('2026-11-26', { dates: new Set(), weeklyDaysOff: new Set() })).toBe(false); // no key layer
    expect(isBlackedOut('2026-11-26', new Set())).toBe(false); // the seeder's plain Set shape
  });

  test('expandHolidayClosures and isClosedHoliday are pure', () => {
    expect(blackout.expandHolidayClosures('2026-12-20', '2027-01-05', new Set(['christmas', 'new_years_day'])))
      .toEqual(['2026-12-25', '2027-01-01']);
    expect(blackout.expandHolidayClosures('2026-12-20', '2027-01-05', new Set())).toEqual([]);
    expect(isClosedHoliday('2026-12-25', new Set(['christmas']))).toBe(true);
    expect(isClosedHoliday('2026-12-25', new Set(['christmas_eve']))).toBe(false);
    expect(isClosedHoliday('2026-12-25', null)).toBe(false);
  });
});

describe('a holiday read failure', () => {
  test('fails open by default', async () => {
    const conn = mockTables({ holidays: '["thanksgiving"]', holidayReadFails: true });
    expect((await blackout.getClosedHolidays(conn)).size).toBe(0);
    expect(await blackout.isBlackoutDate('2026-11-26', conn)).toBe(false);
  });

  test('throws when strict (the nightly auto-dispatch path)', async () => {
    const conn = mockTables({ holidays: '["thanksgiving"]', holidayReadFails: true });
    await expect(blackout.getClosedHolidays(conn, { strict: true })).rejects.toThrow('db down');
    await expect(blackout.isBlackoutDate('2026-11-26', conn, { strict: true })).rejects.toThrow('db down');
    await expect(blackout.getBlackoutDates('2026-11-23', '2026-11-27', conn, { strict: true })).rejects.toThrow('db down');
  });

  test('getBlackoutLayers rejects, so its callers take their own fail-open path', async () => {
    const conn = mockTables({ holidays: '["thanksgiving"]', holidayReadFails: true });
    await expect(blackout.getBlackoutLayers('2026-11-01', '2026-11-30', conn)).rejects.toThrow('db down');
  });
});
